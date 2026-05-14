import { Router, Request, Response, NextFunction } from "express";
import { BookingService } from "../services/booking.service";
import { auth, roles, validate } from "../middlewares/index";
import { S } from "../validators/index";
import { ok } from "../utils/response";

const router = Router();
const service = new BookingService();

// All booking routes require authentication
router.use(auth);

// ── POST /api/v1/bookings/:id/requested-plan ─────────────────────────────────
// Parent adds/updates the requested daily plan for a booking.
// Creates one RequestedDayWiseDailyPlan (with the given date) and one
// RequestedDailyPlan under it containing all tasks. Each call is a new entry
// so history is preserved; the frontend should send the full desired task list.
router.post(
  "/:id/requested-plan",
  roles("USER"),
  validate(S.addRequestedPlan),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.addRequestedPlan(
        req.params.id,
        req.user!.userId,
        req.body.date,
        req.body.tasks,
      );
      res.status(201).json({
        success: true,
        message: "Requested plan added",
        data: result,
        statusCode: 201,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── POST /api/v1/bookings/:id/extend ─────────────────────────────────────────
// Parent requests a booking extension (FULL_TIME / PART_TIME only).
// Returns the extension record + pricing. Follow up with
// POST /api/v1/payments/extension/order to create the Razorpay order.
router.post(
  "/:id/extend",
  roles("USER"),
  validate(S.extendBooking),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      console.log("payload in booking for extend: ",req.body)
      const result = await service.extendBooking(
        req.params.id,
        req.user!.userId,
        req.body.newEndDate,
        req.body.workingDays,
        req.body.updatedTasks,
        req.body.updatedGoals,
        req.body.lunch,
        req.body.specialInstructions,
        req.body.couponCode,
      );
      res.status(201).json({
        success: true,
        message: "Extension created — proceed to payment",
        data: result,
        statusCode: 201,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── POST /api/v1/bookings ────────────────────────────────────────────────────
// Parent creates a booking
router.post(
  "/",
  roles("USER"),
  validate(S.createBooking),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.createBooking(req.user!.userId, req.body);
      res.status(201).json({
        success: true,
        message: "Booking created successfully",
        data: result,
        statusCode: 201,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── GET /api/v1/bookings ─────────────────────────────────────────────────────
// List bookings for the calling user (USER sees their own, NANNY sees assigned)
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(
      ok(
        await service.getMyBookings(
          req.user!.userId,
          req.user!.role,
          req.query,
        ),
      ),
    );
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: All routes with a literal path segment AFTER the base (e.g. /:id/xxx)
// must be defined BEFORE the bare /:id GET to prevent the literal segment
// from being swallowed as the :id param.
// ─────────────────────────────────────────────────────────────────────────────

// ── PATCH /api/v1/bookings/:bookingId/tasks/:taskName/done ───────────────────
// Marks a parent-requested simple task (from requestedTasks[]) as done.
// taskName is URL-encoded, e.g. "Breakfast%20and%20hygiene%20..."
router.patch(
  "/:bookingId/tasks/:taskName/done",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.markTaskDone(
        req.user!.userId,
        req.params.bookingId,
        decodeURIComponent(req.params.taskName),
      );
      res.json({
        success: true,
        message: "Task marked as done",
        data: result,
        statusCode: 200,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── PATCH /api/v1/bookings/:id/daily-plan/task/:taskId ───────────────────────
// Updates the status of an AI-generated PlanTask (COMPLETED | SKIPPED).
// Body: { status: "COMPLETED" | "SKIPPED", notes?: string }
router.patch(
  "/:id/daily-plan/task/:taskId",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.updatePlanTask(
        req.user!.userId,
        req.params.id,
        req.params.taskId,
        req.body,
      );
      res.json({
        success: true,
        message: "Task updated",
        data: result,
        statusCode: 200,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  "/:id/requested-plan/task/:taskId",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.updateReqestedTask(
        req.user!.userId,
        req.params.id,
        req.params.taskId,
        req.body,
      );
      res.json({
        success: true,
        message: "Task updated",
        data: result,
        statusCode: 200,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── PATCH /api/v1/bookings/:id/accept ────────────────────────────────────────
// Nanny accepts a booking after payment is confirmed (CONFIRMED → NANNY_ASSIGNED)
router.patch(
  "/:id/accept",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.acceptBooking(req.params.id, req.user!.userId),
          "Booking accepted",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  "/:id/confirm",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.confirmBooking(req.params.id, req.user!.userId),
          "Booking confirmed",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

// ── PATCH /api/v1/bookings/:id/start ─────────────────────────────────────────
// Nanny clocks in.
// Single-day: NANNY_ASSIGNED → IN_PROGRESS
// Range:      CONFIRMED | NANNY_ASSIGNED | IN_PROGRESS → IN_PROGRESS (daily clock-in)
router.patch(
  "/:id/start",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.startBooking(req.params.id, req.user!.userId),
          "Clocked in successfully",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

// ── PATCH /api/v1/bookings/:id/complete ──────────────────────────────────────
// Nanny clocks out.
// Single-day: IN_PROGRESS → COMPLETED immediately
// Range:      IN_PROGRESS → COMPLETED (on final day) or stays IN_PROGRESS (daily clock-out)
router.patch(
  "/:id/complete",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.completeBooking(
        req.params.id,
        req.user!.userId,
      );
      const msg = result.attendance.isFinalDay
        ? "Engagement completed — great work!"
        : "Clocked out for today — see you tomorrow!";
      res.json(ok(result, msg));
    } catch (e) {
      next(e);
    }
  },
);

// ── PATCH /api/v1/bookings/:id/cancel ────────────────────────────────────────
// Any participant (USER / NANNY / ADMIN) can cancel with a reason.
router.patch(
  "/:id/cancel",
  validate(S.cancelBooking),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.cancelBooking(
            req.params.id,
            req.user!.userId,
            req.user!.role,
            req.body.reason,
          ),
          "Booking cancelled",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

// ── GET /api/v1/bookings/:id/tasks ───────────────────────────────────────────
router.get(
  "/:id/tasks",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(ok(await service.getBookingTasks(req.params.id, req.user!.userId, req.user!.role)));
    } catch (e) {
      next(e);
    }
  },
);

// ── PATCH /api/v1/bookings/:id/tasks ─────────────────────────────────────────
router.patch(
  "/:id/tasks",
  roles("USER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(ok(await service.updateBookingTasks(req.params.id, req.user!.userId, req.body.tasks), "Tasks updated"));
    } catch (e) {
      next(e);
    }
  },
);

// ── GET /api/v1/bookings/:id/attendance ──────────────────────────────────────
// Returns all attendance records + summary for a booking.
// Accessible by: the parent (USER), the assigned nanny, or ADMIN / SUPER_ADMIN.
router.get(
  "/:id/attendance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.getBookingAttendance(
            req.params.id,
            req.user!.userId,
            req.user!.role,
          ),
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

// ── POST /api/v1/bookings/:id/review ─────────────────────────────────────────
// Parent submits a review after the booking is COMPLETED.
router.post(
  "/:id/review",
  roles("USER"),
  validate(S.review),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.submitReview(
            req.params.id,
            req.user!.userId,
            req.body.rating,
            req.body.comment,
          ),
          "Review submitted",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

// ── GET /api/v1/bookings/me/active-shift ─────────────────────────────────────
// Must be BEFORE /:id to prevent "me" being matched as an id param.
router.get(
  "/me/active-shift",
  roles("NANNY"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.getActiveShift(req.user!.userId);
      res.json({
        success: true,
        message: result ? "Active shift found" : "No active shift",
        data: result,
        statusCode: 200,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/me/live-status",
  roles("USER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.getUserLiveStatus(req.user!.userId);
      res.json({
        success: true,
        message: result ? "Live session active" : "No active session",
        data: result,
        statusCode: 200,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── GET /api/v1/bookings/:id ─────────────────────────────────────────────────
// Must be LAST among /:id routes to avoid matching literal segments above.
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(
      ok(
        await service.getBookingById(
          req.params.id,
          req.user!.userId,
          req.user!.role,
        ),
      ),
    );
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/reject", auth, roles("NANNY"), async (req, res, next) => {
  try {
    const result = await service.rejectBooking(
      req.params.id,
      req.user!.userId,
      req.body.reason,
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export { router as bookingRouter };
