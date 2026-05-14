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
 * JOB 3 — Every Monday at 6 AM IST (default: 00:30 UTC Monday)
 *   Finds all children with ChildDevelopmentLog records in the completed ISO week (Mon–Sun).
 *   Calls generateWeeklySummary() → stores AI narrative in Children.developmentSummary.
 *   Then purges PlanTask records older than 7 days for active bookings.
 *
 * All three jobs are exported as standalone async functions for manual testing
 * via the plan routes (POST /api/v1/plan/cron/midnight|morning|weekly).
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
// JOB 3 — Every Monday: generate weekly summary + purge stale PlanTask records
// ─────────────────────────────────────────────────────────────────────────────

export async function runWeeklySummaryJob() {
  log.info('[weekly] Weekly summary job started');

  // Running Monday morning → summarise the PREVIOUS ISO week (Mon–Sun)
  const now      = new Date();
  const prevWeek = new Date(now.getTime() - 7 * 86400000);
  const { year, week } = getISOWeek(prevWeek);

  const weekStart = isoWeekStart(year, week);
  const weekEnd   = new Date(weekStart.getTime() + 7 * 86400000 - 1);

  const logs = await prisma.childDevelopmentLog.findMany({
    where:  { loggedAt: { gte: weekStart, lte: weekEnd } },
    select: { childId: true },
  });
  const childIds = [...new Set(logs.map((l) => l.childId))];

  log.info('[weekly] Children to summarise: %d (week: %d-W%s)', childIds.length, year, String(week).padStart(2, '0'));

  const results = { success: 0, failed: 0 };

  for (const childId of childIds) {
    try {
      await planService.generateWeeklySummary(childId, year, week);
      results.success++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[weekly] Child %s — generateWeeklySummary failed: %s', childId, message);
      results.failed++;
    }
  }

  // Purge old PlanTask records AFTER summaries are saved
  try {
    const deleted = await planService.purgeStalePlanTasks();
    log.info('[weekly] Purged %d stale PlanTask records', deleted);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[weekly] purgeStalePlanTasks failed: %s', message);
  }

  log.info('[weekly] Done — success: %d, failed: %d', results.success, results.failed);
}

// ISO week helpers (local — not exported)
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week      = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function isoWeekStart(year: number, week: number): Date {
  const jan4      = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const week1Mon  = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
  return new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Register all crons — call once after DB connects in index.ts
// ─────────────────────────────────────────────────────────────────────────────

export function registerDailyPlanJob() {
  // 11:30 PM IST = 18:00 UTC  (generates plan for tomorrow's bookings starting at midnight IST)
  const midnightSchedule = process.env.MIDNIGHT_PLAN_CRON ?? '0 18 * * *';

  // 5:00 AM IST = 23:30 UTC previous day
  const morningSchedule  = process.env.MORNING_TASK_CRON  ?? '30 23 * * *';

  // Every Monday at 6:00 AM IST = 00:30 UTC Monday (summarises completed Mon–Sun week)
  const weeklySchedule   = process.env.WEEKLY_SUMMARY_CRON ?? '30 0 * * 1';

  for (const [name, expr] of [
    ['midnight', midnightSchedule],
    ['morning',  morningSchedule],
    ['weekly',   weeklySchedule],
  ] as [string, string][]) {
    if (!cron.validate(expr)) {
      throw new Error(`Invalid cron expression for ${name} job: "${expr}"`);
    }
  }

  log.info('Registering midnight plan job  — schedule: %s (UTC)', midnightSchedule);
  log.info('Registering 5am task job       — schedule: %s (UTC)', morningSchedule);
  log.info('Registering weekly summary job  — schedule: %s (UTC)', weeklySchedule);

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

  cron.schedule(weeklySchedule, async () => {
    try { await runWeeklySummaryJob(); }
    catch (err: unknown) {
      log.error('[weekly] Unhandled error: %s', err instanceof Error ? err.message : String(err));
    }
  });
}
