import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { bus, Events } from "../utils/eventBus";
import { paginate, paginatedResult } from "../utils/response";
import { AttendanceStatus, BookingStatus, NannyStatus } from "@prisma/client";
import {
  calcPricing,
  calcSessionHours,
  getWorkingDates,
  isRangeType,
  validateCoupon,
  MAX_SESSION_HOURS,
  LATE_THRESHOLD_MINUTES,
  HALF_DAY_THRESHOLD_PCT,
  DEFAULT_MONTHLY_WORKING_DAYS,
} from "../utils/pricing";

// Re-export for any callers that imported these from this module directly
export { validateCoupon } from "../utils/pricing";

const log = createLogger("booking");

// ─────────────────────────────────────────────────────────────────────────────
// STATUS LIFECYCLE
//
//   PENDING_NANNY_CONFIRMATION  → booking created, nanny must accept/reject
//   PENDING_PAYMENT             → nanny accepted, user must pay
//   CONFIRMED                   → payment received, ready to start
//   IN_PROGRESS                 → nanny clocked in
//   COMPLETED                   → service done (final clock-out)
//
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// RESERVED SLOT MANAGEMENT
// These helpers keep nanny.reservedSlot in sync with confirmed bookings so
// the explore/search route can filter out unavailable nannies.
// ─────────────────────────────────────────────────────────────────────────────

/** Adds a time slot to nanny.reservedSlot when a booking is confirmed. */
async function addReservedSlot(
  nannyId: string,
  bookingId: string,
  startTime: Date,
  endTime: Date,
): Promise<void> {
  try {
    const nanny = await prisma.nanny.findUnique({
      where: { id: nannyId },
      select: { reservedSlot: true },
    });
    if (!nanny) return;

    const existing = (nanny.reservedSlot as any[]) ?? [];
    // Avoid duplicates
    if (existing.some((s: any) => s.bookingId === bookingId)) return;

    await prisma.nanny.update({
      where: { id: nannyId },
      data: {
        reservedSlot: [
          ...existing,
          { startTime, endTime, bookingId, isBlock: false },
        ],
      },
    });
    log.info(`[addReservedSlot] nannyId=${nannyId} bookingId=${bookingId}`);
  } catch (e) {
    log.error(
      `[addReservedSlot] failed nannyId=${nannyId} bookingId=${bookingId}`,
      e,
    );
  }
}

/** Removes a booking's slot from nanny.reservedSlot when cancelled or completed. */
async function removeReservedSlot(
  nannyId: string,
  bookingId: string,
): Promise<void> {
  try {
    const nanny = await prisma.nanny.findUnique({
      where: { id: nannyId },
      select: { reservedSlot: true },
    });
    if (!nanny) return;

    const filtered = ((nanny.reservedSlot as any[]) ?? []).filter(
      (s: any) => s.bookingId !== bookingId,
    );

    await prisma.nanny.update({
      where: { id: nannyId },
      data: { reservedSlot: filtered },
    });
    log.info(`[removeReservedSlot] nannyId=${nannyId} bookingId=${bookingId}`);
  } catch (e) {
    log.error(
      `[removeReservedSlot] failed nannyId=${nannyId} bookingId=${bookingId}`,
      e,
    );
  }
}

