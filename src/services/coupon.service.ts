import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";

export class CouponService {
  async getAll() {
    return (prisma as any).coupon.findMany({ orderBy: { createdAt: "desc" } });
  }

  async getActive() {
    return (prisma as any).coupon.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }

  // Returns active coupons enriched with per-user usage status.
  // First-time-only coupons already used by the user are marked isUsedByUser=true.
  async getActiveCouponsForUser(userId: string) {
    const coupons: any[] = await (prisma as any).coupon.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
    if (!coupons.length) return [];

    const firstTimeCouponIds = coupons
      .filter((c) => c.isFirstTimeOnly)
      .map((c) => c.id);

    let usedSet = new Set<string>();
    if (firstTimeCouponIds.length > 0) {
      const usages: any[] = await (prisma as any).couponUsage.findMany({
        where: { userId, couponId: { in: firstTimeCouponIds } },
        select: { couponId: true },
      });
      usedSet = new Set(usages.map((u: any) => u.couponId));
    }

    return coupons.map((c) => ({
      ...c,
      isUsedByUser: c.isFirstTimeOnly ? usedSet.has(c.id) : false,
    }));
  }

  async create(data: {
    code: string;
    label: string;
    discountPct: number;
    isFirstTimeOnly?: boolean;
  }) {
    const code = data.code.toUpperCase().trim();
    const existing = await (prisma as any).coupon.findUnique({ where: { code } });
    if (existing) throw new AppError("Coupon code already exists", 409);
    if (data.discountPct <= 0 || data.discountPct >= 1)
      throw new AppError("discountPct must be between 0 and 1 (exclusive)", 400);
    return (prisma as any).coupon.create({
      data: {
        code,
        label: data.label.trim(),
        discountPct: data.discountPct,
        isFirstTimeOnly: data.isFirstTimeOnly ?? false,
      },
    });
  }

  async update(
    id: string,
    data: Partial<{
      label: string;
      discountPct: number;
      isActive: boolean;
      isFirstTimeOnly: boolean;
    }>,
  ) {
    const coupon = await (prisma as any).coupon.findUnique({ where: { id } });
    if (!coupon) throw new AppError("Coupon not found", 404);
    if (
      data.discountPct !== undefined &&
      (data.discountPct <= 0 || data.discountPct >= 1)
    )
      throw new AppError("discountPct must be between 0 and 1 (exclusive)", 400);
    return (prisma as any).coupon.update({ where: { id }, data });
  }

  async remove(id: string) {
    const coupon = await (prisma as any).coupon.findUnique({ where: { id } });
    if (!coupon) throw new AppError("Coupon not found", 404);
    await (prisma as any).coupon.delete({ where: { id } });
  }

  async validateCode(
    code: string,
    userId?: string,
  ): Promise<{
    valid: boolean;
    discountPct?: number;
    label?: string;
    isFirstTimeOnly?: boolean;
  }> {
    if (!code) return { valid: false };
    const coupon = await (prisma as any).coupon.findUnique({
      where: { code: code.toUpperCase().trim() },
    });
    if (!coupon || !coupon.isActive) return { valid: false };

    // Single-use enforcement for first-time coupons
    if (coupon.isFirstTimeOnly && userId) {
      const existing = await (prisma as any).couponUsage.findFirst({
        where: { userId, couponId: coupon.id },
      });
      if (existing)
        return { valid: false }; // already used
    }

    return {
      valid: true,
      discountPct: coupon.discountPct,
      label: coupon.label,
      isFirstTimeOnly: coupon.isFirstTimeOnly ?? false,
    };
  }

  // Record that a user consumed a first-time-only coupon.
  // No-op for regular (multi-use) coupons.
  async recordUsage(
    userId: string,
    couponCode: string,
    bookingId?: string,
  ): Promise<void> {
    const coupon = await (prisma as any).coupon.findUnique({
      where: { code: couponCode.toUpperCase().trim() },
    });
    if (!coupon || !coupon.isFirstTimeOnly) return;

    // Guard against duplicate records (idempotent)
    const existing = await (prisma as any).couponUsage.findFirst({
      where: { userId, couponId: coupon.id },
    });
    if (existing) return;

    await (prisma as any).couponUsage.create({
      data: {
        userId,
        couponId: coupon.id,
        couponCode: coupon.code,
        bookingId: bookingId ?? null,
      },
    });
  }
}
