/**
 * dailyPlan.job.ts
 *
 * Three cron jobs registered via registerDailyPlanJob().
 * Call once after DB connects in index.ts.
 *
 * JOB 1 — midnight (default: 11:30 PM IST = 18:00 UTC)
 *   Finds all CONFIRMED FULL_TIME bookings that have ChildGoals set but no AI plan yet.
 *   Calls generatePlan() for each → creates master DailyPlan + day-1 PlanTask[].
 *   The aiPlanGenerated flag ensures it never runs twice for the same booking.
 *
 * JOB 2 — 5 AM IST (default: 23:30 UTC previous day)
 *   Finds all active bookings (started, not ended, AI plan exists).
 *   For each: assessYesterday() → generateDailyTasks().
 *   lastGeneratedDate guard prevents double-run if cron fires twice.
 *
 * JOB 3 — 1st of month at 1:30 AM IST (default: 20:00 UTC on 1st)
 *   Finds all children with ChildDevelopmentLog records in the previous month.
 *   Calls generateMonthlySummary() → stores AI narrative in Children.developmentSummary.
 *
 * All three jobs are also exported as standalone async functions for manual testing
 * via the plan routes (POST /api/v1/plan/cron/midnight|morning|monthly).
 */

import cron         from 'node-cron';
import { prisma }   from '../config/prisma';
import { PlanService } from '../services/plan.service';
import { createLogger } from '../utils/logger';

const log         = createLogger('dailyPlan.job');
const planService = new PlanService();

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1 — Midnight: generate master plans for new unplanned bookings
// ─────────────────────────────────────────────────────────────────────────────

