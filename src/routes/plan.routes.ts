/**
 * plan.routes.ts
 *
 * Cron routes (GET) — called by cron-job.org with Authorization: Bearer CRON_SECRET
 *   GET  /api/v1/plan/cron/midnight  — generate master plans for new bookings
 *   GET  /api/v1/plan/cron/morning   — assess yesterday + generate today's tasks
 *   GET  /api/v1/plan/cron/monthly   — generate monthly summaries
 *
 * Admin routes (POST) — require ADMIN/SUPER_ADMIN JWT (manual testing)
 *   POST /api/v1/plan/generate/:bookingId
 *   POST /api/v1/plan/tasks/:bookingId
 *   POST /api/v1/plan/cron/midnight
 *   POST /api/v1/plan/cron/morning
 *   POST /api/v1/plan/cron/monthly
 *
 * User/Nanny route
 *   GET  /api/v1/plan/:bookingId     — get DailyPlan + today's tasks
 */

import { Router, Request, Response, NextFunction } from "express";
import { PlanService }        from "../services/plan.service";
import { runMidnightPlanJob, runMorningTaskJob, runMonthlySummaryJob } from "../jobs/dailyPlan.job";
import { auth, roles }        from "../middlewares/index";
import { ok }                 from "../utils/response";

const router      = Router();
const planService = new PlanService();

// ── Cron secret middleware ────────────────────────────────────────────────────
// Verifies Authorization: Bearer <CRON_SECRET> sent by cron-job.org.
// If CRON_SECRET is not set the check is skipped (local dev convenience).
function verifyCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) { next(); return; }

  const authHeader = req.headers.authorization ?? "";
  if (authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  next();
}

// ── GET cron routes — NO user auth, only CRON_SECRET ─────────────────────────
// These must be declared BEFORE router.use(auth) so they bypass JWT auth.

router.get(
  "/cron/midnight",
  verifyCronSecret,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runMidnightPlanJob();
      res.json(ok(null, "Midnight plan job executed"));
    } catch (e) { next(e); }
  },
);

router.get(
  "/cron/morning",
  verifyCronSecret,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runMorningTaskJob();
      res.json(ok(null, "Morning task job executed"));
    } catch (e) { next(e); }
  },
);

router.get(
  "/cron/monthly",
  verifyCronSecret,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runMonthlySummaryJob();
      res.json(ok(null, "Monthly summary job executed"));
    } catch (e) { next(e); }
  },
);

// ── All routes below require JWT auth ─────────────────────────────────────────
router.use(auth);

// ── Generate master plan for a booking (admin, once only) ────────────────────
router.post(
  "/generate/:bookingId",
  roles("ADMIN", "SUPER_ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await planService.generatePlan(req.params.bookingId);
      res.json(ok(plan, "Master AI plan generated"));
    } catch (e) { next(e); }
  },
);

// ── Generate today's tasks for a booking (admin) ─────────────────────────────
router.post(
  "/tasks/:bookingId",
  roles("ADMIN", "SUPER_ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tasks = await planService.generateDailyTasks(req.params.bookingId);
      res.json(ok(tasks, `${tasks.length} tasks generated for today`));
    } catch (e) { next(e); }
  },
);

// ── Get DailyPlan + today's tasks (user or nanny) ────────────────────────────
router.get(
  "/:bookingId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await planService.getDailyPlan(
        req.params.bookingId,
        req.user!.userId,
        req.user!.role,
      );
      res.json(ok(plan));
    } catch (e) { next(e); }
  },
);

// ── POST cron triggers — admin JWT required (manual testing via Postman) ──────
router.post(
  "/cron/midnight",
  roles("ADMIN", "SUPER_ADMIN"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runMidnightPlanJob();
      res.json(ok(null, "Midnight plan job executed"));
    } catch (e) { next(e); }
  },
);

router.post(
  "/cron/morning",
  roles("ADMIN", "SUPER_ADMIN"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runMorningTaskJob();
      res.json(ok(null, "Morning task job executed"));
    } catch (e) { next(e); }
  },
);

router.post(
  "/cron/monthly",
  roles("ADMIN", "SUPER_ADMIN"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runMonthlySummaryJob();
      res.json(ok(null, "Monthly summary job executed"));
    } catch (e) { next(e); }
  },
);

export { router as planRouter };
