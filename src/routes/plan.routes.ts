/**
 * plan.routes.ts
 *
 * POST /api/v1/plan/generate/:bookingId   — manually trigger generatePlan (testing)
 * POST /api/v1/plan/tasks/:bookingId      — manually trigger generateDailyTasks (testing)
 * GET  /api/v1/plan/:bookingId            — get DailyPlan + today's tasks
 * POST /api/v1/plan/cron/midnight         — manually trigger midnight job (testing)
 * POST /api/v1/plan/cron/morning          — manually trigger 5am job (testing)
 * POST /api/v1/plan/cron/weekly           — manually trigger weekly summary + purge job (testing)
 */

import { Router, Request, Response, NextFunction } from "express";
import { PlanService }                             from "../services/plan.service";
import { runMidnightPlanJob, runMorningTaskJob, runWeeklySummaryJob } from "../jobs/dailyPlan.job";
import { auth, roles }                             from "../middlewares/index";
import { ok }                                      from "../utils/response";

const router      = Router();
const planService = new PlanService();

router.use(auth);

// ── Generate master plan for a booking (once only) ────────────────────────
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

// ── Generate today's tasks for a booking ─────────────────────────────────
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

// ── Get DailyPlan + today's tasks ─────────────────────────────────────────
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

// ── Manually trigger midnight cron (testing only) ─────────────────────────
// Simulates 12:00 AM — generates master plans for bookings starting today
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

// ── Manually trigger 5am cron (testing only) ──────────────────────────────
// Simulates 5:00 AM — generates daily tasks for all active bookings
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

// ── Manually trigger weekly summary + purge job (testing only) ───────────────
// Summarises the PREVIOUS ISO week for all children; purges stale PlanTask records
router.post(
  "/cron/weekly",
  roles("ADMIN", "SUPER_ADMIN"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runWeeklySummaryJob();
      res.json(ok(null, "Weekly summary job executed"));
    } catch (e) { next(e); }
  },
);

export { router as planRouter };