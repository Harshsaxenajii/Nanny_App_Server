/**
 * goal.routes.ts
 *
 * GET  /api/v1/goals                          — all templates (frontend carousel)
 * GET  /api/v1/goals?ageMonths=X              — template for a specific age
 * GET  /api/v1/goals/child/:childId           — ChildGoals for a child
 * GET  /api/v1/goals/booking/:bookingId       — ChildGoals for a booking
 * GET  /api/v1/goals/plan/:bookingId/today    — today's PlanTasks (nanny dashboard)
 * PATCH /api/v1/goals/tasks/:taskId/log       — nanny submits task log
 */

import { Router, Request, Response, NextFunction } from 'express';
import { GoalService }                             from '../services/goal.service';
import { auth, roles }                             from '../middlewares/index';
import { ok }                                      from '../utils/response';

const router  = Router();
const service = new GoalService();

router.use(auth);

// ── Templates (no role restriction — USER + NANNY both need these) ────────────

// GET /api/v1/goals?ageMonths=8
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const ageMonths = req.query.ageMonths
      ? parseInt(req.query.ageMonths as string, 10)
      : undefined;
    res.json(ok(service.getTemplates(ageMonths)));
  } catch (e) { next(e); }
});

// ── Child goals ───────────────────────────────────────────────────────────────

// GET /api/v1/goals/child/:childId
router.get('/child/:childId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(
      ok(await service.getChildGoals(
        req.params.childId,
        req.user!.userId,
        req.user!.role,
      )),
    );
  } catch (e) { next(e); }
});

// GET /api/v1/goals/booking/:bookingId
router.get('/booking/:bookingId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(
      ok(await service.getBookingGoals(
        req.params.bookingId,
        req.user!.userId,
        req.user!.role,
      )),
    );
  } catch (e) { next(e); }
});

// ── Nanny dashboard ───────────────────────────────────────────────────────────

// GET /api/v1/goals/plan/:bookingId/today
router.get(
  '/plan/:bookingId/today',
  roles('NANNY'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(await service.getTodaysTasks(req.params.bookingId, req.user!.userId)),
      );
    } catch (e) { next(e); }
  },
);

// PATCH /api/v1/goals/tasks/:taskId/log
router.patch(
  '/tasks/:taskId/log',
  roles('NANNY'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.submitTaskLog(
            req.params.taskId,
            req.user!.userId,
            req.body,
          ),
          'Task log submitted',
        ),
      );
    } catch (e) { next(e); }
  },
);

export { router as goalRouter };
