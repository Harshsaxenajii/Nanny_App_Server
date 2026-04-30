import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { bus, Events } from "../utils/eventBus";
import { paginate, paginatedResult } from "../utils/response";
import { AttendanceStatus, BookingStatus, NannyStatus } from "@prisma/client";

const log = createLogger("booking");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS  (keep in sync with frontend)
// ─────────────────────────────────────────────────────────────────────────────
const LATE_THRESHOLD_MINUTES = 15;
const HALF_DAY_THRESHOLD_PCT = 0.5;
const DAILY_RATE_HOURS = 9;
const EMERGENCY_SURCHARGE_PER_HR = 100;
const PLATFORM_FEE_PCT = 0.05;
const GST_PCT = 0.05;
const MONTHLY_WORKING_DAYS = 20;
const MAX_SESSION_HOURS = 36;

const RANGE_TYPES = ["FULL_TIME", "PART_TIME", "MONTHLY_SUBSCRIPTION"] as const;
const SINGLE_DAY_TYPES = ["ONE_TIME", "OVERNIGHT", "EMERGENCY"] as const;

const COUPON_CATALOGUE: Record<
  string,
  { discountPct: number; description: string }
> = {
  FIRSTCARE: { discountPct: 0.2, description: "20% off your first booking" },
  MOM20: { discountPct: 0.2, description: "20% off for MOM members" },
  NANNY10: { discountPct: 0.1, description: "10% off any booking" },
};

const CANCELLED_STATUSES = [
  BookingStatus.CANCELLED_BY_USER,
  BookingStatus.CANCELLED_BY_NANNY,
  BookingStatus.CANCELLED_BY_ADMIN,
  BookingStatus.COMPLETED,
];

// ─────────────────────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
type TimelineEntry = { status: string; at: string; note?: string };

function appendTimeline(
  existing: any,
  status: string,
  note?: string,
): TimelineEntry[] {
  const list: TimelineEntry[] = Array.isArray(existing) ? existing : [];
  list.push({
    status,
    at: new Date().toISOString(),
    ...(note ? { note } : {}),
  });
  return list;
}

/** Cross-midnight-safe session length in hours. */
function calcSessionHours(startTime: Date, endTime: Date): number {
  let diff = (endTime.getTime() - startTime.getTime()) / 3_600_000;
  if (diff <= 0) diff += 24;
  return diff;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns today's AttendanceRecord for this booking + nanny, or null. */
async function getTodayAttendance(bookingId: string, nannyId: string) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  return prisma.attendanceRecord.findFirst({
    where: {
      bookingId,
      nannyId,
      scheduledDate: { gte: today, lt: tomorrow },
    },
  });
}

/**
 * Pre-creates PENDING attendance rows for every working day in the booking.
 * Called after payment is captured (CONFIRMED → NANNY_ASSIGNED).
 * Safe to call multiple times — upserts by (bookingId, scheduledDate) unique key.
 */
