import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthService } from '../services/auth.service';
import { auth, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new AuthService();

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5,
  message: { success: false, message: 'Too many OTP requests. Please wait 10 minutes.', statusCode: 429 },
  skip: () => process.env.NODE_ENV !== 'production',
});

// POST /api/v1/auth/otp/request
router.post('/otp/request', otpLimiter, validate(S.otpRequest), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.requestOtp(req.body.mobile, req.body.countryCode);
    res.json(ok(result, 'OTP sent successfully'));
  } catch (e) { next(e); }
});

// POST /api/v1/auth/otp/verify
router.post('/otp/verify', validate(S.otpVerify), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { mobile, countryCode, otp } = req.body;
    const result = await service.verifyOtp(mobile, countryCode, otp);
    res.json(ok(result, 'Login successful'));
  } catch (e) { next(e); }
});

// POST /api/v1/auth/token/refresh
router.post('/token/refresh', validate(S.refreshToken), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.refreshToken(req.body.refreshToken);
    res.json(ok(result, 'Token refreshed'));
  } catch (e) { next(e); }
});

// POST /api/v1/auth/logout
router.post('/logout', validate(S.logout), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.logout(req.body.refreshToken);
    res.json(ok(null, 'Logged out successfully'));
  } catch (e) { next(e); }
});

export { router as authRouter };