/** Extends the endTime of an existing reserved slot for a booking. */
async function extendReservedSlot(
  nannyId: string,
  bookingId: string,
  newEndTime: Date,
): Promise<void> {
  try {
    const nanny = await prisma.nanny.findUnique({
      where: { id: nannyId },
      select: { reservedSlot: true },
    });
    if (!nanny) return;

    const slots = (nanny.reservedSlot as any[]) ?? [];
    const updated = slots.map((s: any) =>
      s.bookingId === bookingId ? { ...s, endTime: newEndTime } : s,
    );

    await prisma.nanny.update({
      where: { id: nannyId },
      data: { reservedSlot: updated },
    });
    log.info(`[extendReservedSlot] nannyId=${nannyId} bookingId=${bookingId}`);
  } catch (e) {
    log.error(
      `[extendReservedSlot] failed nannyId=${nannyId} bookingId=${bookingId}`,
      e,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getTodayAttendance(bookingId: string, nannyId: string) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  return prisma.attendanceRecord.findFirst({
    where: { bookingId, nannyId, scheduledDate: { gte: today, lt: tomorrow } },
  });
}

/**
 * Pre-creates PENDING attendance rows for every working day in the booking.
 * Called after payment is captured. Safe to call multiple times — upserts.
 */
async function seedAttendanceRecords(
  bookingId: string,
): Promise<{ seeded: number }> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking || !booking.nannyId) return { seeded: 0 };

  const isRange = isRangeType(booking.serviceType);
  const workingDayNames: string[] = (booking as any).workingDays ?? [];

  const dates = isRange
    ? getWorkingDates(
        booking.scheduledStartTime,
        booking.scheduledEndTime,
        workingDayNames,
      )
    : (() => {
        const d = new Date(booking.scheduledStartTime);
        d.setUTCHours(0, 0, 0, 0);
        return [d];
      })();

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
// BOOKING SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class BookingService {
  // ── POST /api/v1/bookings ────────────────────────────────────────────────
  async createBooking(userId: string, body: any) {
    // ── 1. Validate user & basic inputs ─────────────────────────────────────
    console.log("called booking service createbooking");
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("User not found", 404);

    const start = new Date(body.scheduledStartTime);
    const end = new Date(body.scheduledEndTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime()))
      throw new AppError("Invalid scheduledStartTime or scheduledEndTime", 400);

    if (start <= new Date())
      throw new AppError("scheduledStartTime must be in the future", 400);

    const sessionMs = end.getTime() - start.getTime();
    const isRange = isRangeType(body.serviceType);

    if (sessionMs <= 0)
      throw new AppError(
        "scheduledEndTime must be after scheduledStartTime. " +
          "For cross-midnight sessions the end time must be on the following calendar day.",
        400,
      );
    console.log("tag 1");
    if (!isRange && sessionMs > MAX_SESSION_HOURS * 3_600_000)
      throw new AppError(
        `Session cannot exceed ${MAX_SESSION_HOURS} hours.`,
        400,
      );

    console.log("tag 2");
    // ── 2. Validate child ────────────────────────────────────────────────────
    const child = await prisma.children.findUnique({
      where: { id: body.childrenId },
    });
    if (!child) throw new AppError("Child not found", 404);
    if (child.userId !== userId)
      throw new AppError("This child does not belong to your account", 403);

    // ── 3. Validate nanny (if specified) ────────────────────────────────────
    let nannyId: string | null = null;
    let nanny: any = null;
    console.log("tag 3");

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
      if (!nanny.hourlyRate || nanny.hourlyRate <= 0)
        throw new AppError(
          "This nanny does not have a valid hourly rate configured.",
          400,
        );

      // Check nanny is not already booked for this time slot
      const conflict = ((nanny.reservedSlot as any[]) ?? []).some(
        (slot: any) => {
          const slotStart = new Date(slot.startTime).getTime();
          const slotEnd = new Date(slot.endTime).getTime();
          return slotStart < end.getTime() && slotEnd > start.getTime();
        },
      );
      if (conflict)
        throw new AppError(
          "This nanny is already booked during the requested time.",
          409,
        );

      nannyId = nanny.id;
    }

    // ── 4. Validate coupon ───────────────────────────────────────────────────
    if (body.couponCode && !validateCoupon(body.couponCode).valid)
      throw new AppError("Invalid or expired coupon code", 400);

    console.log("tag 4");
    // ── 5. Goals fee ─────────────────────────────────────────────────────────
    const selectedGoals: any[] = Array.isArray(body.selectedGoals)
      ? body.selectedGoals
      : [];
    const goalsFee = selectedGoals.reduce(
      (sum: number, g: any) => sum + (Number(g.pricePerMonth) || 0),
      0,
    );

    // ── 6. Resolve working days & shift window ───────────────────────────────
    const workingDayNames: string[] =
      isRange && Array.isArray(body.workingDays) ? body.workingDays : [];

    // Count actual working days for billing
    let billingWorkingDays = DEFAULT_MONTHLY_WORKING_DAYS;
    if (isRange && workingDayNames.length > 0) {
      const count = getWorkingDates(start, end, workingDayNames).length;
      billingWorkingDays = count > 0 ? count : DEFAULT_MONTHLY_WORKING_DAYS;
    }

    // For range bookings a separate daily shift window may be provided
    let shiftStart = start;
    let shiftEnd = end;
    if (isRange && body.dailyStartTime && body.dailyEndTime) {
      const dS = new Date(body.dailyStartTime);
      const dE = new Date(body.dailyEndTime);
      if (!isNaN(dS.getTime()) && !isNaN(dE.getTime())) {
        shiftStart = dS;
        shiftEnd = dE;
      }
    }

    console.log("tag 4", body.lunch);
    // ── 7. Calculate pricing ─────────────────────────────────────────────────
    const pricing = nanny
      ? calcPricing({
          serviceType: body.serviceType,
          hourlyRate: nanny.hourlyRate,
          dailyRate:
            nanny.dailyRate && nanny.dailyRate > 0 ? nanny.dailyRate : null,
          shiftStart,
          shiftEnd,
          workingDays: billingWorkingDays,
          couponCode: body.couponCode ?? undefined,
          goalsFee,
          lunch: body.lunch === true,
        })
      : null;

    console.log("you pricies", calcPricing);

    // ── 8. Build address snapshot ────────────────────────────────────────────
    const addr = body.address;
    const coords = addr?.coordinates?.coordinates;

    // ── 9. Build requested tasks ─────────────────────────────────────────────
    const requestedTasks = Array.isArray(body.requestedTasks)
      ? body.requestedTasks.map((t: string) => ({
          task: t,
          isDone: false,
          doneAt: null,
        }))
      : [];

    // ── 10. Create booking ───────────────────────────────────────────────────
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
        workingDays: workingDayNames,
        addressLabel: addr?.label ?? null,
        addressLine1: addr?.addressLine1 ?? "",
        addressLine2: addr?.addressLine2 ?? null,
        addressCity: addr?.city ?? "",
        addressState: addr?.state ?? "",
        addressPincode: addr?.pincode ?? "",
        addressCountry: addr?.country ?? "IN",
        addressLat: coords ? coords[1] : null,
        addressLng: coords ? coords[0] : null,
        baseAmount: pricing?.baseFee ?? 0,
        gstAmount: pricing?.gst ?? 0,
        totalAmount: pricing?.total ?? 0,
        status: BookingStatus.PENDING_NANNY_CONFIRMATION,
        pricingDetails: pricing
          ? {
              sessionHours: pricing.sessionHours,
              workingDays: pricing.workingDays,
              description: pricing.description,
              baseFee: pricing.baseFee,
              emergencySurcharge: pricing.emergencySurcharge,
              couponCode: pricing.couponCode,
              couponLabel: pricing.couponLabel,
              discount: pricing.discount,
              discountedBase: pricing.discountedBase,
              platformFee: pricing.platformFee,
              gst: pricing.gst,
              goalsFee: pricing.goalsFee,
              lunchFee: pricing.lunchFee,
              total: pricing.total,
            }
          : null,
        timeline: appendTimeline(
          [],
          BookingStatus.PENDING_NANNY_CONFIRMATION,
          "Booking created — awaiting nanny confirmation",
        ) as any,
      },
      include: { children: true },
    });

    // ── 11. Create a single day-wise plan container ──────────────────────────
    // One RequestedDayWiseDailyPlan per booking (not per day) with all tasks
    // stored in one RequestedDailyPlan. Updates go through the new route.
    const taskStrings: string[] = Array.isArray(body.requestedTasks)
      ? body.requestedTasks
      : [];

    if (taskStrings.length > 0) {
      const planStartDate = new Date(start);
      planStartDate.setUTCHours(0, 0, 0, 0);
      const dayPlan = await prisma.requestedDayWiseDailyPlan.create({
        data: { bookingId: booking.id, date: planStartDate },
      });
      await Promise.all(
        taskStrings.map((task) =>
          prisma.requestedDailyPlan.create({
            data: {
              requestedDayWiseDailyPlanId: dayPlan.id,
              name: task,
              status: "ACTIVE",
              additionalNotes: [] as any,
            },
          }),
        ),
      );
    }

    // ── 12. Create child goals ───────────────────────────────────────────────
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

    // Nanny gets an FCM push to accept or reject
    bus.emit(Events.BOOKING_CREATED, { bookingId: booking.id, userId });
    log.info(
      `[createBooking] id=${booking.id} total=₹${pricing?.total ?? 0} — nanny FCM triggered`,
    );
    return { ...booking, pricing };
  }

  // ── PATCH /api/v1/bookings/:id/confirm ───────────────────────────────────
  // Nanny accepts the booking request.
  // PENDING_NANNY_CONFIRMATION → PENDING_PAYMENT
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

    // Idempotent: already awaiting payment
    if (booking.status === BookingStatus.PENDING_PAYMENT) {
      log.info(
        `[confirmBooking] Already PENDING_PAYMENT bookingId=${bookingId}`,
      );
      return booking;
    }

    if (booking.status !== BookingStatus.PENDING_NANNY_CONFIRMATION)
      throw new AppError(
        `Cannot confirm booking in status: ${booking.status}. Must be PENDING_NANNY_CONFIRMATION.`,
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

    bus.emit(Events.BOOKING_CONFIRMED, {
      bookingId,
      userId: booking.userId,
      nannyId: nanny.id,
    });
    log.info(
      `[confirmBooking] bookingId=${bookingId} nannyId=${nanny.id} → PENDING_PAYMENT`,
    );
    return updated;
  }

  // ── PATCH /api/v1/bookings/:id/reject ────────────────────────────────────
  // Nanny rejects the booking request. nannyId cleared for possible reassignment.
  // PENDING_NANNY_CONFIRMATION → CANCELLED_BY_NANNY
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
        `Cannot reject booking in status: ${booking.status}. Must be PENDING_NANNY_CONFIRMATION.`,
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

    // No reservedSlot removal needed — slot was never added at this stage
    bus.emit(Events.BOOKING_CANCELLED, {
      bookingId,
      userId: booking.userId,
      reason: cancellationReason,
      status: BookingStatus.CANCELLED_BY_NANNY,
    });

    log.info(`[rejectBooking] bookingId=${bookingId} nannyId=${nanny.id}`);
    return updated;
  }

  // ── Payment events ────────────────────────────────────────────────────────
  // Called by the payment webhook via eventHandlers.ts after Razorpay confirms.
  // PENDING_PAYMENT → CONFIRMED
  async handlePaymentCaptured(bookingId: string, paymentId?: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    console.log("going to capture the payment");

    const environment = process.env.NODE_ENV || "OFFICESETUP";

    if (environment === "OFFICESETUP") {
      if (
        !booking ||
        booking.status !== BookingStatus.PENDING_NANNY_CONFIRMATION
      )
        return;
    } else {
      if (!booking || booking.status !== BookingStatus.PENDING_PAYMENT) return;
    }

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

    console.log("payment done going for add reserve slots");
    // Block this time slot on the nanny's profile so the explore route hides her

    if (booking.nannyId) {
      const data = await addReservedSlot(
        booking.nannyId,
        bookingId,
        booking.scheduledStartTime,
        booking.scheduledEndTime,
      );
      console.log("reserve slots added going for create attendance", data);
    }

    // Pre-seed attendance rows for every working day
    try {
      const { seeded } = await seedAttendanceRecords(bookingId);
      log.info(
        `[handlePaymentCaptured] bookingId=${bookingId} attendanceSeeded=${seeded}`,
      );
    } catch (e) {
      log.error(
        `[handlePaymentCaptured] attendance seed failed bookingId=${bookingId}`,
        e,
      );
    }

    log.info(`[handlePaymentCaptured] bookingId=${bookingId} → CONFIRMED`);
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

    bus.emit(Events.PAYMENT_FAILED, { bookingId, userId: booking.userId });
  }

  // ── PATCH /api/v1/bookings/:id/accept ────────────────────────────────────
  // Legacy in-app accept (kept for backward compatibility).
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
        `Cannot accept booking in status: ${booking.status}. Must be PENDING_PAYMENT.`,
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
  // Nanny clocks in.
  // Single-day: CONFIRMED → IN_PROGRESS
  // Range:      CONFIRMED | IN_PROGRESS → IN_PROGRESS (daily clock-in, multi-day)
  async startBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    const isRange = isRangeType(booking.serviceType);

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
          `Cannot start booking in status: ${booking.status}. Must be CONFIRMED.`,
          400,
        );
    }

    const now = new Date();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    // Determine lateness against today's scheduled start time
    const scheduledStart = new Date(booking.scheduledStartTime);
    const todayScheduledUTC = new Date(
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
      Math.floor((now.getTime() - todayScheduledUTC.getTime()) / 60_000),
    );
    const attendanceStatus =
      lateMinutes > LATE_THRESHOLD_MINUTES
        ? AttendanceStatus.LATE
        : AttendanceStatus.PRESENT;

    // Upsert today's attendance row
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
        ` lateMinutes=${lateMinutes} attendance=${attendanceStatus}`,
    );
    return {
      booking: updated,
      attendance: { status: attendanceStatus, lateMinutes },
    };
  }

  // ── PATCH /api/v1/bookings/:id/complete ──────────────────────────────────
  // Nanny clocks out.
  // Single-day / final day of range  → COMPLETED  (removes reservedSlot)
  // Non-final day of range           → stays IN_PROGRESS (daily clock-out only)
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
        `Cannot complete booking in status: ${booking.status}. Must be IN_PROGRESS.`,
        400,
      );

    const now = new Date();
    const isRange = isRangeType(booking.serviceType);
    const attendance = await getTodayAttendance(bookingId, nanny.id);

    if (!attendance?.clockInAt)
      throw new AppError("You must clock in before you can clock out.", 400);
    if (attendance.clockOutAt)
      throw new AppError("You have already clocked out for today.", 400);

    const workedHrs =
      (now.getTime() - attendance.clockInAt.getTime()) / 3_600_000;
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

    // Check if this is the final working day of the engagement
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

      // Free up the nanny's time slot
      if (booking.nannyId) await removeReservedSlot(booking.nannyId, bookingId);

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
      // Daily clock-out for multi-day bookings — booking stays IN_PROGRESS
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

    // Free the nanny's slot if payment had already been taken
    if (
      booking.nannyId &&
      (booking.status === BookingStatus.CONFIRMED ||
        booking.status === BookingStatus.IN_PROGRESS)
    ) {
      await removeReservedSlot(booking.nannyId, bookingId);
    }

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

    // Pin IN_PROGRESS bookings to the top, paginate the rest
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
    // IST window: "today" in IST = UTC−5h30m offset window
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const utcToday = new Date();
    utcToday.setUTCHours(0, 0, 0, 0);
    const todayISTStartUTC = new Date(utcToday.getTime() - IST_OFFSET_MS);
    const todayISTEndUTC = new Date(
      todayISTStartUTC.getTime() + 24 * 60 * 60 * 1000,
    );

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
        childGoals: true,
        dailyPlan: true,
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

    // Stitch today's AI-generated tasks (IST-aware) onto the daily plan
    const plan = booking.dailyPlan?.[0] ?? null;
    const todayTasks = plan
      ? await prisma.planTask.findMany({
          where: {
            planId: plan.id,
            forDate: { gte: todayISTStartUTC, lt: todayISTEndUTC },
          },
          orderBy: { scheduledTime: "asc" },
        })
      : [];

    return {
      ...booking,
      dailyPlan: booking.dailyPlan.map((p) =>
        p.id === plan?.id ? { ...p, tasks: todayTasks } : { ...p, tasks: [] },
      ),
    };
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
          payments: true,
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

    // Free the nanny's slot if payment had already been taken
    if (
      booking.nannyId &&
      (booking.status === BookingStatus.CONFIRMED ||
        booking.status === BookingStatus.IN_PROGRESS)
    ) {
      await removeReservedSlot(booking.nannyId, bookingId);
    }

    bus.emit(Events.BOOKING_CANCELLED, {
      bookingId,
      userId: booking.userId,
      reason,
      status: BookingStatus.CANCELLED_BY_ADMIN,
    });

    return updated;
  }

  // ── GET /api/v1/bookings/me/active-shift ────────────────────────────────
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

    if (!todayAttendance?.clockInAt || todayAttendance.clockOutAt) return null;
    return { bookingId: booking.id, booking };
  }

  // ── GET /api/v1/bookings/me/live-status ──────────────────────────────────
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

    // Check nanny is clocked in and not yet clocked out today
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

    if (!attendance?.clockInAt || attendance.clockOutAt) return null;

    // IST-aware window for today's tasks
    // IST = UTC+5h30m → "today in IST" starts at [UTC midnight − 5h30m]
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const todayISTStartUTC = new Date(utcToday.getTime() - IST_OFFSET_MS);
    const todayISTEndUTC = new Date(
      todayISTStartUTC.getTime() + 24 * 60 * 60 * 1000,
    );

    const dailyPlan = await prisma.dailyPlan.findUnique({
      where: { bookingId: booking.id },
    });

    const tasks = dailyPlan
      ? await prisma.planTask.findMany({
          where: {
            planId: dailyPlan.id,
            forDate: { gte: todayISTStartUTC, lt: todayISTEndUTC },
          },
          include: { log: true },
          orderBy: { scheduledTime: "asc" },
        })
      : [];

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
        ` tasks=${mapped.length} clockedIn=${attendance.clockInAt.toISOString()}`,
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

  // ── POST /api/v1/bookings/:id/requested-plan ─────────────────────────────
  // Adds a new RequestedDayWiseDailyPlan with the tasks list for the given date.
  // Creates exactly one container record and one plan record (no per-day fan-out).
  async addRequestedPlan(
    bookingId: string,
    userId: string,
    date: string,
    tasks: string[],
  ) {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError("Booking not found", 404);
    if (booking.userId !== userId)
      throw new AppError("You do not have access to this booking", 403);

    const planDate = new Date(date);
    if (isNaN(planDate.getTime())) throw new AppError("Invalid date", 400);
    planDate.setUTCHours(0, 0, 0, 0);

    const dayPlan = await prisma.requestedDayWiseDailyPlan.create({
      data: { bookingId, date: planDate },
    });
    await Promise.all(
      tasks.map((task) =>
        prisma.requestedDailyPlan.create({
          data: {
            requestedDayWiseDailyPlanId: dayPlan.id,
            name: task,
            status: "ACTIVE",
            additionalNotes: [] as any,
          },
        }),
      ),
    );

    log.info(
      `[addRequestedPlan] bookingId=${bookingId} date=${planDate.toISOString()} tasks=${tasks.length}`,
    );
    return { dayPlan };
  }

  // ── POST /api/v1/bookings/:id/extend ─────────────────────────────────────
  // Creates a BookingExtension record for FULL_TIME or PART_TIME bookings.
  // Returns extension details + pricing so the frontend can initiate payment.
  async extendBooking(
    bookingId: string,
    userId: string,
    newEndDate: string,
    workingDays?: string[],
  ) {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError("Booking not found", 404);
    if (booking.userId !== userId)
      throw new AppError("You do not have access to this booking", 403);

    if (!["FULL_TIME", "PART_TIME"].includes(booking.serviceType))
      throw new AppError(
        "Extensions are only available for FULL_TIME and PART_TIME bookings",
        400,
      );

    if (!["CONFIRMED", "IN_PROGRESS"].includes(booking.status))
      throw new AppError(
        `Cannot extend a booking in status: ${booking.status}`,
        400,
      );

    const newEnd = new Date(newEndDate);
    if (isNaN(newEnd.getTime())) throw new AppError("Invalid newEndDate", 400);
    if (newEnd <= booking.scheduledEndTime)
      throw new AppError("New end date must be after the current end date", 400);

    const pending = await prisma.bookingExtension.findFirst({
      where: { bookingId, status: "PENDING_PAYMENT" },
    });
    if (pending)
      throw new AppError(
        "A pending extension already exists for this booking",
        409,
      );

    const nanny = booking.nannyId
      ? await prisma.nanny.findUnique({ where: { id: booking.nannyId } })
      : null;
    if (!nanny || !nanny.hourlyRate)
      throw new AppError(
        "Nanny rate is not available — cannot calculate extension pricing",
        400,
      );

    const extensionWorkingDays =
      Array.isArray(workingDays) && workingDays.length > 0
        ? workingDays
        : (booking.workingDays as string[]);

    const extraDates = getWorkingDates(
      booking.scheduledEndTime,
      newEnd,
      extensionWorkingDays,
    );
    const extraDays =
      extraDates.length > 0 ? extraDates.length : DEFAULT_MONTHLY_WORKING_DAYS;

    const pricing = calcPricing({
      serviceType: booking.serviceType,
      hourlyRate: nanny.hourlyRate,
      dailyRate: nanny.dailyRate && nanny.dailyRate > 0 ? nanny.dailyRate : null,
      shiftStart: booking.scheduledStartTime,
      shiftEnd: booking.scheduledEndTime,
      workingDays: extraDays,
    });

    const extension = await prisma.bookingExtension.create({
      data: {
        bookingId,
        previousEndTime: booking.scheduledEndTime,
        newEndTime: newEnd,
        extraDays,
        workingDays: extensionWorkingDays,
        baseAmount: pricing.baseFee,
        gstAmount: pricing.gst,
        totalAmount: pricing.total,
        status: "PENDING_PAYMENT",
        pricingDetails: {
          sessionHours: pricing.sessionHours,
          workingDays: pricing.workingDays,
          baseFee: pricing.baseFee,
          platformFee: pricing.platformFee,
          gst: pricing.gst,
          total: pricing.total,
          description: pricing.description,
        },
      },
    });

    log.info(
      `[extendBooking] bookingId=${bookingId} extensionId=${extension.id}` +
        ` extraDays=${extraDays} total=₹${pricing.total}`,
    );
    return { extension, pricing };
  }

  // ── Called by event handler after extension payment is captured ──────────
  async handleExtensionPaymentCaptured(
    extensionId: string,
    paymentId?: string,
  ) {
    const extension = await prisma.bookingExtension.findUnique({
      where: { id: extensionId },
      include: { booking: true },
    });
    if (!extension || extension.status !== "PENDING_PAYMENT") return;

    const { booking } = extension;

    await prisma.$transaction([
      prisma.bookingExtension.update({
        where: { id: extensionId },
        data: { status: "CONFIRMED" },
      }),
      prisma.booking.update({
        where: { id: extension.bookingId },
        data: {
          scheduledEndTime: extension.newEndTime,
          timeline: appendTimeline(
            booking.timeline,
            booking.status,
            `Booking extended to ${extension.newEndTime.toDateString()} — payment confirmed`,
          ) as any,
        },
      }),
    ]);

    // Stretch the nanny's reserved slot to the new end time
    if (booking.nannyId) {
      await extendReservedSlot(
        booking.nannyId,
        extension.bookingId,
        extension.newEndTime,
      );
    }

    // Seed attendance records for the extended period
    try {
      const dates = getWorkingDates(
        extension.previousEndTime,
        extension.newEndTime,
        extension.workingDays as string[],
      );
      if (booking.nannyId) {
        await Promise.all(
          dates.map((scheduledDate) =>
            prisma.attendanceRecord.upsert({
              where: {
                bookingId_scheduledDate: {
                  bookingId: extension.bookingId,
                  scheduledDate,
                },
              },
              create: {
                bookingId: extension.bookingId,
                nannyId: booking.nannyId!,
                userId: booking.userId,
                scheduledDate,
                status: AttendanceStatus.PENDING,
              },
              update: {},
            }),
          ),
        );
      }
      log.info(
        `[handleExtensionPaymentCaptured] extensionId=${extensionId}` +
          ` paymentId=${paymentId} seeded=${dates.length} days`,
      );
    } catch (e) {
      log.error(
        `[handleExtensionPaymentCaptured] attendance seed failed extensionId=${extensionId}`,
        e,
      );
    }
  }
}