async function seedAttendanceRecords(
  bookingId: string,
): Promise<{ seeded: number }> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking || !booking.nannyId) return { seeded: 0 };

  const isRange = RANGE_TYPES.includes(booking.serviceType as any);

  if (!isRange) {
    const date = new Date(booking.scheduledStartTime);
    date.setUTCHours(0, 0, 0, 0);

    await prisma.attendanceRecord.upsert({
      where: { bookingId_scheduledDate: { bookingId, scheduledDate: date } },
      create: {
        bookingId,
        nannyId: booking.nannyId,
        userId: booking.userId,
        scheduledDate: date,
        status: AttendanceStatus.PENDING,
      },
      update: {},
    });
    return { seeded: 1 };
  }

  const DAY_MAP: Record<string, number> = {
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
    SUN: 0,
  };

  const workingDayNames: string[] = (booking as any).workingDays ?? [];
  const activeDayNums = new Set(
    workingDayNames.map((d) => DAY_MAP[d.toUpperCase().trim()] ?? -1),
  );

  const startStr = booking.scheduledStartTime.toISOString().split("T")[0];
  const endStr = booking.scheduledEndTime.toISOString().split("T")[0];
  const cur = new Date(`${startStr}T12:00:00.000Z`);
  const ceil = new Date(`${endStr}T23:59:59.999Z`);

  const dates: Date[] = [];
  while (cur <= ceil) {
    if (activeDayNums.size === 0 || activeDayNums.has(cur.getUTCDay())) {
      const d = new Date(cur);
      d.setUTCHours(0, 0, 0, 0);
      dates.push(d);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  await Promise.all(
    dates.map((scheduledDate) =>
      prisma.attendanceRecord.upsert({
        where: { bookingId_scheduledDate: { bookingId, scheduledDate } },
        create: {
          bookingId,
          nannyId: booking.nannyId!,
          userId: booking.userId,
          scheduledDate,
          status: AttendanceStatus.PENDING,
        },
        update: {},
      }),
    ),
  );

  log.info(`[seedAttendance] bookingId=${bookingId} seeded=${dates.length}`);
  return { seeded: dates.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICING ENGINE
// ─────────────────────────────────────────────────────────────────────────────
interface PricingInput {
  serviceType: string;
  hourlyRate: number;
  dailyRate: number | null;
  startTime: Date;
  endTime: Date;
  workingDays?: number;
  couponCode?: string;
  goalsFee?: number;
}
interface PricingOutput {
  sessionHours: number;
  workingDays: number;
  baseFee: number;
  emergencySurcharge: number;
  couponCode: string | null;
  discount: number;
  discountedBase: number;
  platformFee: number;
  gst: number;
  goalsFee: number;
  total: number;
  description: string;
}

export function calcPricingV2(input: PricingInput): PricingOutput {
  const {
    serviceType,
    hourlyRate,
    dailyRate,
    startTime,
    endTime,
    workingDays: inputDays,
    couponCode,
    goalsFee = 0,
  } = input;

  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime()))
    throw new AppError(
      "Invalid startTime or endTime passed to pricing engine",
      500,
    );

  const sessionHours = calcSessionHours(startTime, endTime);
  const isRange = RANGE_TYPES.includes(serviceType as any);
  const workingDays = isRange ? (inputDays ?? MONTHLY_WORKING_DAYS) : 1;

  let baseFee = 0;
  let emergencySurcharge = 0;
  let description = "";

  if (serviceType === "ONE_TIME" || serviceType === "OVERNIGHT") {
    baseFee = sessionHours * hourlyRate;
    description = `${sessionHours.toFixed(1)} hrs × ₹${hourlyRate}/hr`;
  } else if (serviceType === "EMERGENCY") {
    emergencySurcharge = sessionHours * EMERGENCY_SURCHARGE_PER_HR;
    baseFee = sessionHours * hourlyRate + emergencySurcharge;
    description = `${sessionHours.toFixed(1)} hrs × ₹${hourlyRate}/hr + ₹${EMERGENCY_SURCHARGE_PER_HR}/hr emergency surcharge`;
  } else if (isRange) {
    const effectiveDailyRate =
      dailyRate && dailyRate > 0 ? dailyRate : hourlyRate * DAILY_RATE_HOURS;
    if (sessionHours <= DAILY_RATE_HOURS) {
      baseFee = effectiveDailyRate * workingDays;
      description = `₹${effectiveDailyRate}/day × ${workingDays} days`;
    } else {
      const overtimeHrs = sessionHours - DAILY_RATE_HOURS;
      const dailyCost = effectiveDailyRate + overtimeHrs * hourlyRate;
      baseFee = dailyCost * workingDays;
      description = `(₹${effectiveDailyRate}/day + ${overtimeHrs.toFixed(1)} OT hrs × ₹${hourlyRate}/hr) × ${workingDays} days`;
    }
  } else {
    baseFee = sessionHours * hourlyRate;
    description = `${sessionHours.toFixed(1)} hrs × ₹${hourlyRate}/hr`;
  }

  let discount = 0;
  let appliedCode: string | null = null;
  if (couponCode) {
    const key = couponCode.toUpperCase().trim();
    const coupon = COUPON_CATALOGUE[key];
    if (coupon) {
      discount = Math.round(baseFee * coupon.discountPct);
      appliedCode = key;
    }
  }

  const discountedBase = baseFee - discount;
  const platformFee = Math.round(discountedBase * PLATFORM_FEE_PCT);
  const gst = Math.round(discountedBase * GST_PCT);
  const total = discountedBase + platformFee + gst + goalsFee;

  log.info(
    `[calcPricingV2] ${serviceType} | sessionHours=${sessionHours.toFixed(2)} | workingDays=${workingDays}` +
      ` | baseFee=₹${baseFee} | discount=₹${discount} | total=₹${total}`,
  );

  return {
    sessionHours,
    workingDays,
    baseFee,
    emergencySurcharge,
    couponCode: appliedCode,
    discount,
    discountedBase,
    platformFee,
    gst,
    goalsFee,
    total,
    description,
  };
}

export function validateCoupon(code: string): {
  valid: boolean;
  description?: string;
} {
  const key = code.toUpperCase().trim();
  const coupon = COUPON_CATALOGUE[key];
  return coupon
    ? { valid: true, description: coupon.description }
    : { valid: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING SERVICE
//
// STATUS LIFECYCLE (correct flow):
//
//   PENDING_PAYMENT   → booking created, awaiting nanny confirmation
//   CONFIRMED         → nanny accepted, awaiting user payment
//   NANNY_ASSIGNED    → payment received, ready to start
//   IN_PROGRESS       → nanny clocked in, service running
//   COMPLETED         → service finished
//
// ─────────────────────────────────────────────────────────────────────────────
export class BookingService {
  // ── POST /api/v1/bookings ────────────────────────────────────────────────
  // Creates booking as PENDING_PAYMENT (waiting for nanny to confirm).
  // Immediately emits BOOKING_CREATED so the nanny gets the FCM push.
  // No payment is involved at this point.
  async createBooking(userId: string, body: any) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("User not found", 404);

    const start = new Date(body.scheduledStartTime);
    const end = new Date(body.scheduledEndTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime()))
      throw new AppError("Invalid scheduledStartTime or scheduledEndTime", 400);

    const sessionMs = end.getTime() - start.getTime();
    const isRangeType = RANGE_TYPES.includes(body.serviceType);

    if (sessionMs <= 0)
      throw new AppError(
        "scheduledEndTime must be after scheduledStartTime. " +
          "For cross-midnight sessions the end time must be on the following calendar day.",
        400,
      );

    if (!isRangeType && sessionMs > MAX_SESSION_HOURS * 3_600_000)
      throw new AppError(
        `Session cannot exceed ${MAX_SESSION_HOURS} hours.`,
        400,
      );

    if (start <= new Date())
      throw new AppError("scheduledStartTime must be in the future", 400);

    const child = await prisma.children.findUnique({
      where: { id: body.childrenId },
    });
    if (!child) throw new AppError("Child not found", 404);
    if (child.userId !== userId)
      throw new AppError("This child does not belong to your account", 403);

    let nannyId: string | null = null;
    let nanny: any = null;

    if (body.nannyId) {
      nanny = await prisma.nanny.findUnique({ where: { id: body.nannyId } });
      if (!nanny) throw new AppError("The specified nanny was not found", 404);
      if (nanny.status !== NannyStatus.VERIFIED)
        throw new AppError("This nanny is not currently verified", 400);
      if (!nanny.isAvailable)
        throw new AppError("This nanny is currently not available", 400);
      if (!nanny.isActive)
        throw new AppError("This nanny account is not active", 400);
      if (!nanny.serviceTypes.includes(body.serviceType))
        throw new AppError(
          `This nanny does not offer ${body.serviceType}.`,
          400,
        );
      nannyId = nanny.id;
    }

    if (body.couponCode && !validateCoupon(body.couponCode).valid)
      throw new AppError("Invalid or expired coupon code", 400);

    const selectedGoals: any[] = Array.isArray(body.selectedGoals)
      ? body.selectedGoals
      : [];
    const goalsFee = selectedGoals.reduce(
      (sum: number, g: any) => sum + (Number(g.pricePerMonth) || 0),
      0,
    );

    let billingWorkingDays = MONTHLY_WORKING_DAYS;
    if (
      isRangeType &&
      Array.isArray(body.workingDays) &&
      body.workingDays.length > 0
    ) {
      const DAY_MAP: Record<string, number> = {
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
        SUN: 0,
      };
      const activeDayNums = new Set(
        body.workingDays.map(
          (d: string) => DAY_MAP[d.toUpperCase().trim()] ?? -1,
        ),
      );
      let count = 0;
      const startStr = start.toISOString().split("T")[0];
      const endStr = end.toISOString().split("T")[0];
      const cur = new Date(`${startStr}T12:00:00.000Z`);
      const ceil = new Date(`${endStr}T23:59:59.999Z`);
      while (cur <= ceil) {
        if (activeDayNums.has(cur.getUTCDay())) count++;
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      billingWorkingDays = count > 0 ? count : MONTHLY_WORKING_DAYS;
    }

    let shiftStart = start;
    let shiftEnd = end;
    if (isRangeType && body.dailyStartTime && body.dailyEndTime) {
      const dS = new Date(body.dailyStartTime);
      const dE = new Date(body.dailyEndTime);
      if (!isNaN(dS.getTime()) && !isNaN(dE.getTime())) {
        shiftStart = dS;
        shiftEnd = dE;
      }
    }

    if (!nanny?.hourlyRate || nanny.hourlyRate <= 0)
      throw new AppError(
        "This nanny does not have a valid hourly rate configured.",
        400,
      );

    const pricing = calcPricingV2({
      serviceType: body.serviceType,
      hourlyRate: nanny.hourlyRate,
      dailyRate:
        nanny.dailyRate && nanny.dailyRate > 0 ? nanny.dailyRate : null,
      startTime: shiftStart,
      endTime: shiftEnd,
      workingDays: billingWorkingDays,
      couponCode: body.couponCode ?? undefined,
      goalsFee,
    });

    const addr = body.address;
    const coords = addr?.coordinates?.coordinates;

    const requestedTasks = Array.isArray(body.requestedTasks)
      ? body.requestedTasks.map((t: string) => ({
          task: t,
          isDone: false,
          doneAt: null,
        }))
      : [];

    const booking = await prisma.booking.create({
      data: {
        userId,
        nannyId,
        serviceType: body.serviceType,
        scheduledStartTime: start,
        scheduledEndTime: end,
        specialInstructions: body.specialInstructions ?? null,
        childrenId: body.childrenId,
        requestedTasks,
        addressLabel: addr?.label ?? null,
        addressLine1: addr?.addressLine1 ?? "",
        addressLine2: addr?.addressLine2 ?? null,
        addressCity: addr?.city ?? "",
        addressState: addr?.state ?? "",
        addressPincode: addr?.pincode ?? "",
        addressCountry: addr?.country ?? "IN",
        addressLat: coords ? coords[1] : null,
        addressLng: coords ? coords[0] : null,
        baseAmount: pricing.baseFee,
        gstAmount: pricing.gst,
        totalAmount: pricing.total,
        // PENDING_NANNY_CONFIRMATION = awaiting nanny confirmation (no payment yet)
        status: BookingStatus.PENDING_NANNY_CONFIRMATION,
        pricingDetails: {
          sessionHours: pricing.sessionHours,
          workingDays: pricing.workingDays,
          description: pricing.description,
          baseFee: pricing.baseFee,
          emergencySurcharge: pricing.emergencySurcharge,
          couponCode: pricing.couponCode,
          discount: pricing.discount,
          discountedBase: pricing.discountedBase,
          platformFee: pricing.platformFee,
          gst: pricing.gst,
          goalsFee: pricing.goalsFee,
          total: pricing.total,
        },
        timeline: appendTimeline(
          [],
          BookingStatus.PENDING_NANNY_CONFIRMATION,
          "Booking created — awaiting nanny confirmation",
        ) as any,
      },
      include: { children: true },
    });

    // Day-wise plan creation
    const taskStrings: string[] = Array.isArray(body.requestedTasks)
      ? body.requestedTasks
      : [];
    const planDates: Date[] = [];

    if (
      isRangeType &&
      Array.isArray(body.workingDays) &&
      body.workingDays.length > 0
    ) {
      const DAY_MAP: Record<string, number> = {
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
        SUN: 0,
      };
      const activeDayNums = new Set(
        body.workingDays.map(
          (d: string) => DAY_MAP[d.toUpperCase().trim()] ?? -1,
        ),
      );
      const startStr = start.toISOString().split("T")[0];
      const endStr = end.toISOString().split("T")[0];
      const cur = new Date(`${startStr}T12:00:00.000Z`);
      const ceil = new Date(`${endStr}T23:59:59.999Z`);
      while (cur <= ceil) {
        if (activeDayNums.has(cur.getUTCDay())) {
          const d = new Date(cur);
          d.setUTCHours(0, 0, 0, 0);
          planDates.push(d);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else {
      const d = new Date(start);
      d.setUTCHours(0, 0, 0, 0);
      planDates.push(d);
    }

    if (planDates.length > 0) {
      await Promise.all(
        planDates.map(async (planDate) => {
          const dayPlan = await prisma.requestedDayWiseDailyPlan.create({
            data: { bookingId: booking.id, date: planDate },
          });
          await prisma.requestedDailyPlan.create({
            data: {
              requestedDayWiseDailyPlanId: dayPlan.id,
              name: `Daily plan – ${planDate.toDateString()}`,
              status: "ACTIVE",
              additionalNotes: taskStrings as any,
            },
          });
        }),
      );
    }

    if (selectedGoals.length > 0) {
      await Promise.all(
        selectedGoals.map((g: any) =>
          prisma.childGoal.create({
            data: {
              childId: body.childrenId,
              bookingId: booking.id,
              name: g.name,
              category: g.category,
              priority: g.priority ?? "MEDIUM",
              parentDescription: g.parentDescription,
              milestones: Array.isArray(g.milestones) ? g.milestones : [],
              ...(g.timelineMonths ? { timelineMonths: g.timelineMonths } : {}),
            },
          }),
        ),
      );
    }

    // Emit immediately — events.ts handler sends FCM to nanny right now.
    // Nanny must confirm BEFORE user pays.
    bus.emit(Events.BOOKING_CREATED, { bookingId: booking.id, userId });
    log.info(
      `[createBooking] id=${booking.id} total=₹${pricing.total} — nanny FCM triggered`,
    );
    return { ...booking, pricing };
  }

  // ── PATCH /api/v1/bookings/:id/confirm ───────────────────────────────────
  // Nanny taps Accept on the BookingRequestOverlay or notification action.
  //
  // PENDING_PAYMENT → CONFIRMED
  // (CONFIRMED = nanny said yes, now waiting for the user to pay)
  //
  // After this, events.ts sends "Nanny confirmed" FCM to the user.
  // The user's app receives it and navigates to the payment screen.
  async confirmBooking(bookingId: string, nannyUserId: string) {
    const nanny = await prisma.nanny.findUnique({
      where: { userId: nannyUserId },
    });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    // Idempotent: already confirmed (awaiting payment), return early without re-emitting
    if (booking.status === BookingStatus.PENDING_PAYMENT) {
      log.info(
        `[confirmBooking] Already PENDING_PAYMENT, returning early. bookingId=${bookingId}`,
      );
      return booking;
    }

    if (booking.status !== BookingStatus.PENDING_NANNY_CONFIRMATION)
      throw new AppError(
        `Cannot confirm booking in status: ${booking.status}. Booking must be PENDING_NANNY_CONFIRMATION.`,
        400,
      );

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.PENDING_PAYMENT,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.PENDING_PAYMENT,
          "Nanny accepted — awaiting user payment",
        ) as any,
      },
    });

    // events.ts listener will send "Nanny confirmed, please pay" FCM to user
    bus.emit(Events.BOOKING_CONFIRMED, {
      bookingId,
      userId: booking.userId,
      nannyId: nanny.id,
    });

    log.info(
      `[confirmBooking] bookingId=${bookingId} nannyId=${nanny.id} → CONFIRMED`,
    );
    return updated;
  }

  // ── PATCH /api/v1/bookings/:id/reject ────────────────────────────────────
  // Nanny taps Reject on the BookingRequestOverlay or notification action.
  //
  // PENDING_PAYMENT → CANCELLED_BY_NANNY
  // nannyId cleared so admin can reassign.
  async rejectBooking(bookingId: string, nannyUserId: string, reason?: string) {
    const nanny = await prisma.nanny.findUnique({
      where: { userId: nannyUserId },
    });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    if (booking.status !== BookingStatus.PENDING_NANNY_CONFIRMATION)
      throw new AppError(
        `Cannot reject booking in status: ${booking.status}. Booking must be PENDING_NANNY_CONFIRMATION.`,
        400,
      );

    const cancellationReason = reason?.trim() || "Nanny declined the booking";

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CANCELLED_BY_NANNY,
        nannyId: null,
        cancellationReason,
        cancelledBy: nanny.userId,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.CANCELLED_BY_NANNY,
          cancellationReason,
        ) as any,
      },
    });

    // events.ts listener sends "nanny unavailable" FCM to user
    bus.emit(Events.BOOKING_CANCELLED, {
      bookingId,
      userId: booking.userId,
      reason: cancellationReason,
      status: BookingStatus.CANCELLED_BY_NANNY,
    });

    log.info(
      `[rejectBooking] bookingId=${bookingId} nannyId=${nanny.id} reason="${cancellationReason}"`,
    );
    return updated;
  }

  // ── Payment events ────────────────────────────────────────────────────────
  // handlePaymentCaptured: called by your payment webhook.
  //
  // CONFIRMED → NANNY_ASSIGNED
  // (CONFIRMED = nanny accepted, NANNY_ASSIGNED = money received, ready to start)
  async handlePaymentCaptured(bookingId: string, paymentId?: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    // Only process if booking is PENDING_PAYMENT (nanny accepted, payment was pending)
    if (!booking || booking.status !== BookingStatus.PENDING_PAYMENT) return;

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CONFIRMED,
        paymentId: paymentId ?? null,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.CONFIRMED,
          "Payment received — booking fully confirmed",
        ) as any,
      },
    });

    // Seed attendance rows now that both nanny and payment are confirmed
    try {
      const { seeded } = await seedAttendanceRecords(bookingId);
      log.info(
        `[handlePaymentCaptured] bookingId=${bookingId} attendanceRowsSeeded=${seeded}`,
      );
    } catch (e) {
      log.error(
        `[handlePaymentCaptured] attendance seed failed for bookingId=${bookingId}`,
        e,
      );
    }

    log.info(`[handlePaymentCaptured] bookingId=${bookingId} → CONFIRMED`);
  }

  async handlePaymentFailed(bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    // Only cancel if still waiting for payment (nanny confirmed but user hasn't paid)
    if (!booking || booking.status !== BookingStatus.PENDING_PAYMENT) return;

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CANCELLED_BY_USER,
        cancellationReason: "Payment failed or was declined",
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.CANCELLED_BY_USER,
          "Payment failed",
        ) as any,
      },
    });

    bus.emit(Events.PAYMENT_FAILED, { bookingId, userId: booking.userId });
  }

  // ── PATCH /api/v1/bookings/:id/accept ────────────────────────────────────
  // Legacy in-app accept (kept for compatibility).
  // The notification-driven flow uses confirmBooking() above instead.
  async acceptBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);
    if (booking.status !== BookingStatus.PENDING_PAYMENT)
      throw new AppError(
        `Cannot accept booking in status: ${booking.status}. Booking must be PENDING_PAYMENT.`,
        400,
      );

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CONFIRMED,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.CONFIRMED,
          "Nanny accepted the booking — awaiting user payment",
        ) as any,
      },
    });
  }

  // ── PATCH /api/v1/bookings/:id/start ─────────────────────────────────────
  // Nanny clocks in. Booking must be NANNY_ASSIGNED (payment done).
  // Range types also allow re-clock-in from IN_PROGRESS on subsequent days.
  async startBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    const isRange = RANGE_TYPES.includes(booking.serviceType as any);

    if (isRange) {
      const allowed =
        booking.status === BookingStatus.CONFIRMED ||
        booking.status === BookingStatus.IN_PROGRESS;
      if (!allowed)
        throw new AppError(
          `Cannot start booking in status: ${booking.status}. Must be CONFIRMED or IN_PROGRESS.`,
          400,
        );
    } else {
      if (booking.status !== BookingStatus.CONFIRMED)
        throw new AppError(
          `Cannot start booking in status: ${booking.status}. Booking must be CONFIRMED.`,
          400,
        );
    }

    const now = new Date();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    const scheduledStart = new Date(booking.scheduledStartTime);
    const todayScheduled = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
        scheduledStart.getUTCHours(),
        scheduledStart.getUTCMinutes(),
        0,
        0,
      ),
    );
    const lateMinutes = Math.max(
      0,
      Math.floor((now.getTime() - todayScheduled.getTime()) / 60000),
    );
    const attendanceStatus =
      lateMinutes > LATE_THRESHOLD_MINUTES
        ? AttendanceStatus.LATE
        : AttendanceStatus.PRESENT;

    const existing = await getTodayAttendance(bookingId, nanny.id);
    if (existing) {
      if (existing.clockInAt)
        throw new AppError(
          isRange
            ? "You have already clocked in for today."
            : "Shift already started for this booking.",
          400,
        );
      await prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { clockInAt: now, status: attendanceStatus, lateMinutes },
      });
    } else {
      await prisma.attendanceRecord.create({
        data: {
          bookingId,
          nannyId: nanny.id,
          userId: booking.userId,
          scheduledDate: today,
          clockInAt: now,
          status: attendanceStatus,
          lateMinutes,
        },
      });
    }

    const isFirstStart = booking.status !== BookingStatus.IN_PROGRESS;
    const lateNote =
      lateMinutes > LATE_THRESHOLD_MINUTES ? ` (${lateMinutes} min late)` : "";
    const timelineNote = isRange
      ? `Nanny clocked in for ${today.toDateString()}${lateNote}`
      : "Service started";

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.IN_PROGRESS,
        ...(isFirstStart ? { actualStartTime: now } : {}),
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.IN_PROGRESS,
          timelineNote,
        ) as any,
      },
    });

    log.info(
      `[startBooking] bookingId=${bookingId} serviceType=${booking.serviceType}` +
        ` lateMinutes=${lateMinutes} attendanceStatus=${attendanceStatus}`,
    );
    return {
      booking: updated,
      attendance: { status: attendanceStatus, lateMinutes },
    };
  }

  // ── PATCH /api/v1/bookings/:id/complete ──────────────────────────────────
  async completeBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);
    if (booking.status !== BookingStatus.IN_PROGRESS)
      throw new AppError(
        `Cannot complete booking in status: ${booking.status}. Booking must be IN_PROGRESS.`,
        400,
      );

    const now = new Date();
    const isRange = RANGE_TYPES.includes(booking.serviceType as any);

    const attendance = await getTodayAttendance(bookingId, nanny.id);
    if (!attendance?.clockInAt)
      throw new AppError("You must clock in before you can clock out.", 400);
    if (attendance.clockOutAt)
      throw new AppError("You have already clocked out for today.", 400);

    const workedMs = now.getTime() - attendance.clockInAt.getTime();
    const workedHrs = workedMs / 3_600_000;

    const expectedHrs = calcSessionHours(
      new Date(booking.scheduledStartTime),
      new Date(booking.scheduledEndTime),
    );
    const isHalfDay = workedHrs < expectedHrs * HALF_DAY_THRESHOLD_PCT;
    const finalAttStatus = isHalfDay
      ? AttendanceStatus.HALF_DAY
      : AttendanceStatus.PRESENT;

    await prisma.attendanceRecord.update({
      where: { id: attendance.id },
      data: { clockOutAt: now, status: finalAttStatus },
    });

    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const engagementEnd = new Date(booking.scheduledEndTime);
    engagementEnd.setUTCHours(0, 0, 0, 0);

    const isFinalDay = !isRange || today.getTime() >= engagementEnd.getTime();

    let updatedBooking;

    if (isFinalDay) {
      const [completed] = await prisma.$transaction([
        prisma.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.COMPLETED,
            actualEndTime: now,
            timeline: appendTimeline(
              booking.timeline,
              BookingStatus.COMPLETED,
              isRange
                ? `Engagement complete — final day clocked out. ${workedHrs.toFixed(1)} hrs worked.`
                : `Service completed. ${workedHrs.toFixed(1)} hrs worked.`,
            ) as any,
          },
        }),
        prisma.nanny.update({
          where: { id: nanny.id },
          data: { totalBookings: { increment: 1 } },
        }),
      ]);

      bus.emit(Events.BOOKING_COMPLETED, {
        bookingId,
        nannyId: nanny.id,
        userId: booking.userId,
      });
      updatedBooking = completed;
      log.info(
        `[completeBooking] FINAL bookingId=${bookingId} workedHrs=${workedHrs.toFixed(1)}`,
      );
    } else {
      updatedBooking = await prisma.booking.update({
        where: { id: bookingId },
        data: {
          timeline: appendTimeline(
            booking.timeline,
            BookingStatus.IN_PROGRESS,
            `Clocked out for ${today.toDateString()} — ${workedHrs.toFixed(1)} hrs worked${isHalfDay ? " (HALF DAY)" : ""}`,
          ) as any,
        },
      });
      log.info(
        `[completeBooking] DAILY CLOCK-OUT bookingId=${bookingId}` +
          ` workedHrs=${workedHrs.toFixed(1)} halfDay=${isHalfDay}`,
      );
    }

    return {
      booking: updatedBooking,
      attendance: {
        workedHours: +workedHrs.toFixed(2),
        status: finalAttStatus,
        isFinalDay,
      },
    };
  }

  // ── PATCH /api/v1/bookings/:id/cancel ────────────────────────────────────
  async cancelBooking(
    bookingId: string,
    userId: string,
    role: string,
    reason: string,
  ) {
    const booking: any = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    if (CANCELLED_STATUSES.includes(booking.status))
      throw new AppError(
        `Booking cannot be cancelled — current status is: ${booking.status}`,
        400,
      );

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    const isOwner = booking.userId === userId;
    let isNanny = false;

    if (!isOwner && !isAdmin) {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      isNanny = !!nanny && booking.nannyId === nanny.id;
      if (!isNanny)
        throw new AppError(
          "You do not have permission to cancel this booking",
          403,
        );
    }

    const status: BookingStatus = isAdmin
      ? BookingStatus.CANCELLED_BY_ADMIN
      : isNanny
        ? BookingStatus.CANCELLED_BY_NANNY
        : BookingStatus.CANCELLED_BY_USER;

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status,
        cancellationReason: reason,
        cancelledBy: userId,
        timeline: appendTimeline(booking.timeline, status, reason) as any,
      },
    });

    bus.emit(Events.BOOKING_CANCELLED, { bookingId, userId, reason, status });
    return updated;
  }

  // ── POST /api/v1/bookings/:id/review ─────────────────────────────────────
  async submitReview(
    bookingId: string,
    userId: string,
    rating: number,
    comment: string,
  ) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);
    if (booking.userId !== userId)
      throw new AppError(
        "Only the user who made this booking can submit a review",
        403,
      );
    if (booking.status !== BookingStatus.COMPLETED)
      throw new AppError("You can only review a completed booking", 400);
    if (booking.reviewRating !== null)
      throw new AppError(
        "A review has already been submitted for this booking",
        400,
      );
    if (!booking.nannyId)
      throw new AppError("No nanny was assigned to this booking", 400);

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        reviewRating: rating,
        reviewComment: comment,
        reviewedAt: new Date(),
      },
    });

    const nanny = await prisma.nanny.findUnique({
      where: { id: booking.nannyId },
    });
    if (nanny) {
      const newTotal = nanny.totalReviews + 1;
      const newRating = parseFloat(
        ((nanny.rating * nanny.totalReviews + rating) / newTotal).toFixed(2),
      );
      await prisma.nanny.update({
        where: { id: booking.nannyId },
        data: { rating: newRating, totalReviews: newTotal },
      });
    }
    return updated;
  }

  // ── POST /api/v1/bookings/:bookingId/tasks/:taskName/done ────────────────
  async markTaskDone(nannyUserId: string, bookingId: string, taskName: string) {
    const nanny = await prisma.nanny.findUnique({
      where: { userId: nannyUserId },
    });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);
    if (booking.nannyId !== nanny.id)
      throw new AppError("You are not assigned to this booking", 403);
    if (booking.status !== BookingStatus.IN_PROGRESS)
      throw new AppError(
        "Tasks can only be marked done when booking is in progress",
        400,
      );

    const tasks = (booking.requestedTasks as any[]) ?? [];
    const taskIndex = tasks.findIndex((t) => t.task === taskName);
    if (taskIndex === -1)
      throw new AppError(`Task "${taskName}" not found in this booking`, 404);
    if (tasks[taskIndex].isDone)
      throw new AppError(`Task "${taskName}" is already marked as done`, 400);

    tasks[taskIndex] = {
      ...tasks[taskIndex],
      isDone: true,
      doneAt: new Date().toISOString(),
    };
    return prisma.booking.update({
      where: { id: bookingId },
      data: { requestedTasks: tasks },
    });
  }

  // ── PATCH /api/v1/bookings/:id/daily-plan/task/:taskId ───────────────────
  async updatePlanTask(
    nannyUserId: string,
    bookingId: string,
    taskId: string,
    body: { status: "COMPLETED" | "SKIPPED"; notes?: string },
  ) {
    const nanny = await prisma.nanny.findUnique({
      where: { userId: nannyUserId },
    });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);
    if (booking.nannyId !== nanny.id)
      throw new AppError("You are not assigned to this booking", 403);
    if (booking.status !== "IN_PROGRESS")
      throw new AppError(
        "Tasks can only be updated when the booking is in progress",
        400,
      );

    const task = await prisma.planTask.findUnique({
      where: { id: taskId },
      include: { plan: true },
    });
    if (!task) throw new AppError(`Task ${taskId} not found`, 404);
    if (task.plan.bookingId !== bookingId)
      throw new AppError(
        "This task does not belong to the specified booking",
        403,
      );

    const VALID_STATUSES = ["COMPLETED", "SKIPPED"];
    if (!VALID_STATUSES.includes(body.status))
      throw new AppError(
        `Invalid status "${body.status}". Must be one of: ${VALID_STATUSES.join(", ")}`,
        400,
      );

    const updated = await prisma.planTask.update({
      where: { id: taskId },
      data: { status: body.status as any, updatedAt: new Date() },
    });

    if (body.notes) {
      await prisma.taskLog.upsert({
        where: { taskId },
        create: {
          taskId,
          nannyId: nanny.id,
          childrenId: booking.childrenId,
          nannyNote: body.notes,
          completedAt: body.status === "COMPLETED" ? new Date() : null,
        },
        update: {
          nannyNote: body.notes,
          ...(body.status === "COMPLETED" ? { completedAt: new Date() } : {}),
        },
      });
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.IN_PROGRESS,
          `Task "${task.title}" marked ${body.status} by nanny`,
        ) as any,
      },
    });

    log.info(
      `[updatePlanTask] taskId=${taskId} bookingId=${bookingId} status=${body.status}`,
    );
    return updated;
  }

  // ── GET /api/v1/bookings ─────────────────────────────────────────────────
  async getMyBookings(userId: string, role: string, query: any) {
    const { page, limit, skip } = paginate(query);

    if (!["USER", "NANNY", "ADMIN", "SUPER_ADMIN"].includes(role))
      throw new AppError("You do not have permission to view bookings", 403);

    let nannyId: string | undefined;
    if (role === "NANNY") {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      if (!nanny) throw new AppError("Nanny profile not found.", 404);
      nannyId = nanny.id;
    }

    const baseWhere: any =
      role === "NANNY" && nannyId ? { nannyId } : { userId };

    if (query.status) {
      const valid: BookingStatus[] = [
        BookingStatus.PENDING_PAYMENT,
        BookingStatus.CONFIRMED,
        BookingStatus.NANNY_ASSIGNED,
        BookingStatus.IN_PROGRESS,
        BookingStatus.COMPLETED,
        BookingStatus.CANCELLED_BY_USER,
        BookingStatus.CANCELLED_BY_NANNY,
        BookingStatus.CANCELLED_BY_ADMIN,
      ];
      if (!valid.includes(query.status as BookingStatus))
        throw new AppError(`Invalid status '${query.status}'`, 400);
      baseWhere.status = query.status as BookingStatus;
    }

    const include = {
      user: {
        select: { id: true, name: true, mobile: true, profilePhoto: true },
      },
      nanny: {
        select: {
          id: true,
          name: true,
          mobile: true,
          profilePhoto: true,
          rating: true,
        },
      },
    };

    if (query.status) {
      const [bookings, total] = await Promise.all([
        prisma.booking.findMany({
          where: baseWhere,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include,
        }),
        prisma.booking.count({ where: baseWhere }),
      ]);
      return paginatedResult(bookings, total, page, limit);
    }

    const [inProgress, others, total] = await Promise.all([
      prisma.booking.findMany({
        where: { ...baseWhere, status: BookingStatus.IN_PROGRESS },
        orderBy: { updatedAt: "desc" },
        include,
      }),
      prisma.booking.findMany({
        where: { ...baseWhere, status: { not: BookingStatus.IN_PROGRESS } },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include,
      }),
      prisma.booking.count({ where: baseWhere }),
    ]);

    const merged = [...inProgress, ...others].slice(skip, skip + limit);
    return paginatedResult(merged, total, page, limit);
  }

  // ── GET /api/v1/bookings/:id ─────────────────────────────────────────────
  async getBookingById(bookingId: string, userId: string, role: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        user: {
          select: { id: true, name: true, mobile: true, profilePhoto: true },
        },
        nanny: {
          select: {
            id: true,
            name: true,
            mobile: true,
            profilePhoto: true,
            rating: true,
          },
        },
        dailyPlan: { include: { tasks: true } },
        requestedDayWiseDailyPlan: { include: { requestedDailyPlan: true } },
        attendanceRecords: { orderBy: { scheduledDate: "asc" } },
      },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    const isOwner = booking.userId === userId;
    let isNanny = false;

    if (!isOwner && !isAdmin) {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      isNanny = !!nanny && booking.nannyId === nanny.id;
      if (!isNanny)
        throw new AppError("You do not have access to this booking", 403);
    }
    return booking;
  }

  // ── GET /api/v1/bookings/:id/attendance ──────────────────────────────────
  async getBookingAttendance(
    bookingId: string,
    requesterId: string,
    role: string,
  ) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    const isOwner = booking.userId === requesterId;
    let isNanny = false;

    if (!isOwner && !isAdmin) {
      const nanny = await prisma.nanny.findUnique({
        where: { userId: requesterId },
      });
      isNanny = !!nanny && booking.nannyId === nanny.id;
      if (!isNanny) throw new AppError("Access denied", 403);
    }

    const records = await prisma.attendanceRecord.findMany({
      where: { bookingId },
      orderBy: { scheduledDate: "asc" },
    });

    const summary = {
      total: records.length,
      present: records.filter((r) => r.status === AttendanceStatus.PRESENT)
        .length,
      late: records.filter((r) => r.status === AttendanceStatus.LATE).length,
      halfDay: records.filter((r) => r.status === AttendanceStatus.HALF_DAY)
        .length,
      absent: records.filter((r) => r.status === AttendanceStatus.ABSENT)
        .length,
      pending: records.filter((r) => r.status === AttendanceStatus.PENDING)
        .length,
    };

    return { records, summary };
  }

  // ── Admin: GET /api/v1/admin/bookings ─────────────────────────────────────
  async getAllBookingsAdmin(query: any) {
    const { page, limit, skip } = paginate(query);
    const valid: BookingStatus[] = [
      BookingStatus.PENDING_PAYMENT,
      BookingStatus.CONFIRMED,
      BookingStatus.NANNY_ASSIGNED,
      BookingStatus.IN_PROGRESS,
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED_BY_USER,
      BookingStatus.CANCELLED_BY_NANNY,
      BookingStatus.CANCELLED_BY_ADMIN,
    ];
    const where: any = {};
    if (query.status) {
      if (!valid.includes(query.status as BookingStatus))
        throw new AppError(`Invalid status '${query.status}'`, 400);
      where.status = query.status as BookingStatus;
    }
    if (query.userId) where.userId = query.userId;
    if (query.nannyId) where.nannyId = query.nannyId;

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, mobile: true } },
          nanny: { select: { id: true, name: true, mobile: true } },
          payment: true,
          children: true,
        },
      }),
      prisma.booking.count({ where }),
    ]);
    return paginatedResult(bookings, total, page, limit);
  }

  // ── Admin: PATCH /api/v1/admin/bookings/:id/cancel ────────────────────────
  async adminCancelBooking(bookingId: string, adminId: string, reason: string) {
    const booking: any = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);
    if (CANCELLED_STATUSES.includes(booking.status))
      throw new AppError(
        `Booking is already in a terminal state: ${booking.status}`,
        400,
      );

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CANCELLED_BY_ADMIN,
        cancellationReason: reason,
        cancelledBy: adminId,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.CANCELLED_BY_ADMIN,
          reason,
        ) as any,
      },
    });

    bus.emit(Events.BOOKING_CANCELLED, {
      bookingId,
      userId: booking.userId,
      reason,
      status: BookingStatus.CANCELLED_BY_ADMIN,
    });
    return updated;
  }

  // ── GET /api/v1/bookings/active-shift ────────────────────────────────────
  async getActiveShift(
    userId: string,
  ): Promise<{ bookingId: string; booking: any } | null> {
    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) return null;

    const booking = await prisma.booking.findFirst({
      where: { nannyId: nanny.id, status: BookingStatus.IN_PROGRESS },
      select: {
        id: true,
        serviceType: true,
        status: true,
        scheduledStartTime: true,
        scheduledEndTime: true,
        userId: true,
      },
    });
    if (!booking) return null;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const todayAttendance = await prisma.attendanceRecord.findFirst({
      where: {
        bookingId: booking.id,
        nannyId: nanny.id,
        scheduledDate: { gte: today, lt: tomorrow },
      },
    });

    if (!todayAttendance?.clockInAt) return null;
    if (todayAttendance.clockOutAt) return null;

    // console.log("getActiveShift booking:", booking);
    return { bookingId: booking.id, booking };
  }

  async getUserLiveStatus(userId: string): Promise<{
    bookingId: string;
    nannyName: string;
    nannyPhoto: string | null;
    clockedInAt: Date;
    totalTasks: number;
    completedTasks: number;
    pendingTasks: number;
    skippedTasks: number;
    tasks: {
      id: string;
      title: string;
      category: string;
      scheduledTime: string;
      durationMinutes: number;
      status: string;
      completionPct: number | null;
    }[];
  } | null> {
    // ── Step 1: Find an active booking for this user ───────────────────────
    const booking = await prisma.booking.findFirst({
      where: {
        userId,
        status: {
          in: [
            BookingStatus.IN_PROGRESS,
            BookingStatus.CONFIRMED,
            BookingStatus.NANNY_ASSIGNED,
          ],
        },
      },
      select: {
        id: true,
        nanny: { select: { id: true, name: true, profilePhoto: true } },
      },
    });

    if (!booking || !booking.nanny) return null;

    // ── Step 2: Check nanny is clocked in and NOT yet clocked out today ────
    // Attendance rows use scheduledDate = UTC midnight, so this query is fine.
    const utcToday = new Date();
    utcToday.setUTCHours(0, 0, 0, 0);
    const utcTomorrow = new Date(utcToday);
    utcTomorrow.setUTCDate(utcTomorrow.getUTCDate() + 1);

    const attendance = await prisma.attendanceRecord.findFirst({
      where: {
        bookingId: booking.id,
        nannyId: booking.nanny.id,
        scheduledDate: { gte: utcToday, lt: utcTomorrow },
      },
    });

    // Not clocked in yet, or already clocked out → no live status
    if (!attendance?.clockInAt) return null;
    if (attendance?.clockOutAt) return null;

    // ── Step 3: IST-aware date window for today's tasks ───────────────────
    //
    // IST = UTC + 5h 30m
    // "Today in IST" starts at  [utcToday - 5h30m]  i.e. yesterday 18:30 UTC
    // "Today in IST" ends at    [utcToday + 18h30m] i.e. today     18:30 UTC
    //
    // Example for 30 Apr IST:
    //   todayISTStartUTC = 2026-04-29T18:30:00.000Z  (= 30 Apr 00:00 IST)
    //   todayISTEndUTC   = 2026-04-30T18:30:00.000Z  (= 01 May 00:00 IST)
    //
    // Tasks stored for "30 Apr IST" have forDate = 2026-04-29T18:30:00.000Z
    // which falls inside [todayISTStartUTC, todayISTEndUTC) → correctly included.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 19800000 ms
    const todayISTStartUTC = new Date(utcToday.getTime() - IST_OFFSET_MS);
    const todayISTEndUTC = new Date(
      todayISTStartUTC.getTime() + 24 * 60 * 60 * 1000,
    );

    // ── Step 4: Fetch the AI daily plan for this booking ──────────────────
    const dailyPlan = await prisma.dailyPlan.findUnique({
      where: { bookingId: booking.id },
    });

    // ── Step 5: Fetch today's tasks using IST window ───────────────────────
    const tasks = dailyPlan
      ? await prisma.planTask.findMany({
          where: {
            planId: dailyPlan.id,
            forDate: {
              gte: todayISTStartUTC, // 29 Apr 18:30 UTC = 30 Apr 00:00 IST
              lt: todayISTEndUTC, // 30 Apr 18:30 UTC = 01 May 00:00 IST
            },
          },
          include: { log: true },
          orderBy: { scheduledTime: "asc" },
        })
      : [];

    // ── Step 6: Map to response shape ─────────────────────────────────────
    const mapped = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      scheduledTime: t.scheduledTime,
      durationMinutes: t.durationMinutes,
      status: t.status,
      completionPct: t.log?.completionPct ?? null,
    }));

    log.info(
      `[getUserLiveStatus] userId=${userId} bookingId=${booking.id}` +
        ` tasks=${mapped.length} clocked_in=${attendance.clockInAt.toISOString()}` +
        ` IST_window=[${todayISTStartUTC.toISOString()}, ${todayISTEndUTC.toISOString()})`,
    );

    return {
      bookingId: booking.id,
      nannyName: booking.nanny.name,
      nannyPhoto: booking.nanny.profilePhoto,
      clockedInAt: attendance.clockInAt,
      totalTasks: mapped.length,
      completedTasks: mapped.filter((t) => t.status === "COMPLETED").length,
      pendingTasks: mapped.filter((t) => t.status === "PENDING").length,
      skippedTasks: mapped.filter((t) => t.status === "SKIPPED").length,
      tasks: mapped,
    };
  }
}
