import { Router, Request, Response, NextFunction } from 'express';
import { AdminService } from '../services/admin.service';
import { BookingService } from '../services/booking.service';
import { PaymentService } from '../services/payment.service';
import { auth, roles, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router   = Router();
const admin    = new AdminService();
const booking  = new BookingService();
const payment  = new PaymentService();

// All admin routes require auth + ADMIN or SUPER_ADMIN role
router.use(auth, roles('ADMIN', 'SUPER_ADMIN'));

// GET /api/v1/admin/dashboard
router.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.getDashboard())); } catch (e) { next(e); }
});

router.get('/getAllUsers', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.getAllUsers(req.query))); } catch (e) { next(e); }
});

// GET /api/v1/admin/nannies/pending  ← MUST be before /nannies/:id
router.get('/nannies/pending', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.getPendingNannies(req.query))); } catch (e) { next(e); }
});

// GET /api/v1/admin/nannies/all  ← MUST be before /nannies/all
router.get('/nannies/getAllNannies', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.getAllNannies(req.query))); } catch (e) { next(e); }
});

// GET /api/v1/admin/nannies/:id
router.get('/nannies/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.getNannyDetail(req.params.id))); } catch (e) { next(e); }
});

// POST /api/v1/admin/nannies/:id/verify
router.post('/nannies/:id/verify', validate(S.verifyNanny), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.verifyNanny(req.params.id, req.user!.userId, req.body.notes), 'Nanny verified')); } catch (e) { next(e); }
});

// POST /api/v1/admin/nannies/:id/reject
router.post('/nannies/:id/reject', validate(S.rejectNanny), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.rejectNanny(req.params.id, req.user!.userId, req.body.reason), 'Nanny rejected')); } catch (e) { next(e); }
});

// PATCH /api/v1/admin/nannies/:id/training
router.patch('/nannies/:id/training', validate(S.training), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await admin.updateTraining(req.params.id, req.user!.userId, req.body.isTrainingCompleted, req.body.notes), 'Training status updated'));
  } catch (e) { next(e); }
});

// POST /api/v1/admin/nannies/:id/suspend
router.post('/nannies/:id/suspend', validate(S.suspendNanny), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.suspendNanny(req.params.id, req.user!.userId, req.body.reason), 'Nanny suspended')); } catch (e) { next(e); }
});

// GET /api/v1/admin/bookings
router.get('/bookings', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await booking.getAllBookingsAdmin(req.query))); } catch (e) { next(e); }
});

// POST /api/v1/admin/bookings/:id/cancel
router.post('/bookings/:id/cancel', validate(S.adminCancel), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await booking.adminCancelBooking(req.params.id, req.user!.userId, req.body.reason), 'Booking cancelled'));
  } catch (e) { next(e); }
});

// POST /api/v1/admin/payments/:paymentId/refund
router.post('/payments/:paymentId/refund', validate(S.refund), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await payment.processRefund(req.params.paymentId, req.user!.userId, req.body.amount, req.body.reason), 'Refund processed'));
  } catch (e) { next(e); }
});

// GET /api/v1/admin/audit-logs
router.get('/audit-logs', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await admin.getAuditLogs(req.query))); } catch (e) { next(e); }
});

export { router as adminRouter };
