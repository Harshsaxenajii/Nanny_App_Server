import { bus, Events } from './eventBus';
import { NotificationService } from '../services/notification.service';
import { BookingService } from '../services/booking.service';
import { createLogger } from './logger';
import { prisma } from '../config/prisma';
import { NotificationType } from '@prisma/client';

const log   = createLogger('events');
const notif = new NotificationService();
const book  = new BookingService();

export function registerEventHandlers(): void {

  bus.on(Events.PAYMENT_CAPTURED, async ({ bookingId, paymentId }) => {
    try {
      await book.handlePaymentCaptured(bookingId, paymentId);
      // Notify user
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (booking) {
        await notif.create(booking.userId, NotificationType.BOOKING_CONFIRMED,
          'Booking Confirmed! ✅',
          'Your payment was successful and booking is confirmed.',
          { bookingId });
        // If nanny assigned, notify nanny
        if (booking.nannyId) {
          const nanny = await prisma.nanny.findUnique({ where: { id: booking.nannyId } });
          if (nanny) {
            await notif.create(nanny.userId, NotificationType.BOOKING_CONFIRMED,
              'New Booking! 📅',
              'A new booking has been confirmed for you. Please review and accept.',
              { bookingId });
          }
        }
      }
    } catch (err: any) {
      log.error('PAYMENT_CAPTURED handler error', { error: err.message });
    }
  });

  bus.on(Events.PAYMENT_FAILED, async ({ bookingId }) => {
    try {
      await book.handlePaymentFailed(bookingId);
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (booking) {
        await notif.create(booking.userId, NotificationType.PAYMENT_FAILED,
          'Payment Failed',
          'Your payment could not be processed. Please try again.',
          { bookingId });
      }
    } catch (err: any) {
      log.error('PAYMENT_FAILED handler error', { error: err.message });
    }
  });

  bus.on(Events.BOOKING_CANCELLED, async ({ bookingId, userId, reason }) => {
    try {
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) return;
      // Notify booking owner
      await notif.create(booking.userId, NotificationType.BOOKING_CANCELLED,
        'Booking Cancelled',
        reason ? `Your booking was cancelled. Reason: ${reason}` : 'Your booking was cancelled.',
        { bookingId });
      // Notify nanny if assigned
      if (booking.nannyId) {
        const nanny = await prisma.nanny.findUnique({ where: { id: booking.nannyId } });
        if (nanny && nanny.userId !== userId) {
          await notif.create(nanny.userId, NotificationType.BOOKING_CANCELLED,
            'Booking Cancelled',
            'A booking assigned to you has been cancelled.',
            { bookingId });
        }
      }
    } catch (err: any) {
      log.error('BOOKING_CANCELLED handler error', { error: err.message });
    }
  });

  bus.on(Events.BOOKING_COMPLETED, async ({ bookingId, userId: nannyUserId }) => {
    try {
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) return;
      await notif.create(booking.userId, NotificationType.BOOKING_COMPLETED,
        'Booking Completed! 🎉',
        'Your session is complete. Please leave a review for your nanny.',
        { bookingId });
    } catch (err: any) {
      log.error('BOOKING_COMPLETED handler error', { error: err.message });
    }
  });

  bus.on(Events.NANNY_VERIFIED, async ({ nannyId }) => {
    try {
      const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
      if (!nanny) return;
      await notif.create(nanny.userId, NotificationType.NANNY_VERIFIED,
        'Profile Verified! 🎉',
        'Congratulations! Your nanny profile is verified. You can now set yourself as available.',
        { nannyId });
    } catch (err: any) {
      log.error('NANNY_VERIFIED handler error', { error: err.message });
    }
  });

  bus.on(Events.NANNY_REJECTED, async ({ nannyId, reason }) => {
    try {
      const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
      if (!nanny) return;
      await notif.create(nanny.userId, NotificationType.NANNY_REJECTED,
        'Profile Update Required',
        `Your application was not approved. Reason: ${reason}`,
        { nannyId });
    } catch (err: any) {
      log.error('NANNY_REJECTED handler error', { error: err.message });
    }
  });

  log.info('Event handlers registered');
}
