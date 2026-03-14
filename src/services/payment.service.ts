import crypto, { KeyObject } from "crypto";
import { prisma } from "../config/prisma";
import { config } from "../config";
import { AppError } from "../utils/AppError";
import { bus, Events } from "../utils/eventBus";
import { createLogger } from "../utils/logger";
import { BookingStatus } from "@prisma/client";

const log = createLogger("payment");

export class PaymentService {
  /* ── POST /api/v1/payments/order ────────────────────────────────────── */
  async createOrder(userId: string, bookingId: string) {
    // Edge case: booking must exist
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    // Edge case: only the booking owner can pay
    if (booking.userId !== userId)
      throw new AppError("You do not have access to this booking", 403);

    // Edge case: booking must be in PENDING_PAYMENT state
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new AppError(
        `Payment cannot be initiated for a booking in status: ${booking.status}`,
        400,
      );
    }

    // Edge case: check if payment record already exists
    const existingPayment = await prisma.payment.findUnique({
      where: { bookingId },
    });
    if (existingPayment && existingPayment.status === "CAPTURED") {
      throw new AppError("Payment already captured for this booking", 400);
    }

    console.log(config.razorpay.keyId, "->", config.razorpay.keySecret);

    // ── Dev mode — no Razorpay configured ─────────────────────────────
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      log.warn("[DEV] Razorpay not configured — auto-confirming booking");

      // Create a dev payment record
      await prisma.payment.upsert({
        where: { bookingId },
        create: {
          bookingId,
          userId,
          amount: booking.totalAmount,
          status: "CAPTURED",
          capturedAt: new Date(),
        },
        update: { status: "CAPTURED", capturedAt: new Date() },
      });

      // Confirm booking directly
      bus.emit(Events.PAYMENT_CAPTURED, {
        bookingId,
        paymentId: `dev_pay_${Date.now()}`,
      });

