import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { bus, Events } from "../utils/eventBus";
import { paginate, paginatedResult } from "../utils/response";
import { BookingStatus, NannyStatus } from "@prisma/client";

const log = createLogger("booking");

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

const CANCELLED_STATUSES = [
  BookingStatus.CANCELLED_BY_USER,
  BookingStatus.CANCELLED_BY_NANNY,
  BookingStatus.CANCELLED_BY_ADMIN,
  BookingStatus.COMPLETED,
];

// ═════════════════════════════════════════════════════════════════════════════
// PRICING CONSTANTS — must stay in sync with frontend calculatePrice()
// ═════════════════════════════════════════════════════════════════════════════
const DAILY_RATE_HOURS = 9;
const EMERGENCY_SURCHARGE_PER_HR = 100;
const PLATFORM_FEE_PCT = 0.05;
const GST_PCT = 0.05;
const MONTHLY_WORKING_DAYS = 20;
const MAX_SESSION_HOURS = 36; // cross-midnight sessions are ≤ 36 hrs

const COUPON_CATALOGUE: Record<
  string,
  { discountPct: number; description: string }
> = {
  FIRSTCARE: { discountPct: 0.2, description: "20% off your first booking" },
  MOM20: { discountPct: 0.2, description: "20% off for MOM members" },
  NANNY10: { discountPct: 0.1, description: "10% off any booking" },
};

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-MIDNIGHT SAFE SESSION HOURS
// Mirrors frontend calcSessionHours() exactly.
// If endTime <= startTime (e.g. 21:00 → 03:00) we add 24 hrs.
// ═════════════════════════════════════════════════════════════════════════════
function calcSessionHours(startTime: Date, endTime: Date): number {
  let diff = (endTime.getTime() - startTime.getTime()) / 3_600_000;
  if (diff <= 0) diff += 24; // cross-midnight correction
  return diff;
}

