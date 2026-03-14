import { Router, Request, Response, NextFunction } from 'express';
import { NannyService } from '../services/nanny.service';
import { auth, roles, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new NannyService();

// POST /api/v1/nannies/register  ← PUBLIC (no auth header in Postman)
router.post('/register', validate(S.nannyRegister), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.register(req.body);
    res.status(201).json({ success: true, message: 'Nanny registered successfully. Awaiting verification.', data: result, statusCode: 201 });
  } catch (e) { next(e); }
});

// GET /api/v1/nannies/search  ← PUBLIC
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.search(req.query))); } catch (e) { next(e); }
});

// ── All routes below require auth ──────────────────────────────────────────

// PATCH /api/v1/nannies/me  ← MUST be before /:id to avoid route conflict
router.patch('/me', auth, roles('NANNY'), validate(S.nannyUpdate), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.updateMyProfile(req.user!.userId, req.body), 'Profile updated')); } catch (e) { next(e); }
});

// PATCH /api/v1/nannies/me/availability
router.patch('/me/availability', auth, roles('NANNY'), validate(S.availability), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.setAvailability(req.user!.userId, req.body.isAvailable), 'Availability updated'));
  } catch (e) { next(e); }
});

// GET /api/v1/nannies/me/bookings
router.get('/me/bookings', auth, roles('NANNY'), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getMyBookings(req.user!.userId, req.query))); } catch (e) { next(e); }
});

// GET /api/v1/nannies/:id  ← PUBLIC (must be last to avoid consuming /me routes)
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getPublicProfile(req.params.id))); } catch (e) { next(e); }
});

export { router as nannyRouter };
