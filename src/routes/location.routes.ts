import { Router, Request, Response, NextFunction } from 'express';
import { LocationService } from '../services/location.service';
import { auth, roles, validate } from '../middlewares/index';
import { S } from '../validators/index';
import { ok } from '../utils/response';

const router  = Router();
const service = new LocationService();

router.use(auth);

// PATCH /api/v1/location/nanny
router.patch('/nanny', roles('NANNY'), validate(S.updateLocation), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.updateMyLocation(req.user!.userId, req.body.latitude, req.body.longitude), 'Location updated'));
  } catch (e) { next(e); }
});

// GET /api/v1/location/nannies/nearby  ← MUST be before /nanny/:nannyId
router.get('/nannies/nearby', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat    = parseFloat(req.query.latitude  as string);
    const lng    = parseFloat(req.query.longitude as string);
    const radius = parseFloat(req.query.radius    as string) || 10;

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ success: false, message: 'latitude and longitude are required query parameters', statusCode: 400 });
      return;
    }
    res.json(ok(await service.findNearby(lat, lng, radius)));
  } catch (e) { next(e); }
});

// GET /api/v1/location/nanny/:nannyId
router.get('/nanny/:nannyId', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(ok(await service.getNannyLocation(req.params.nannyId))); } catch (e) { next(e); }
});

export { router as locationRouter };
