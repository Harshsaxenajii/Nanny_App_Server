/**
 * seed.routes.ts
 *
 * POST /api/v1/seed   — creates a test booking with goals so the AI pipeline can be tested.
 *                       Disabled in production.
 *
 * After calling this, test the full pipeline:
 *   POST /api/v1/plan/generate/:bookingId   → generates master DailyPlan
 *   GET  /api/v1/goals/plan/:bookingId/today → nanny sees today's tasks
 */

import { Router, Request, Response } from 'express';
import { SeedService }               from '../services/seed.service';

const router      = Router();
const seedService = new SeedService();

router.post('/', async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, message: 'Seed is disabled in production' });
  }

  try {
    const result = await seedService.seedTestBooking();
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export { router as seedRouter };
