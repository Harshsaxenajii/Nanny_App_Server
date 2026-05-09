import crypto from "crypto";
import { prisma } from "../config/prisma";
import { config } from "../config";
import { AppError } from "../utils/AppError";
import { bus, Events } from "../utils/eventBus";
import { createLogger } from "../utils/logger";

const log = createLogger("payment");

export class PaymentService {
  /* ── POST /api/v1/payments/order ────────────────────────────────────── */
  async createOrder(userId: string, bookingId: string) {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError("Booking not found", 404);

    if (booking.userId !== userId)
      throw new AppError("You do not have access to this booking", 403);

    // Check if initial payment already captured
    const existingPayment = await prisma.payment.findFirst({
      where: { bookingId, type: "INITIAL", status: "CAPTURED" },
    });
    if (existingPayment)
      throw new AppError("Payment already captured for this booking", 400);

    // ── Dev mode — no Razorpay configured ─────────────────────────────
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      log.warn("[DEV] Razorpay not configured — auto-confirming booking");

      const existing = await prisma.payment.findFirst({
        where: { bookingId, type: "INITIAL" },
      });
      if (existing) {
        await prisma.payment.update({
          where: { id: existing.id },
          data: { status: "CAPTURED", capturedAt: new Date() },
        });
      } else {
        await prisma.payment.create({
          data: {
            bookingId,
            userId,
            amount: booking.totalAmount,
            status: "CAPTURED",
            type: "INITIAL",
            capturedAt: new Date(),
          },
        });
      }

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
        amount: Math.round(booking.totalAmount * 100),
        currency: "INR",
        receipt: bookingId.slice(-20),
        notes: { bookingId, userId },
      });

      await prisma.booking.update({
        where: { id: bookingId },
        data: { razorpayOrderId: order.id },
      });

      const existing = await prisma.payment.findFirst({
        where: { bookingId, type: "INITIAL" },
      });
      if (existing) {
        await prisma.payment.update({
          where: { id: existing.id },
          data: { razorpayOrderId: order.id, status: "PENDING" },
        });
      } else {
        await prisma.payment.create({
          data: {
            bookingId,
            userId,
            razorpayOrderId: order.id,
            amount: booking.totalAmount,
            status: "PENDING",
            type: "INITIAL",
          },
        });
      }

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

  /* ── POST /api/v1/payments/extension/order ──────────────────────────── */
  async createExtensionOrder(userId: string, extensionId: string) {
    const extension = await prisma.bookingExtension.findUnique({
      where: { id: extensionId },
      include: { booking: true },
    });
    if (!extension) throw new AppError("Extension not found", 404);
    if (extension.booking.userId !== userId)
      throw new AppError("You do not have access to this extension", 403);
    if (extension.status !== "PENDING_PAYMENT")
      throw new AppError(
        `Extension is already in status: ${extension.status}`,
        400,
      );

    // ── Dev mode ──────────────────────────────────────────────────────
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      log.warn("[DEV] Razorpay not configured — auto-confirming extension");

      const payment = await prisma.payment.create({
        data: {
          bookingId: extension.bookingId,
          userId,
          amount: extension.totalAmount,
          status: "CAPTURED",
          type: "EXTENSION",
          capturedAt: new Date(),
        },
      });

      await prisma.bookingExtension.update({
        where: { id: extensionId },
        data: { paymentId: payment.id },
      });

      bus.emit(Events.EXTENSION_PAYMENT_CAPTURED, {
        bookingId: extension.bookingId,
        extensionId,
        paymentId: `dev_pay_ext_${Date.now()}`,
      });

      return {
        devMode: true,
        extensionId,
        bookingId: extension.bookingId,
        amount: extension.totalAmount,
        currency: "INR",
        message: "Dev mode: extension auto-confirmed.",
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
        amount: Math.round(extension.totalAmount * 100),
        currency: "INR",
        receipt: extensionId.slice(-20),
        notes: { bookingId: extension.bookingId, extensionId, userId },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingId: extension.bookingId,
          userId,
          razorpayOrderId: order.id,
          amount: extension.totalAmount,
          status: "PENDING",
          type: "EXTENSION",
        },
      });

      await prisma.bookingExtension.update({
        where: { id: extensionId },
        data: { paymentId: payment.id, razorpayOrderId: order.id },
      });

      return {
        razorpayOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: config.razorpay.keyId,
        extensionId,
        bookingId: extension.bookingId,
      };
    } catch (err: any) {
      log.error("Razorpay extension order creation failed", { error: err.message });
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

    const expectedSig = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${body.razorpayOrderId}|${body.razorpayPaymentId}`)
      .digest("hex");

    if (expectedSig !== body.razorpaySignature) {
      const payment = await prisma.payment.findUnique({
        where: { razorpayOrderId: body.razorpayOrderId },
      });
      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
        if (payment.type === "INITIAL") {
          bus.emit(Events.PAYMENT_FAILED, { bookingId: payment.bookingId });
        }
      }
      throw new AppError(
        "Payment verification failed. Invalid signature.",
        400,
      );
    }

    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: body.razorpayOrderId },
      include: { extension: true },
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

    if (payment.type === "EXTENSION" && payment.extension) {
      bus.emit(Events.EXTENSION_PAYMENT_CAPTURED, {
        bookingId: payment.bookingId,
        extensionId: payment.extension.id,
        paymentId: body.razorpayPaymentId,
      });
    } else {
      bus.emit(Events.PAYMENT_CAPTURED, {
        bookingId: payment.bookingId,
        paymentId: body.razorpayPaymentId,
      });
    }

    return {
      verified: true,
      bookingId: payment.bookingId,
      type: payment.type,
    };
  }

  /* ── GET /api/v1/payments/booking/:bookingId ─────────────────────────── */
  async getPaymentByBooking(userId: string, bookingId: string, role: string) {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError("Booking not found", 404);

    const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(role);
    if (!isAdmin && booking.userId !== userId)
      throw new AppError("Access denied", 403);

    const payments = await prisma.payment.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
    if (!payments.length)
      throw new AppError("No payments found for this booking", 404);
    return payments;
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
    const extensionId = notes.extensionId as string | undefined;

    log.info(`Webhook: ${event}`, { bookingId, extensionId });

    if (event === "payment.captured" && bookingId) {
      await prisma.payment.updateMany({
        where: {
          bookingId,
          ...(extensionId ? { type: "EXTENSION" } : { type: "INITIAL" }),
        },
        data: {
          razorpayPaymentId: entity.id,
          status: "CAPTURED",
          capturedAt: new Date(),
        },
      });

      if (extensionId) {
        bus.emit(Events.EXTENSION_PAYMENT_CAPTURED, {
          bookingId,
          extensionId,
          paymentId: entity.id,
        });
      } else {
        bus.emit(Events.PAYMENT_CAPTURED, { bookingId, paymentId: entity.id });
      }
    } else if (event === "payment.failed" && bookingId) {
      await prisma.payment.updateMany({
        where: { bookingId, type: extensionId ? "EXTENSION" : "INITIAL" },
        data: { status: "FAILED" },
      });
      if (!extensionId) {
        bus.emit(Events.PAYMENT_FAILED, { bookingId });
      }
    }
  }

  /* ── POST /api/v1/admin/payments/:paymentId/refund ───────────────────── */
  async processRefund(
    paymentId: string,
    adminId: string,
    amount?: number,
    reason?: string,
  ) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
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
