import { Router, Request, Response, NextFunction } from 'express';
import { UserService } from '../services/user.service';
import { auth, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new UserService();

// All user routes require auth
router.use(auth);

// GET /api/v1/users/me
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getProfile(req.user!.userId))); } catch (e) { next(e); }
});

// PATCH /api/v1/users/me
router.patch('/me', validate(S.updateProfile), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.updateProfile(req.user!.userId, req.body), 'Profile updated')); } catch (e) { next(e); }
});

// POST 
router.post("/me/children", validate(S.addChild), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.addChild(req.user!.userId, req.body.children), 'Profile updated')); } catch (e) { next(e); }
});

// PATCH 
router.patch("/me/children/:childrenId", validate(S.addChild), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.updateChild(req.user!.userId, req.params.childrenId, req.body.children), 'Childrens data updated')); } catch (e) { next(e); }
});

// DELETE 
router.delete("/me/children/:childrenId", validate(S.addChild), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.deleteChild(req.user!.userId, req.params.childrenId), 'Childrens data deleted')); } catch (e) { next(e); }
});




// POST /api/v1/users/me/addresses
router.post('/me/addresses', validate(S.addAddress), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.addAddress(req.user!.userId, req.body);
    res.status(201).json({ success: true, message: 'Address added', data: result, statusCode: 201 });
  } catch (e) { next(e); }
});

// GET /api/v1/users/me/addresses
router.get('/me/addresses', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getAddresses(req.user!.userId))); } catch (e) { next(e); }
});

// PATCH /api/v1/users/me/addresses/:addressId
router.patch('/me/addresses/:addressId', validate(S.updateAddress), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.updateAddress(req.user!.userId, req.params.addressId, req.body), 'Address updated'));
  } catch (e) { next(e); }
});

// DELETE /api/v1/users/me/addresses/:addressId
router.delete('/me/addresses/:addressId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.deleteAddress(req.user!.userId, req.params.addressId);
    res.json(ok(null, 'Address deleted'));
  } catch (e) { next(e); }
});

// PUT /api/v1/users/me/emergency-contact
router.put('/me/emergency-contact', validate(S.emergencyContact), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.setEmergencyContact(req.user!.userId, req.body), 'Emergency contact updated'));
  } catch (e) { next(e); }
});

// POST /api/v1/users/me/device-token
router.post('/me/device-token', validate(S.deviceToken), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.registerDeviceToken(req.user!.userId, req.body.deviceToken, req.body.platform);
    res.json(ok(null, 'Device token registered'));
  } catch (e) { next(e); }
});

// POST /api/v1/users/me/togglePushNotification
router.post('/me/togglePushNotification', validate(S.deviceToken), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.togglePushNotification(req.user!.userId);
    res.json(ok(null, 'Push notification status updated successfully!'));
  } catch (e) { next(e); }
});

// POST /api/v1/users/me/toggleSmsNotification
router.post('/me/device-token', validate(S.deviceToken), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.toggleSmsNotification(req.user!.userId);
    res.json(ok(null, 'Sms notificaiton status updated successfully!'));
  } catch (e) { next(e); }
});

router.post('/me/updateEmail', validate(S.deviceToken), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.updateUserEmail(req.user!.userId, req.body.email);
    res.json(ok(null, 'Email Updated Successfully!'));
  } catch (e) { next(e); }
});

export { router as userRouter };