// ═════════════════════════════════════════════════════════════════════════════
// PRICING ENGINE — mirrors frontend calculatePrice() exactly
// ═════════════════════════════════════════════════════════════════════════════
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

  // ── Safeguard: reject invalid dates ────────────────────────────────────
  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    throw new AppError(
      "Invalid startTime or endTime passed to pricing engine",
      500,
    );
  }

  // ── Cross-midnight safe session hours ──────────────────────────────────
  const sessionHours = calcSessionHours(startTime, endTime);

  const isRange = ["FULL_TIME", "PART_TIME", "MONTHLY_SUBSCRIPTION"].includes(
    serviceType,
  );
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
    description =
      `${sessionHours.toFixed(1)} hrs × ₹${hourlyRate}/hr` +
      ` + ₹${EMERGENCY_SURCHARGE_PER_HR}/hr emergency surcharge`;
  } else if (isRange) {
    const effectiveDailyRate =
      dailyRate && dailyRate > 0 ? dailyRate : hourlyRate * DAILY_RATE_HOURS;

    if (sessionHours <= DAILY_RATE_HOURS) {
      baseFee = effectiveDailyRate * workingDays;
      description = `₹${effectiveDailyRate}/day × ${workingDays} days`;
    } else {
      // Overtime — mirrors frontend exactly
      const overtimeHrs = sessionHours - DAILY_RATE_HOURS;
      const dailyCost = effectiveDailyRate + overtimeHrs * hourlyRate;
      baseFee = dailyCost * workingDays;
      description =
        `(₹${effectiveDailyRate}/day + ${overtimeHrs.toFixed(1)} OT hrs × ₹${hourlyRate}/hr)` +
        ` × ${workingDays} days`;
    }
  } else {
    // Fallback (HOURLY, EVENT, etc.)
    baseFee = sessionHours * hourlyRate;
    description = `${sessionHours.toFixed(1)} hrs × ₹${hourlyRate}/hr`;
  }

  // ── Coupon on baseFee only (never on goalsFee) ─────────────────────────
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

  // ── Platform fee + GST on discountedBase only ──────────────────────────
  const platformFee = Math.round(discountedBase * PLATFORM_FEE_PCT);
  const gst = Math.round(discountedBase * GST_PCT);
  const total = discountedBase + platformFee + gst + goalsFee;

  log.info(
    `[calcPricingV2] ${serviceType} | sessionHours=${sessionHours.toFixed(2)}` +
      ` | workingDays=${workingDays} | baseFee=₹${baseFee}` +
      ` | discount=₹${discount} | platformFee=₹${platformFee}` +
      ` | gst=₹${gst} | goalsFee=₹${goalsFee} | total=₹${total}`,
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

export class BookingService {
  /* ── POST /api/v1/bookings ──────────────────────────────────────────── */
  async createBooking(userId: string, body: any) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("User not found", 404);

    const start = new Date(body.scheduledStartTime);
    const end = new Date(body.scheduledEndTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new AppError("Invalid scheduledStartTime or scheduledEndTime", 400);
    }

    // ── Cross-midnight safe time validation ─────────────────────────────
    // Old check `end <= start` incorrectly rejects sessions like 9 PM → 3 AM.
    // The frontend bumps endTime +1 day for cross-midnight ONE_TIME/EMERGENCY,
    // so end > start always holds here. We additionally cap at 36 hrs to block
    // obviously invalid payloads.
    const sessionMs = end.getTime() - start.getTime();

    if (sessionMs <= 0) {
      throw new AppError(
        "scheduledEndTime must be after scheduledStartTime. " +
          "For sessions crossing midnight (e.g. 9 PM → 3 AM), " +
          "the end time must be sent as the following calendar day.",
        400,
      );
    }

    //-------------------------------------------------------------------------------check this why it is breaking-------------------------------------------------------------------------------------
    // console.log(body.serviceType)
    // if (sessionMs > MAX_SESSION_HOURS * 3_600_000 || body.serviceType === "FULL_TIME") {
    //   throw new AppError(
    //     `Booking session cannot exceed ${MAX_SESSION_HOURS} hours. ` +
    //       "Please check your start and end times.",
    //     400,
    //   );
    // }
    //-------------------------------------------------------------------------------check this why it is breaking-------------------------------------------------------------------------------------

    if (start <= new Date()) {
      throw new AppError("scheduledStartTime must be in the future", 400);
    }

    const child = await prisma.children.findUnique({
      where: { id: body.childrenId },
    });
    if (!child) throw new AppError("Child not found", 404);
    if (child.userId !== userId) {
      throw new AppError("This child does not belong to your account", 403);
    }

    let nannyId: string | null = null;
    let nanny: any = null;

    if (body.nannyId) {
      nanny = await prisma.nanny.findUnique({ where: { id: body.nannyId } });
      if (!nanny) throw new AppError("The specified nanny was not found", 404);
      if (nanny.status !== NannyStatus.VERIFIED) {
        throw new AppError(
          "This nanny is not currently verified and cannot accept bookings",
          400,
        );
      }
      if (!nanny.isAvailable) {
        throw new AppError("This nanny is currently not available", 400);
      }
      if (!nanny.isActive) {
        throw new AppError("This nanny account is not active", 400);
      }
      if (!nanny.serviceTypes.includes(body.serviceType)) {
        throw new AppError(
          `This nanny does not offer ${body.serviceType}.`,
          400,
        );
      }
      nannyId = nanny.id;
    }

    if (body.couponCode) {
      const cv = validateCoupon(body.couponCode);
      if (!cv.valid) throw new AppError("Invalid or expired coupon code", 400);
    }

    const selectedGoals: any[] = Array.isArray(body.selectedGoals)
      ? body.selectedGoals
      : [];

    // goalsFee: backend reads pricePerMonth (set by frontend payload builder)
    const goalsFee = selectedGoals.reduce(
      (sum: number, g: any) => sum + (Number(g.pricePerMonth) || 0),
      0,
    );

    // ── Working days: enumerate actual calendar dates (UTC-safe) ─────────
    // Mirrors frontend countWorkingDays() exactly.
    let billingWorkingDays = MONTHLY_WORKING_DAYS;
    const isRange = ["FULL_TIME", "PART_TIME", "MONTHLY_SUBSCRIPTION"].includes(
      body.serviceType,
    );

    if (
      isRange &&
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
      // Use noon UTC to avoid DST boundary issues crossing date lines
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

    // ── Shift times for range bookings ────────────────────────────────────
    // For FULL_TIME / PART_TIME the daily window comes from dailyStartTime /
    // dailyEndTime. For single-day types we use scheduledStart/End directly.
    let shiftStart = start;
    let shiftEnd = end;

    if (isRange && body.dailyStartTime && body.dailyEndTime) {
      const dStart = new Date(body.dailyStartTime);
      const dEnd = new Date(body.dailyEndTime);
      if (!isNaN(dStart.getTime()) && !isNaN(dEnd.getTime())) {
        shiftStart = dStart;
        shiftEnd = dEnd;
      }
    }

    // ── Nanny rate validation ─────────────────────────────────────────────
    if (!nanny?.hourlyRate || nanny.hourlyRate <= 0) {
      throw new AppError(
        "This nanny does not have a valid hourly rate configured. " +
          "Please update the nanny profile before accepting bookings.",
        400,
      );
    }

    // ── Parity debug: log inputs so frontend vs backend diff is instant ───
    const expectedSessionHrs = calcSessionHours(shiftStart, shiftEnd);
    log.info(
      `[BOOKING_PRICING_INPUTS] serviceType=${body.serviceType}` +
        ` | shiftStart=${shiftStart.toISOString()}` +
        ` | shiftEnd=${shiftEnd.toISOString()}` +
        ` | expectedSessionHrs=${expectedSessionHrs.toFixed(2)}` +
        ` | hourlyRate=₹${nanny.hourlyRate}` +
        ` | dailyRate=${nanny.dailyRate ?? "null"}` +
        ` | billingWorkingDays=${billingWorkingDays}` +
        ` | couponCode=${body.couponCode ?? "none"}` +
        ` | goalsFee=₹${goalsFee}`,
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
        status: BookingStatus.PENDING_PAYMENT,
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
          BookingStatus.PENDING_PAYMENT,
          "Booking created, awaiting payment",
        ) as any,
      },
      include: { children: true },
    });

    // ── Day-wise plan creation ─────────────────────────────────────────────
    const taskStrings: string[] = Array.isArray(body.requestedTasks)
      ? body.requestedTasks
      : [];
    const planDates: Date[] = [];

    if (
      isRange &&
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
          const planD = new Date(cur);
          planD.setUTCHours(0, 0, 0, 0);
          planDates.push(planD);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else {
      // Single-day booking: one plan for the booking date
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

    // ── Goals ─────────────────────────────────────────────────────────────
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

    bus.emit(Events.BOOKING_CREATED, { bookingId: booking.id, userId });
    log.info(`Booking created: ${booking.id} | total: ₹${pricing.total}`);

    return { ...booking, pricing };
  }

  /* ── POST /api/v1/bookings/markTaskDone ──────────────────────────────── */
  async markTaskDone(nannyUserId: string, bookingId: string, taskName: string) {
    const nanny = await prisma.nanny.findUnique({
      where: { userId: nannyUserId },
    });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    if (booking.nannyId !== nanny.id) {
      throw new AppError("You are not assigned to this booking", 403);
    }
    if (booking.status !== BookingStatus.IN_PROGRESS) {
      throw new AppError(
        "Tasks can only be marked done when booking is in progress",
        400,
      );
    }

    const tasks = (booking.requestedTasks as any[]) ?? [];
    const taskIndex = tasks.findIndex((t) => t.task === taskName);

    if (taskIndex === -1) {
      throw new AppError(`Task "${taskName}" not found in this booking`, 404);
    }
    if (tasks[taskIndex].isDone) {
      throw new AppError(`Task "${taskName}" is already marked as done`, 400);
    }

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

  /* ── GET /api/v1/bookings ───────────────────────────────────────────── */
  async getMyBookings(userId: string, role: string, query: any) {
    const { page, limit, skip } = paginate(query);

    if (!["USER", "NANNY", "ADMIN", "SUPER_ADMIN"].includes(role)) {
      throw new AppError("You do not have permission to view bookings", 403);
    }

    let nannyId: string | undefined;
    if (role === "NANNY") {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      if (!nanny) {
        throw new AppError(
          "Nanny profile not found. Please register as a nanny first.",
          404,
        );
      }
      nannyId = nanny.id;
    }

    const where: any = role === "NANNY" && nannyId ? { nannyId } : { userId };

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
      if (!valid.includes(query.status as BookingStatus)) {
        throw new AppError(`Invalid status '${query.status}'`, 400);
      }
      where.status = query.status as BookingStatus;
    }

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
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
        },
      }),
      prisma.booking.count({ where }),
    ]);
    return paginatedResult(bookings, total, page, limit);
  }

  /* ── GET /api/v1/bookings/:id ───────────────────────────────────────── */
  async getBookingById(bookingId: string, userId: string, role: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        // Keep user info for reference (though not strictly rendered in this specific UI)
        user: {
          select: { id: true, name: true, mobile: true, profilePhoto: true },
        },
        // Keep exact Nanny details needed for the profile card
        nanny: {
          select: {
            id: true,
            name: true,
            mobile: true,
            profilePhoto: true,
            rating: true,
          },
        },
        // Only fetch the specific fields rendered in the User Selected Goals card
        childGoals: {
          select: {
            id: true,
            category: true,
            name: true,
            parentDescription: true,
          },
        },
      },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    const isOwner = booking.userId === userId;
    let isNanny = false;

    if (!isOwner && !isAdmin) {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      isNanny = !!nanny && booking.nannyId === nanny.id;
      if (!isNanny) {
        throw new AppError("You do not have access to this booking", 403);
      }
    }
    return booking;
  }

  /* ── PATCH /api/v1/bookings/:id/cancel ─────────────────────────────── */
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

    if (CANCELLED_STATUSES.includes(booking.status)) {
      throw new AppError(
        `Booking cannot be cancelled — current status is: ${booking.status}`,
        400,
      );
    }

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    const isOwner = booking.userId === userId;
    let isNanny = false;

    if (!isOwner && !isAdmin) {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      isNanny = !!nanny && booking.nannyId === nanny.id;
      if (!isNanny) {
        throw new AppError(
          "You do not have permission to cancel this booking",
          403,
        );
      }
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

  /* ── PATCH /api/v1/bookings/:id/accept (nanny) ──────────────────────── */
  async acceptBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id) {
      throw new AppError("This booking is not assigned to you", 403);
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new AppError(
        `Cannot accept booking in status: ${booking.status}. Booking must be CONFIRMED.`,
        400,
      );
    }

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.NANNY_ASSIGNED,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.NANNY_ASSIGNED,
          "Nanny accepted the booking",
        ) as any,
      },
    });
  }

  /* ── PATCH /api/v1/bookings/:id/start (nanny) ───────────────────────── */
  async startBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id) {
      throw new AppError("This booking is not assigned to you", 403);
    }

    if (booking.status !== BookingStatus.NANNY_ASSIGNED) {
      throw new AppError(
        `Cannot start booking in status: ${booking.status}. Booking must be NANNY_ASSIGNED.`,
        400,
      );
    }

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.IN_PROGRESS,
        actualStartTime: new Date(),
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.IN_PROGRESS,
          "Service started",
        ) as any,
      },
    });
  }

  /* ── PATCH /api/v1/bookings/:id/complete (nanny) ────────────────────── */
  async completeBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id) {
      throw new AppError("This booking is not assigned to you", 403);
    }

    if (booking.status !== BookingStatus.IN_PROGRESS) {
      throw new AppError(
        `Cannot complete booking in status: ${booking.status}. Booking must be IN_PROGRESS.`,
        400,
      );
    }

    const [updated] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.COMPLETED,
          actualEndTime: new Date(),
          timeline: appendTimeline(
            booking.timeline,
            BookingStatus.COMPLETED,
            "Service completed",
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
    return updated;
  }

  /* ── POST /api/v1/bookings/:id/review ───────────────────────────────── */
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
    if (booking.userId !== userId) {
      throw new AppError(
        "Only the user who made this booking can submit a review",
        403,
      );
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppError("You can only review a completed booking", 400);
    }
    if (booking.reviewRating !== null) {
      throw new AppError(
        "A review has already been submitted for this booking",
        400,
      );
    }
    if (!booking.nannyId) {
      throw new AppError("No nanny was assigned to this booking", 400);
    }

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

  /* ── Called by payment event ─────────────────────────────────────────── */
  async handlePaymentCaptured(bookingId: string, paymentId?: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking || booking.status !== BookingStatus.PENDING_PAYMENT) return;

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CONFIRMED,
        paymentId: paymentId ?? null,
        timeline: appendTimeline(
          booking.timeline,
          BookingStatus.CONFIRMED,
          "Payment confirmed",
        ) as any,
      },
    });
    log.info(`Booking ${bookingId} confirmed via payment`);
  }

  async handlePaymentFailed(bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
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
  }

  /* ── Admin: GET /api/v1/admin/bookings ───────────────────────────────── */
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
      if (!valid.includes(query.status as BookingStatus)) {
        throw new AppError(`Invalid status '${query.status}'`, 400);
      }
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

  /* ── Admin: POST /api/v1/admin/bookings/:id/cancel ───────────────────── */
  async adminCancelBooking(bookingId: string, adminId: string, reason: string) {
    const booking: any = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    if (CANCELLED_STATUSES.includes(booking.status)) {
      throw new AppError(
        `Booking is already in a terminal state: ${booking.status}`,
        400,
      );
    }

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
}