      return {
        devMode: true,
        bookingId,
        amount: booking.totalAmount,
        currency: "INR",
        message:
          "Dev mode: booking auto-confirmed. In production, use Razorpay credentials.",
      };
    }

    // ── Real Razorpay ─────────────────────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Razorpay = require("razorpay");
      const rzp = new Razorpay({
        key_id: config.razorpay.keyId,
        key_secret: config.razorpay.keySecret,
      });
      const order = await rzp.orders.create({
        amount: Math.round(booking.totalAmount * 100), // paise
        currency: "INR",
        receipt: bookingId.slice(-20),
        notes: { bookingId, userId },
      });

      // Persist order reference
      await prisma.booking.update({
        where: { id: bookingId },
        data: { razorpayOrderId: order.id },
      });
      await prisma.payment.upsert({
        where: { bookingId },
        create: {
          bookingId,
          userId,
          razorpayOrderId: order.id,
          amount: booking.totalAmount,
          status: "PENDING",
        },
        update: { razorpayOrderId: order.id, status: "PENDING" },
      });

      return {
        razorpayOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: config.razorpay.keyId,
        bookingId,
      };
    } catch (err: any) {
      log.error("Razorpay order creation failed", { error: err.message });
      throw new AppError("Payment gateway error. Please try again.", 502);
    }
  }

  /* ── POST /api/v1/payments/verify ───────────────────────────────────── */
  async verifyPayment(
    userId: string,
    body: {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    },
  ) {
    if (!config.razorpay.keySecret)
      throw new AppError("Payment verification not configured", 503);

    // Verify signature
    const expectedSig = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${body.razorpayOrderId}|${body.razorpayPaymentId}`)
      .digest("hex");

    if (expectedSig !== body.razorpaySignature) {
      // Find booking to fail it
      const payment = await prisma.payment.findUnique({
        where: { razorpayOrderId: body.razorpayOrderId },
      });
      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
        bus.emit(Events.PAYMENT_FAILED, { bookingId: payment.bookingId });
      }
      throw new AppError(
        "Payment verification failed. Invalid signature.",
        400,
      );
    }

    // Find and update payment record
    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: body.razorpayOrderId },
    });
    if (!payment)
      throw new AppError("Payment record not found for this order", 404);
    if (payment.userId !== userId) throw new AppError("Access denied", 403);

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        razorpayPaymentId: body.razorpayPaymentId,
        status: "CAPTURED",
        capturedAt: new Date(),
      },
    });

    bus.emit(Events.PAYMENT_CAPTURED, {
      bookingId: payment.bookingId,
      paymentId: body.razorpayPaymentId,
    });
    return { verified: true, bookingId: payment.bookingId };
  }

  /* ── GET /api/v1/payments/booking/:bookingId ─────────────────────────── */
  async getPaymentByBooking(userId: string, bookingId: string, role: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new AppError("Booking not found", 404);

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    if (!isAdmin && booking.userId !== userId)
      throw new AppError("Access denied", 403);

    const payment = await prisma.payment.findUnique({ where: { bookingId } });
    if (!payment) throw new AppError("No payment found for this booking", 404);
    return payment;
  }

  /* ── POST /api/v1/payments/webhook ──────────────────────────────────── */
  async handleWebhook(rawBody: string, signature: string): Promise<void> {
    if (!config.razorpay.webhookSecret) {
      log.warn("Webhook secret not configured — skipping signature check");
    } else {
      const expected = crypto
        .createHmac("sha256", config.razorpay.webhookSecret)
        .update(rawBody)
        .digest("hex");
      if (expected !== signature)
        throw new AppError("Invalid webhook signature", 400);
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event as string;
    const entity = payload.payload?.payment?.entity || {};
    const notes = entity.notes || {};
    const bookingId = notes.bookingId as string | undefined;

    log.info(`Webhook: ${event}`, { bookingId });

    if (event === "payment.captured" && bookingId) {
      await prisma.payment.updateMany({
        where: { bookingId },
        data: {
          razorpayPaymentId: entity.id,
          status: "CAPTURED",
          capturedAt: new Date(),
        },
      });
      bus.emit(Events.PAYMENT_CAPTURED, { bookingId, paymentId: entity.id });
    } else if (event === "payment.failed" && bookingId) {
      await prisma.payment.updateMany({
        where: { bookingId },
        data: { status: "FAILED" },
      });
      bus.emit(Events.PAYMENT_FAILED, { bookingId });
    }
  }

  /* ── POST /api/v1/admin/payments/:paymentId/refund ───────────────────── */
  async processRefund(
    paymentId: string,
    adminId: string,
    amount?: number,
    reason?: string,
  ) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new AppError("Payment not found", 404);

    if (payment.status !== "CAPTURED") {
      throw new AppError(
        `Cannot refund payment with status: ${payment.status}`,
        400,
      );
    }

    const refundAmount = amount ?? payment.amount;
    if (refundAmount > payment.amount) {
      throw new AppError(
        `Refund amount (${refundAmount}) exceeds payment amount (${payment.amount})`,
        400,
      );
    }

    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      // Dev mode
      log.warn(`[DEV] Mock refund ₹${refundAmount} for payment ${paymentId}`);
      return prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: "REFUNDED",
          refundAmount,
          refundReason: reason,
          refundedAt: new Date(),
          refundId: `dev_refund_${Date.now()}`,
        },
      });
    }

    if (!payment.razorpayPaymentId)
      throw new AppError("No Razorpay payment ID on record", 400);

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Razorpay = require("razorpay");
      const rzp = new Razorpay({
        key_id: config.razorpay.keyId,
        key_secret: config.razorpay.keySecret,
      });
      const refund = await rzp.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { reason, adminId },
      });

      return prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: "REFUNDED",
          refundId: refund.id,
          refundAmount,
          refundReason: reason,
          refundedAt: new Date(),
        },
      });
    } catch (err: any) {
      log.error("Razorpay refund failed", { error: err.message });
      throw new AppError("Refund failed. Please try again.", 502);
    }
  }
}
