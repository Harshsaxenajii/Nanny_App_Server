import { bus, Events } from "./eventBus";
import { NotificationService } from "../services/notification.service";
import { BookingService } from "../services/booking.service";
import { createLogger } from "./logger";
import { prisma } from "../config/prisma";
import { NotificationType } from "@prisma/client";
import {
  sendNormalNotification,
  sendBookingRequestNotification,
} from "../services/pushNotification.service";

const log = createLogger("events");
const notif = new NotificationService();
const book = new BookingService();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: human-readable child age from date of birth
// ─────────────────────────────────────────────────────────────────────────────
function calcChildAge(dob: Date | null | undefined): string {
  if (!dob) return "Unknown age";
  const ageMs = Date.now() - new Date(dob).getTime();
  const ageYears = Math.floor(ageMs / (365.25 * 24 * 3_600_000));
  if (ageYears < 1) {
    const ageMonths = Math.floor(ageMs / (30.44 * 24 * 3_600_000));
    return `${ageMonths} month${ageMonths !== 1 ? "s" : ""}`;
  }
  return `${ageYears} yr${ageYears !== 1 ? "s" : ""}`;
}

export function registerEventHandlers(): void {
  // ── PAYMENT_CAPTURED ───────────────────────────────────────────────────────
  // 1. Confirm the booking in DB (moves PENDING_PAYMENT → CONFIRMED)
  // 2. Save an in-app notification for the user (bell icon in app)
  // 3. Send FCM booking-request push to the nanny so they see the overlay
  // ──────────────────────────────────────────────────────────────────────────
  bus.on(Events.BOOKING_CREATED, async ({ bookingId, userId }) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          user: { select: { name: true, profilePhoto: true } },
          nanny: { select: { userId: true, name: true } },
          children: { select: { birthDate: true } },
        },
      });
      if (!booking || !booking.nannyId || !booking.nanny) return;

      // In-app record for nanny
      await notif.create(
        booking.nanny.userId,
        NotificationType.BOOKING_CONFIRMED, // closest existing type
        "New Booking Request! 📅",
        "A parent is requesting your services. Please respond within 30 minutes.",
        { bookingId },
      );

      // Rich FCM booking-request push → nanny sees BookingRequestOverlay
      const pricing = booking.pricingDetails as any;
      const startDate = new Date(booking.scheduledStartTime);
      const endDate = new Date(booking.scheduledEndTime);
      const durationHrs = Math.abs(
        (endDate.getTime() - startDate.getTime()) / 3_600_000,
      ).toFixed(1);
      const startTimeStr = startDate.toLocaleString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
        timeZone: "Asia/Kolkata",
      });

      await sendBookingRequestNotification(booking.nanny.userId, {
        bookingId,
        parentName: booking.user?.name ?? "A parent",
        parentPhoto: booking.user?.profilePhoto ?? undefined,
        location: booking.addressCity ?? "",
        address: [
          booking.addressLine1,
          booking.addressCity,
          booking.addressPincode,
        ]
          .filter(Boolean)
          .join(", "),
        price: pricing?.total ? `₹${pricing.total}` : "See app",
        duration: `${durationHrs} hrs`,
        startTime: startTimeStr,
        childAge: calcChildAge(booking.children?.birthDate),
        distance: "Nearby",
        specialNotes: booking.specialInstructions ?? undefined,
        expiresIn: 300_000,
      });
    } catch (err: any) {
      log.error("BOOKING_CREATED handler error", { error: err.message });
    }
  });
  bus.on(Events.PAYMENT_CAPTURED, async ({ bookingId, paymentId }) => {
    try {
      await book.handlePaymentCaptured(bookingId, paymentId);

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      if (!booking) return;

      // Notify user — payment success
      await notif.create(
        booking.userId,
        NotificationType.BOOKING_CONFIRMED,
        "Payment Successful! ✅",
        "Your payment is confirmed. Your nanny will arrive as scheduled.",
        { bookingId },
      );

      await sendNormalNotification(
        booking.userId,
        "Payment Successful! ✅",
        "Your payment is confirmed. Your nanny will arrive as scheduled.",
        { type: "PAYMENT_CONFIRMED", bookingId, screen: "bookings" },
      );

      // ── REMOVE the entire nanny FCM block that was here ──
      // Nanny was already notified at booking creation, not at payment.
    } catch (err: any) {
      log.error("PAYMENT_CAPTURED handler error", { error: err.message });
    }
  });

  // ── PAYMENT_FAILED ─────────────────────────────────────────────────────────
  // Mark booking cancelled in DB + notify user via in-app record and FCM.
  // ──────────────────────────────────────────────────────────────────────────
  bus.on(Events.PAYMENT_FAILED, async ({ bookingId }) => {
    try {
      await book.handlePaymentFailed(bookingId);

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      if (!booking) return;

      // In-app notification record
      await notif.create(
        booking.userId,
        NotificationType.PAYMENT_FAILED,
        "Payment Failed",
        "Your payment could not be processed. Please try again.",
        { bookingId },
      );

      // FCM push
      await sendNormalNotification(
        booking.userId,
        "Payment Failed",
        "Your payment could not be processed. Please try again.",
        {
          type: "PAYMENT_FAILED",
          bookingId,
          screen: "payment",
        },
      );
    } catch (err: any) {
      log.error("PAYMENT_FAILED handler error", { error: err.message });
    }
  });

  // ── BOOKING_CONFIRMED ──────────────────────────────────────────────────────
  // Emitted by BookingService.confirmBooking() after the nanny taps Accept.
  // Sends FCM to the USER so their app navigates to the booking/payment screen.
  // ──────────────────────────────────────────────────────────────────────────
  bus.on(Events.BOOKING_CONFIRMED, async ({ bookingId, userId, nannyId }) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { nanny: { select: { name: true } } },
      });
      if (!booking) return;

      const nannyName = booking.nanny?.name ?? "Your nanny";

      // In-app notification record for user
      await notif.create(
        userId,
        NotificationType.BOOKING_CONFIRMED,
        "Nanny Confirmed! 🎉",
        `${nannyName} has accepted your booking. Tap to view details.`,
        { bookingId },
      );

      // FCM push to user — RN handler reads type=BOOKING_CONFIRMED and
      // navigates to /(user)/payment/:bookingId automatically.
      await sendNormalNotification(
        userId,
        "Nanny Confirmed! 🎉",
        `${nannyName} has accepted your booking. Tap to view details.`,
        {
          type: "BOOKING_CONFIRMED",
          bookingId,
          screen: "payment", // deep-link hint read in usePushNotifications.ts
        },
      );
    } catch (err: any) {
      log.error("BOOKING_CONFIRMED handler error", { error: err.message });
    }
  });

  // ── BOOKING_CANCELLED ──────────────────────────────────────────────────────
  // Fired by rejectBooking (nanny declined), cancelBooking (user/admin).
  // • Nanny cancel  → FCM to user only (they triggered nothing)
  // • Admin cancel  → FCM to user + nanny
  // • User cancel   → in-app record only for nanny (user did it themselves)
  // ──────────────────────────────────────────────────────────────────────────
  bus.on(
    Events.BOOKING_CANCELLED,
    async ({ bookingId, userId, reason, status }) => {
      try {
        const booking = await prisma.booking.findUnique({
          where: { id: bookingId },
          include: { nanny: { select: { userId: true } } },
        });
        if (!booking) return;

        const cancelMsg = reason
          ? `Your booking was cancelled. Reason: ${reason}`
          : "Your booking was cancelled.";

        const isNannyCancel = status === "CANCELLED_BY_NANNY";
        const isAdminCancel = status === "CANCELLED_BY_ADMIN";
        const isUserCancel = status === "CANCELLED_BY_USER";

        // ── Notify the booking owner (user / parent) ──────────────────────────
        if (isNannyCancel || isAdminCancel) {
          // In-app record
          await notif.create(
            booking.userId,
            NotificationType.BOOKING_CANCELLED,
            isNannyCancel ? "Nanny Unavailable" : "Booking Cancelled",
            isNannyCancel
              ? "Your nanny was unable to accept. Please choose another nanny."
              : cancelMsg,
            { bookingId },
          );

          // FCM push
          await sendNormalNotification(
            booking.userId,
            isNannyCancel ? "Nanny Unavailable" : "Booking Cancelled",
            isNannyCancel
              ? "Your nanny was unable to accept. Please choose another nanny."
              : cancelMsg,
            {
              type: "BOOKING_CANCELLED",
              bookingId,
              screen: "bookings",
            },
          );
        }

        // ── Notify the nanny (only if someone else cancelled) ─────────────────
        if (booking.nanny && !isNannyCancel) {
          // In-app record for nanny
          await notif.create(
            booking.nanny.userId,
            NotificationType.BOOKING_CANCELLED,
            "Booking Cancelled",
            "A booking assigned to you has been cancelled.",
            { bookingId },
          );

          // FCM push to nanny only when admin or user cancelled
          // (nanny-cancel: they did it themselves, no push needed)
          if (isAdminCancel || isUserCancel) {
            await sendNormalNotification(
              booking.nanny.userId,
              "Booking Cancelled",
              "A booking assigned to you has been cancelled.",
              {
                type: "BOOKING_CANCELLED",
                bookingId,
                screen: "bookings",
              },
            );
          }
        }
      } catch (err: any) {
        log.error("BOOKING_CANCELLED handler error", { error: err.message });
      }
    },
  );

  // ── BOOKING_COMPLETED ──────────────────────────────────────────────────────
  // Prompt the user to leave a review via in-app record + FCM.
  // ──────────────────────────────────────────────────────────────────────────
  bus.on(
    Events.BOOKING_COMPLETED,
    async ({ bookingId, userId: nannyUserId }) => {
      try {
        const booking = await prisma.booking.findUnique({
          where: { id: bookingId },
          include: { nanny: { select: { name: true } } },
        });
        if (!booking) return;

        const nannyName = booking.nanny?.name ?? "your nanny";

        // In-app record
        await notif.create(
          booking.userId,
          NotificationType.BOOKING_COMPLETED,
          "Session Complete! 🎉",
          `How was ${nannyName}? Leave a review to help other parents.`,
          { bookingId },
        );

        // FCM push
        await sendNormalNotification(
          booking.userId,
          "Session Complete! 🎉",
          `How was ${nannyName}? Leave a review to help other parents.`,
          {
            type: "BOOKING_COMPLETED",
            bookingId,
            screen: "review",
          },
        );
      } catch (err: any) {
        log.error("BOOKING_COMPLETED handler error", { error: err.message });
      }
    },
  );

  // ── NANNY_VERIFIED ─────────────────────────────────────────────────────────
  bus.on(Events.NANNY_VERIFIED, async ({ nannyId }) => {
    try {
      const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
      if (!nanny) return;

      // In-app record
      await notif.create(
        nanny.userId,
        NotificationType.NANNY_VERIFIED,
        "Profile Verified! 🎉",
        "Congratulations! Your nanny profile is verified. You can now set yourself as available.",
        { nannyId },
      );

      // FCM push
      await sendNormalNotification(
        nanny.userId,
        "Profile Verified! 🎉",
        "Your profile is verified. You can now set yourself as available.",
        {
          type: "NANNY_VERIFIED",
          nannyId,
          screen: "dashboard",
        },
      );
    } catch (err: any) {
      log.error("NANNY_VERIFIED handler error", { error: err.message });
    }
  });

  // ── NANNY_REJECTED ─────────────────────────────────────────────────────────
  bus.on(Events.NANNY_REJECTED, async ({ nannyId, reason }) => {
    try {
      const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
      if (!nanny) return;

      // In-app record
      await notif.create(
        nanny.userId,
        NotificationType.NANNY_REJECTED,
        "Profile Update Required",
        `Your application was not approved. Reason: ${reason}`,
        { nannyId },
      );

      // FCM push
      await sendNormalNotification(
        nanny.userId,
        "Profile Update Required",
        `Your application was not approved. Reason: ${reason}`,
        {
          type: "NANNY_REJECTED",
          nannyId,
          screen: "profile",
        },
      );
    } catch (err: any) {
      log.error("NANNY_REJECTED handler error", { error: err.message });
    }
  });

  // ── EXTENSION_PAYMENT_CAPTURED ─────────────────────────────────────────────
  // Confirms the extension in DB, extends the booking end date, seeds attendance,
  // then notifies the user.
  // ──────────────────────────────────────────────────────────────────────────
  bus.on(
    Events.EXTENSION_PAYMENT_CAPTURED,
    async ({ bookingId, extensionId, paymentId }) => {
      try {
        await book.handleExtensionPaymentCaptured(extensionId, paymentId);

        const booking = await prisma.booking.findUnique({
          where: { id: bookingId },
        });
        if (!booking) return;

        await notif.create(
          booking.userId,
          NotificationType.PAYMENT_SUCCESS,
          "Booking Extended! ✅",
          "Your extension payment is confirmed. Your nanny's schedule has been updated.",
          { bookingId, extensionId },
        );

        await sendNormalNotification(
          booking.userId,
          "Booking Extended! ✅",
          "Your extension payment is confirmed. Your nanny's schedule has been updated.",
          { type: "BOOKING_EXTENDED", bookingId, screen: "bookings" },
        );
      } catch (err: any) {
        log.error("EXTENSION_PAYMENT_CAPTURED handler error", {
          error: err.message,
        });
      }
    },
  );

  log.info("Event handlers registered");
}
