import { Router, Request, Response, NextFunction } from 'express';
import { ChatService } from '../services/chat.service';
import { auth, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new ChatService();

router.use(auth);

// POST /api/v1/chat/rooms
router.post('/rooms', validate(S.createRoom), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.getOrCreateRoom(req.user!.userId, req.body.bookingId);
    res.json(ok(result, 'Chat room ready'));
  } catch (e) { next(e); }
});

// GET /api/v1/chat/rooms
router.get('/rooms', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getMyRooms(req.user!.userId))); } catch (e) { next(e); }
});

// GET /api/v1/chat/rooms/:roomId/messages
router.get('/rooms/:roomId/messages', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getMessages(req.user!.userId, req.params.roomId, req.query))); } catch (e) { next(e); }
});

// POST /api/v1/chat/rooms/:roomId/messages
router.post('/rooms/:roomId/messages', validate(S.sendMessage), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, type, mediaUrl } = req.body;
    const result = await service.sendMessage(req.user!.userId, req.params.roomId, content, type, mediaUrl);
    res.status(201).json({ success: true, message: 'Message sent', data: result, statusCode: 201 });
  } catch (e) { next(e); }
});

// PATCH /api/v1/chat/rooms/:roomId/read
router.patch('/rooms/:roomId/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.markAsRead(req.user!.userId, req.params.roomId);
    res.json(ok(null, 'Messages marked as read'));
  } catch (e) { next(e); }
});

export { router as chatRouter };
