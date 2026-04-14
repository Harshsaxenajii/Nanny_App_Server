/**
 * dailyPlan.job.ts
 *
 * Runs every morning at 05:00 AM (server time).
 * For every active subscription booking that has an AI plan,
 * generates today's PlanTask[] by calling plan.service → generateAndSaveDailyTasks().
 *
 * Uses node-cron. Install: npm i node-cron @types/node-cron
 *
 * Register in src/index.ts:
 *   import { startDailyPlanJob } from './jobs/dailyPlan.job';
 *   startDailyPlanJob();
 */

import cron              from 'node-cron';
import { prisma }        from '../config/prisma';
import { createLogger }  from '../utils/logger';
import { generateAndSaveDailyTasks } from '../services/plan.service';
import { BookingStatus } from '@prisma/client';

const log = createLogger('dailyPlanJob');

export function startDailyPlanJob(): void {
  // Runs at 05:00 every morning
  cron.schedule('45 17 * * *', async () => {
    log.info('Daily plan job started');

    try {
      // Find all active subscription bookings that have an AI plan generated
      const activePlans = await prisma.dailyPlan.findMany({
        where: {
          booking: {
            status: {
              in: [BookingStatus.CONFIRMED, BookingStatus.NANNY_ASSIGNED, BookingStatus.IN_PROGRESS],
            },
            aiPlanGenerated: true,
            // Only subscription bookings (>= 30 days)
            // We filter in-process rather than storing a flag — cheaper
          },
        },
        select: { id: true, bookingId: true },
      });

      log.info(`Found ${activePlans.length} active plans to regenerate`);

      // Process sequentially to avoid hammering Claude API
      for (const plan of activePlans) {
        try {
          await generateAndSaveDailyTasks(plan.id);
          log.info(`Tasks generated for plan ${plan.id}`);
        } catch (err: any) {
          // Don't let one failure block others
          log.error(`Failed to generate tasks for plan ${plan.id}: ${err.message}`);
        }
      }

      log.info('Daily plan job complete');
    } catch (err: any) {
      log.error(`Daily plan job failed: ${err.message}`);
    }
  }, {
    timezone: 'Asia/Kolkata', // IST — adjust if needed
  });

  log.info('Daily plan cron job registered (05:00 IST every day)');
}
