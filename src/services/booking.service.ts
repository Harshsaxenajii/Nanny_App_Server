import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { bus, Events } from "../utils/eventBus";
import { calcPricing } from "../utils/pricing";
import { paginate, paginatedResult } from "../utils/response";
import { BookingStatus, NannyStatus } from "@prisma/client";
import { triggerAiPlanForBooking } from "./plan.service";
import { isSubscriptionBooking } from "../utils/goalTemplates";

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

export class BookingService {
  /* ── POST /api/v1/bookings ──────────────────────────────────────────── */
  async createBooking(userId: string, body: any) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("User not found", 404);

    const start = new Date(body.scheduledStartTime);
    const end = new Date(body.scheduledEndTime);

    if (end <= start)
      throw new AppError(
        "scheduledEndTime must be after scheduledStartTime",
        400,
      );
    if (start <= new Date())
      throw new AppError("scheduledStartTime must be in the future", 400);

    // ✅ Verify child exists and belongs to this user
    const child = await prisma.children.findUnique({
      where: { id: body.childrenId },
    });
    if (!child) throw new AppError("Child not found", 404);
    if (child.userId !== userId)
      throw new AppError("This child does not belong to your account", 403);

    let nannyId: string | null = null;
    let pricing = { baseAmount: 0, gstAmount: 0, totalAmount: 0, hours: 0 };

    if (body.nannyId) {
      const nanny = await prisma.nanny.findUnique({
        where: { id: body.nannyId },
      });
      if (!nanny) throw new AppError("The specified nanny was not found", 404);
      if (nanny.status !== NannyStatus.VERIFIED)
        throw new AppError(
          "This nanny is not currently verified and cannot accept bookings",
          400,
        );
      if (!nanny.isAvailable)
        throw new AppError("This nanny is currently not available", 400);
      if (!nanny.isActive)
        throw new AppError("This nanny account is not active", 400);
      if (!nanny.serviceTypes.includes(body.serviceType))
        throw new AppError(
          `This nanny does not offer ${body.serviceType}. Available: ${nanny.serviceTypes.join(", ")}`,
          400,
        );

      nannyId = nanny.id;
      pricing = calcPricing(nanny.hourlyRate, start, end);
    } else {
      pricing = calcPricing(200, start, end);
    }

    const addr = body.address;
    const coords = addr.coordinates?.coordinates;

    const requestedTasks = Array.isArray(body.requestedTasks)
      ? body.requestedTasks.map((task: string) => ({
          task,
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
        addressLabel: addr.label ?? null,
        addressLine1: addr.addressLine1,
        addressLine2: addr.addressLine2 ?? null,
        addressCity: addr.city,
        addressState: addr.state,
        addressPincode: addr.pincode,
        addressCountry: addr.country ?? "IN",
        addressLat: coords ? coords[1] : null,
        addressLng: coords ? coords[0] : null,
        baseAmount: pricing.baseAmount,
        gstAmount: pricing.gstAmount,
        totalAmount: pricing.totalAmount,
        status: BookingStatus.PENDING_PAYMENT,
        timeline: appendTimeline(
          [],
          BookingStatus.PENDING_PAYMENT,
          "Booking created, awaiting payment",
        ) as any,
      },
      include: {
        children: true, // ✅ return child details in response
      },
    });

    bus.emit(Events.BOOKING_CREATED, { bookingId: booking.id, userId });
    log.info(`Booking created: ${booking.id}`);

