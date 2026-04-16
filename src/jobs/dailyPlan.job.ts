/**
 * dailyPlan.job.ts
 *
 * Cron job: runs every morning at 05:00 AM IST (23:30 UTC previous day).
 * For every booking that is active today and has an AI plan generated,
 * it calls PlanService.generateDailyTasks to create fresh PlanTask[] for the day.
 *
 * The nanny opens the app at the start of their shift and sees today's tasks ready.
 *
 * Schedule: "30 23 * * *" (UTC) = 05:00 AM IST daily
 */

import cron             from 'node-cron';
import { prisma }       from '../config/prisma';
import { PlanService }  from '../services/plan.service';
import { createLogger } from '../utils/logger';

const log         = createLogger('dailyPlan.job');
const planService = new PlanService();

// ── Core logic (exported so it can be triggered manually / tested) ────────────

export async function runDailyPlanJob() {
  log.info('Daily plan job started');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find all bookings that:
  //   1. Are currently active (today falls within the booking range)
  //   2. Have had their master AI plan generated
  //   3. Are in a status where the nanny is working
  const activeBookings = await prisma.booking.findMany({
    where: {
      aiPlanGenerated:    true,
      scheduledStartTime: { lte: today },
      scheduledEndTime:   { gte: today },
      status: {
        in: ['CONFIRMED', 'NANNY_ASSIGNED', 'IN_PROGRESS'],
      },
    },
    select: { id: true },
  });

  log.info('Found %d active bookings to process', activeBookings.length);

  if (!activeBookings.length) {
    log.info('No active bookings — job done');
    return;
  }

  // Process sequentially to avoid hammering the Claude API concurrently.
  // If you have a high volume of bookings, switch to a queue (BullMQ etc.)
  const results = { success: 0, failed: 0 };

  for (const { id } of activeBookings) {
    try {
      const tasks = await planService.generateDailyTasks(id);
      log.info('Booking %s — %d tasks generated', id, tasks.length);
      results.success++;
    } catch (err: unknown) {
      // One failure must not abort the rest
      const message = err instanceof Error ? err.message : String(err);
      log.error('Booking %s — task generation failed: %s', id, message);
      results.failed++;
    }
  }

  log.info(
    'Daily plan job complete — success: %d, failed: %d',
    results.success,
    results.failed,
  );
}

// ── Register cron ─────────────────────────────────────────────────────────────

export function registerDailyPlanJob() {
  // 05:00 AM IST = 23:30 UTC (previous calendar day)
  const schedule = process.env.DAILY_PLAN_CRON ?? '30 23 * * *';

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression for daily plan job: "${schedule}"`);
  }

  log.info('Registering daily plan job with schedule: %s (UTC)', schedule);

  cron.schedule(schedule, async () => {
    try {
      await runDailyPlanJob();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Unhandled error in daily plan job: %s', message);
    }
  });
}
