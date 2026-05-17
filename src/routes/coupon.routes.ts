import { Router, Request, Response, NextFunction } from "express";
import { CouponService } from "../services/coupon.service";
import { auth, roles } from "../middlewares/index";
import { ok } from "../utils/response";

const router = Router();
const service = new CouponService();

// GET /api/v1/coupons — public, returns only active coupons (no per-user status)
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.getActive()));
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/coupons/me — authenticated user, returns active coupons with usage status
router.get("/me", auth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.getActiveCouponsForUser(req.user!.userId)));
  } catch (e) {
    next(e);
  }
});

// Admin-only routes below
router.use(auth, roles("ADMIN", "SUPER_ADMIN"));

// GET /api/v1/coupons/all — admin only, returns ALL coupons including inactive
router.get("/all", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.getAll()));
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/coupons
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(ok(await service.create(req.body), "Coupon created"));
  } catch (e) {
    next(e);
  }
});

// PATCH /api/v1/coupons/:id
router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(ok(await service.update(req.params.id, req.body), "Coupon updated"));
  } catch (e) {
    next(e);
  }
});

// DELETE /api/v1/coupons/:id
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.remove(req.params.id);
    res.json(ok(null, "Coupon deleted"));
  } catch (e) {
    next(e);
  }
});

export { router as couponRouter };
