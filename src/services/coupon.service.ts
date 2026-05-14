import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";

export class CouponService {
  async getAll() {
    return prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
  }

  async getActive() {
    return prisma.coupon.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(data: { code: string; label: string; discountPct: number }) {
    const code = data.code.toUpperCase().trim();
    const existing = await prisma.coupon.findUnique({ where: { code } });
    if (existing) throw new AppError("Coupon code already exists", 409);
    if (data.discountPct <= 0 || data.discountPct >= 1)
      throw new AppError("discountPct must be between 0 and 1 (exclusive)", 400);
    return prisma.coupon.create({
      data: { code, label: data.label.trim(), discountPct: data.discountPct },
    });
  }

  async update(
    id: string,
    data: Partial<{ label: string; discountPct: number; isActive: boolean }>,
  ) {
    const coupon = await prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new AppError("Coupon not found", 404);
    if (
      data.discountPct !== undefined &&
      (data.discountPct <= 0 || data.discountPct >= 1)
    )
      throw new AppError("discountPct must be between 0 and 1 (exclusive)", 400);
    return prisma.coupon.update({ where: { id }, data });
  }

  async remove(id: string) {
    const coupon = await prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new AppError("Coupon not found", 404);
    await prisma.coupon.delete({ where: { id } });
  }

  async validateCode(
    code: string,
  ): Promise<{ valid: boolean; discountPct?: number; label?: string }> {
    if (!code) return { valid: false };
    const coupon = await prisma.coupon.findUnique({
      where: { code: code.toUpperCase().trim() },
    });
    if (!coupon || !coupon.isActive) return { valid: false };
    return { valid: true, discountPct: coupon.discountPct, label: coupon.label };
  }
}
