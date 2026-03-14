import { Router, Request, Response, NextFunction } from 'express';
import { BookingService } from '../services/booking.service';
import { auth, roles, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new BookingService();

router.use(auth);

// POST /api/v1/bookings
router.post('/', roles('USER'), validate(S.createBooking), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.createBooking(req.user!.userId, req.body);
    res.status(201).json({ success: true, message: 'Booking created successfully', data: result, statusCode: 201 });
  } catch (e) { next(e); }
});

// GET /api/v1/bookings
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getMyBookings(req.user!.userId, req.user!.role, req.query))); } catch (e) { next(e); }
});

// GET /api/v1/bookings/:id  — must be after all /something routes
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getBookingById(req.params.id, req.user!.userId, req.user!.role))); } catch (e) { next(e); }
});

// PATCH /api/v1/bookings/:id/accept  (nanny accepts after payment confirms)
router.patch('/:id/accept', roles('NANNY'), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.acceptBooking(req.params.id, req.user!.userId), 'Booking accepted')); } catch (e) { next(e); }
});

// PATCH /api/v1/bookings/:id/start
router.patch('/:id/start', roles('NANNY'), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.startBooking(req.params.id, req.user!.userId), 'Booking started')); } catch (e) { next(e); }
});

// PATCH /api/v1/bookings/:id/complete
router.patch('/:id/complete', roles('NANNY'), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.completeBooking(req.params.id, req.user!.userId), 'Booking completed')); } catch (e) { next(e); }
});

// PATCH /api/v1/bookings/:id/cancel
router.patch('/:id/cancel', validate(S.cancelBooking), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.cancelBooking(req.params.id, req.user!.userId, req.user!.role, req.body.reason), 'Booking cancelled'));
  } catch (e) { next(e); }
});

// POST /api/v1/bookings/:id/review
router.post('/:id/review', roles('USER'), validate(S.review), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.submitReview(req.params.id, req.user!.userId, req.body.rating, req.body.comment), 'Review submitted'));
  } catch (e) { next(e); }
});

export { router as bookingRouter };
