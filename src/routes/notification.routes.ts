import { Router, Request, Response, NextFunction } from 'express';
import { NotificationService } from '../services/notification.service';
import { auth } from '../middlewares/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new NotificationService();

router.use(auth);

// GET /api/v1/notifications
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getMyNotifications(req.user!.userId, req.query))); } catch (e) { next(e); }
});

// PATCH /api/v1/notifications/read-all  ← MUST be before /:id to avoid route conflict
router.patch('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.markAllAsRead(req.user!.userId), 'All notifications marked as read'));
  } catch (e) { next(e); }
});

// PATCH /api/v1/notifications/:notificationId/read
router.patch('/:notificationId/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.markAsRead(req.user!.userId, req.params.notificationId), 'Notification marked as read'));
  } catch (e) { next(e); }
});

export { router as notificationRouter };