    return {
      ...booking,
      pricing: {
        hours: pricing.hours,
        baseAmount: pricing.baseAmount,
        gstAmount: pricing.gstAmount,
        totalAmount: pricing.totalAmount,
      },
    };
  }
  /* ── POST /api/v1/bookings/markTaskDone ───────────────────────────────────────────── */
  async markTaskDone(nannyUserId: string, bookingId: string, taskName: string) {
    // 1. Find the nanny profile
    const nanny = await prisma.nanny.findUnique({
      where: { userId: nannyUserId },
    });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    // 2. Find the booking
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    // 3. Verify this nanny owns this booking
    if (booking.nannyId !== nanny.id)
      throw new AppError("You are not assigned to this booking", 403);

    // 4. Booking must be in progress
    if (booking.status !== BookingStatus.IN_PROGRESS)
      throw new AppError(
        "Tasks can only be marked done when booking is in progress",
        400,
      );

    // 5. Update the specific task in the array
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

    // 6. Save back
    return prisma.booking.update({
      where: { id: bookingId },
      data: { requestedTasks: tasks },
    });
  }

  /* ── GET /api/v1/bookings ───────────────────────────────────────────── */
  async getMyBookings(userId: string, role: string, query: any) {
    const { page, limit, skip } = paginate(query);

    // Only known roles can fetch bookings
    if (!["USER", "NANNY", "ADMIN", "SUPER_ADMIN"].includes(role)) {
      throw new AppError("You do not have permission to view bookings", 403);
    }

    // For nannies, resolve their nanny profile to get the nannyId
    let nannyId: string | undefined;
    if (role === "NANNY") {
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      if (!nanny)
        throw new AppError(
          "Nanny profile not found. Please register as a nanny first.",
          404,
        );
      nannyId = nanny.id;
    }

    // Nannies see bookings assigned to them; users see bookings they created
    const where: any = role === "NANNY" && nannyId ? { nannyId } : { userId };

    // Validate status against BookingStatus enum — Prisma rejects plain strings
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
        throw new AppError(
          `Invalid status '${query.status}'. Must be one of: ${valid.join(", ")}`,
          400,
        );
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
        payment: true,
      },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    const isOwner = booking.userId === userId;
    let isNanny = false;

    if (!isOwner && !isAdmin) {
      // Check if caller is the assigned nanny
      const nanny = await prisma.nanny.findUnique({ where: { userId } });
      isNanny = !!nanny && booking.nannyId === nanny.id;
      if (!isNanny)
        throw new AppError("You do not have access to this booking", 403);
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

    // Edge case: already cancelled or completed
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

  /* ── PATCH /api/v1/bookings/:id/accept (nanny) ──────────────────────── */
  async acceptBooking(bookingId: string, userId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    // Edge case: nanny must be assigned to this booking
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    // Edge case: booking must be CONFIRMED (payment done) to accept
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
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    // Edge case: must be NANNY_ASSIGNED to start
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
    if (booking.nannyId !== nanny.id)
      throw new AppError("This booking is not assigned to you", 403);

    // Edge case: must be IN_PROGRESS to complete
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
      // Increment nanny total bookings count
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

    // Edge case: only the booking owner can review
    if (booking.userId !== userId)
      throw new AppError(
        "Only the user who made this booking can submit a review",
        403,
      );

    // Edge case: booking must be completed
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppError("You can only review a completed booking", 400);
    }

    // Edge case: only one review per booking
    if (booking.reviewRating !== null)
      throw new AppError(
        "A review has already been submitted for this booking",
        400,
      );

    // Edge case: must have an assigned nanny to review
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

    // Recalculate nanny's average rating
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
    if (!booking) return;
    if (booking.status !== BookingStatus.PENDING_PAYMENT) return; // already processed

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

    // Fire-and-forget AI trigger — only for subscription bookings (>= 30 days)
    if (isSubscriptionBooking(booking.scheduledStartTime, booking.scheduledEndTime)) {
      triggerAiPlanForBooking(bookingId).catch((err) => {
        log.error(`Background AI plan trigger failed for ${bookingId}: ${err.message}`);
      });
    }
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
        throw new AppError(
          `Invalid status '${query.status}'. Must be one of: ${valid.join(", ")}`,
          400,
        );
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
          children:true
        },
      }),
      prisma.booking.count({ where }),
    ]);
    console.log(bookings)
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
