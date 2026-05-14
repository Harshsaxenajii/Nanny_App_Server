import cron from "node-cron";
import { prisma } from "../config/prisma";
import { sendNormalNotification } from "../services/pushNotification.service";
import { createLogger } from "../utils/logger";

const log = createLogger("reminder.job");

export async function runBookingReminderJob() {
  const now = new Date();
  // Find bookings starting in the next 60–70 minutes (run every 30 min, window of 10 min overlap)
  const from = new Date(now.getTime() + 50 * 60 * 1000);
  const to = new Date(now.getTime() + 70 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: {
      scheduledStartTime: { gte: from, lte: to },
      status: { in: ["CONFIRMED", "NANNY_ASSIGNED"] },
      nannyId: { not: null },
    },
    select: {
      id: true,
      scheduledStartTime: true,
      nanny: { select: { userId: true, name: true } },
      user: { select: { name: true } },
    },
  });

  log.info(`[reminder] Found ${bookings.length} bookings starting in ~1 hour`);

  for (const booking of bookings) {
    if (!booking.nanny?.userId) continue;
    try {
      await sendNormalNotification(
        booking.nanny.userId,
        "Booking starts in 1 hour!",
        `Please be ready for your booking with ${booking.user?.name ?? "the parent"}.`,
        { bookingId: booking.id, type: "BOOKING_REMINDER" },
      );
      log.info(`[reminder] Push sent → nanny userId=${booking.nanny.userId} bookingId=${booking.id}`);
    } catch (err) {
      log.error(`[reminder] Failed to send push for booking ${booking.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function registerReminderJob() {
  // Run every 30 minutes so each booking always gets exactly one notification in the 60–70 min window
  const schedule = process.env.BOOKING_REMINDER_CRON ?? "*/30 * * * *";

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression for reminder job: "${schedule}"`);
  }

  log.info("Registering booking reminder job — schedule: %s", schedule);

  cron.schedule(schedule, async () => {
    try {
      await runBookingReminderJob();
    } catch (err: unknown) {
      log.error("[reminder] Unhandled error: %s", err instanceof Error ? err.message : String(err));
    }
  });
}
