import { Router, Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/payment.service';
import { auth, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new PaymentService();

// POST /api/v1/payments/webhook  ← PUBLIC, raw body, before auth middleware
router.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sig = req.headers['x-razorpay-signature'] as string || '';
    await service.handleWebhook(req.body as string, sig);
    res.json({ received: true });
  } catch (e) { next(e); }
});

// All below require auth
router.use(auth);

// POST /api/v1/payments/order
router.post('/order', validate(S.createOrder), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.createOrder(req.user!.userId, req.body.bookingId);
    res.status(201).json({ success: true, message: 'Payment order created', data: result, statusCode: 201 });
  } catch (e) { next(e); }
});

// POST /api/v1/payments/verify
router.post('/verify', validate(S.verifyPayment), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.verifyPayment(req.user!.userId, req.body), 'Payment verified successfully'));
  } catch (e) { next(e); }
});

// GET /api/v1/payments/booking/:bookingId
router.get('/booking/:bookingId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.getPaymentByBooking(req.user!.userId, req.params.bookingId, req.user!.role)));
  } catch (e) { next(e); }
});

export { router as paymentRouter };
