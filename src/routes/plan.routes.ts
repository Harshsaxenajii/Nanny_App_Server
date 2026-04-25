/**
 * plan.routes.ts
 *
 * POST /api/v1/plan/generate/:bookingId   — trigger full AI plan generation
 *                                           (called once after booking confirmed)
 * POST /api/v1/plan/tasks/:bookingId      — manually trigger today's task generation
 *                                           (normally done by cron — useful for testing)
 * GET  /api/v1/plan/:bookingId            — get the master DailyPlan for a booking
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PlanService }                             from '../services/plan.service'
import { runDailyPlanJob }                         from '../jobs/dailyPlan.job';
import { auth, roles }                             from '../middlewares/index';
import { ok }                                      from '../utils/response';

const router      = Router();
const planService = new PlanService();

// router.use(auth);

// ── Generate master plan (once per booking) ───────────────────────────────────
// Called right after booking is confirmed and goals are set.
// In production this would be triggered by an event (booking.confirmed),
// but we expose it as an endpoint so it can be tested directly.

router.post(
  '/generate/:bookingId',
  // roles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await planService.generatePlan(req.params.bookingId);
      res.json(ok(plan, 'AI plan generated successfully'));
    } catch (e) { next(e); }
  },
);

// ── Manually trigger today's task generation ──────────────────────────────────
// Normally done by the cron at 05:00 AM IST.
// Exposed here so you can test without waiting for the cron.

router.post(
  '/tasks/:bookingId',
  // roles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tasks = await planService.generateDailyTasks(req.params.bookingId);
      res.json(ok(tasks, `${tasks.length} tasks generated for today`));
    } catch (e) { next(e); }
  },
);

// ── Get master DailyPlan for a booking ───────────────────────────────────────

router.get(
  '/:bookingId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { bookingId } = req.params;

      // Basic ownership check — admins see all, users/nannies see their own
      const plan = await planService['getDailyPlan'](bookingId, req.user!.userId, req.user!.role);
      res.json(ok(plan));
    } catch (e) { next(e); }
  },
);

// ── Trigger the full cron job manually (admin/testing only) ──────────────────

router.post(
  '/cron/run',
  roles('ADMIN', 'SUPER_ADMIN'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await runDailyPlanJob();
      res.json(ok(null, 'Daily plan cron job executed'));
    } catch (e) { next(e); }
  },
);

export { router as planRouter };