export async function runMidnightPlanJob() {
  log.info('[midnight] Master plan job started');

  // All CONFIRMED FULL_TIME bookings that have goals but no AI plan yet.
  // No start-date filter — the plan is generated as soon as the booking is confirmed,
  // so the nanny can see the strategy before day 1 begins.
  const newBookings = await prisma.booking.findMany({
    where: {
      aiPlanGenerated: false,
      serviceType:     'FULL_TIME',
      status:          { in: ['CONFIRMED', 'IN_PROGRESS'] },
      childGoals:      { some: {} },
    },
    select: { id: true },
  });

  log.info('[midnight] Unplanned bookings with goals: %d', newBookings.length);

  const results = { success: 0, failed: 0 };

  for (const { id } of newBookings) {
    try {
      await planService.generatePlan(id);
      log.info('[midnight] Booking %s — master plan + day-1 tasks done', id);
      results.success++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[midnight] Booking %s — generatePlan failed: %s', id, message);
      results.failed++;
    }
  }

  log.info('[midnight] Done — success: %d, failed: %d', results.success, results.failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2 — 5 AM: assess yesterday + generate today's tasks for active bookings
// ─────────────────────────────────────────────────────────────────────────────

export async function runMorningTaskJob() {
  log.info('[5am] Daily task job started');

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(today.getTime() + 86400000 - 1);

  const activeBookings = await prisma.booking.findMany({
    where: {
      aiPlanGenerated:    true,
      serviceType:        'FULL_TIME',       // AI planning is FULL_TIME only
      scheduledStartTime: { lte: todayEnd }, // booking must have started by today
      scheduledEndTime:   { gte: today },    // and must not have ended yet
      status:             { in: ['CONFIRMED', 'IN_PROGRESS'] },
    },
    select: { id: true },
  });

  log.info('[5am] Active bookings to process: %d', activeBookings.length);

  const results = { success: 0, skipped: 0, failed: 0 };

  for (const { id } of activeBookings) {
    try {
      // Skip if today's tasks already generated (idempotency guard)
      const existingPlan = await prisma.dailyPlan.findUnique({
        where:  { bookingId: id },
        select: { lastGeneratedDate: true },
      });

      if (existingPlan?.lastGeneratedDate) {
        const lastGen = new Date(existingPlan.lastGeneratedDate);
        lastGen.setUTCHours(0, 0, 0, 0);
        if (lastGen.getTime() === today.getTime()) {
          log.info('[5am] Booking %s — already generated today, skipping', id);
          results.skipped++;
          continue;
        }
      }

      // Step 1: assess yesterday → writes ChildDevelopmentLog, updates DailyPlan.dayScore
      // IMPORTANT: runs BEFORE generateDailyTasks so yesterday's data is clean
      // (generateDailyTasks only deletes TODAY's tasks, not yesterday's)
      await planService.assessYesterday(id);

      // Step 2: generate today's blended tasks using yesterday's score
      const tasks = await planService.generateDailyTasks(id);
      log.info('[5am] Booking %s — %d tasks generated', id, tasks.length);
      results.success++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[5am] Booking %s — failed: %s', id, message);
      results.failed++;
    }
  }

  log.info('[5am] Done — success: %d, skipped: %d, failed: %d', results.success, results.skipped, results.failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 3 — 1st of month: generate monthly summary for all active children
// ─────────────────────────────────────────────────────────────────────────────

export async function runMonthlySummaryJob() {
  log.info('[monthly] Monthly summary job started');

  const now = new Date();
  // We're running on the 1st of the CURRENT month → summarise the PREVIOUS month
  const targetYear  = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const targetMonth = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth(); // 1-based

  const monthStart = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
  const monthEnd   = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999));

  // Find distinct child IDs that have development logs in the target month
  const logs = await prisma.childDevelopmentLog.findMany({
    where:  { loggedAt: { gte: monthStart, lte: monthEnd } },
    select: { childId: true },
  });
  const childIds = [...new Set(logs.map((l) => l.childId))];

  log.info('[monthly] Children to summarise: %d (month: %d-%d)', childIds.length, targetYear, targetMonth);

  const results = { success: 0, failed: 0 };

  for (const childId of childIds) {
    try {
      await planService.generateMonthlySummary(childId, targetYear, targetMonth);
      results.success++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[monthly] Child %s — failed: %s', childId, message);
      results.failed++;
    }
  }

  log.info('[monthly] Done — success: %d, failed: %d', results.success, results.failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Register all crons — call once after DB connects in index.ts
// ─────────────────────────────────────────────────────────────────────────────

export function registerDailyPlanJob() {
  // 11:30 PM IST = 18:00 UTC  (generates plan for tomorrow's bookings starting at midnight IST)
  const midnightSchedule = process.env.MIDNIGHT_PLAN_CRON ?? '0 18 * * *';

  // 5:00 AM IST = 23:30 UTC previous day
  const morningSchedule  = process.env.MORNING_TASK_CRON  ?? '30 23 * * *';

  // 1st of month at 1:30 AM IST = 20:00 UTC on 1st of month
  const monthlySchedule  = process.env.MONTHLY_SUMMARY_CRON ?? '0 20 1 * *';

  for (const [name, expr] of [
    ['midnight', midnightSchedule],
    ['morning',  morningSchedule],
    ['monthly',  monthlySchedule],
  ] as [string, string][]) {
    if (!cron.validate(expr)) {
      throw new Error(`Invalid cron expression for ${name} job: "${expr}"`);
    }
  }

  log.info('Registering midnight plan job  — schedule: %s (UTC)', midnightSchedule);
  log.info('Registering 5am task job       — schedule: %s (UTC)', morningSchedule);
  log.info('Registering monthly summary job — schedule: %s (UTC)', monthlySchedule);

  cron.schedule(midnightSchedule, async () => {
    try { await runMidnightPlanJob(); }
    catch (err: unknown) {
      log.error('[midnight] Unhandled error: %s', err instanceof Error ? err.message : String(err));
    }
  });

  cron.schedule(morningSchedule, async () => {
    try { await runMorningTaskJob(); }
    catch (err: unknown) {
      log.error('[5am] Unhandled error: %s', err instanceof Error ? err.message : String(err));
    }
  });

  cron.schedule(monthlySchedule, async () => {
    try { await runMonthlySummaryJob(); }
    catch (err: unknown) {
      log.error('[monthly] Unhandled error: %s', err instanceof Error ? err.message : String(err));
    }
  });
}
