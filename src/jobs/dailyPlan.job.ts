/**
 * dailyPlan.job.ts
 *
 * Two separate cron jobs:
 *
 *   JOB 1 — midnight (12:00 AM IST = 18:30 UTC)
 *     Finds bookings STARTING today that have been paid (CONFIRMED status)
 *     and have child goals set. Calls generatePlan() once per booking.
 *     This creates the master DailyPlan + day 1 PlanTask[].
 *     Never runs again for the same booking (aiPlanGenerated flag).
 *
 *   JOB 2 — early morning (5:00 AM IST = 23:30 UTC previous day)
 *     Finds all active bookings where AI plan already exists.
 *     For each: assessYesterday() → then generateDailyTasks().
 *     lastGeneratedDate guard prevents double-run if cron fires twice.
 *
 * Both jobs are registered via registerDailyPlanJob().
 * Call this once after DB connects in index.ts.
 */

import cron from "node-cron";
import { prisma } from "../config/prisma";
import { PlanService } from "../services/plan.service";
import { createLogger } from "../utils/logger";

const log = createLogger("dailyPlan.job");
const planService = new PlanService();

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1 — Midnight: generate master plan for bookings starting today
// ─────────────────────────────────────────────────────────────────────────────

export async function runMidnightPlanJob() {
  log.info("[midnight] Master plan job started");

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(today.getTime() + 86400000 - 1);

  // Find bookings that:
  //   - Start today (scheduledStartTime falls within today UTC)
  //   - Payment confirmed (status = CONFIRMED or NANNY_ASSIGNED or IN_PROGRESS)
  //   - Have NOT had AI plan generated yet
  //   - Have at least one ChildGoal (pro-plan bookings only)
  const newBookings = await prisma.booking.findMany({
    where: {
      aiPlanGenerated: false,
      // scheduledStartTime: { gte: today, lte: todayEnd },
      serviceType:"FULL_TIME",
      status: { in: ["CONFIRMED", "IN_PROGRESS"] },
      childGoals: { some: {} },
    },
    select: { id: true },
  });

  log.info(
    `[midnight] Bookings starting today with goals: ${newBookings.length}`,

  );

  const results = { success: 0, failed: 0 };

  let i = 0;
  for (const { id } of newBookings) {
    if (i >= 2) {
      return;
    }
    try {
      await planService.generatePlan(id);
      log.info("[midnight] Booking %s — master plan + day 1 tasks done", id);
      results.success++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[midnight] Booking ${id} — generatePlan failed: ${message}`);
      results.failed++;
    } finally {
      i++;
    }
  }

  log.info(
    `[midnight] Master plan job complete — success: ${results.success}, failed: ${results.failed}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2 — 5 AM: assess yesterday + generate today's tasks for active bookings
// ─────────────────────────────────────────────────────────────────────────────

export async function runMorningTaskJob() {
  log.info("[5am] Daily task job started");

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(today.getTime() + 86400000 - 1);

  // Find bookings that:
  //   - Are currently active (today falls within booking range)
  //   - Already have a master AI plan generated
  //   - Nanny is working (correct status)
  const activeBookings = await prisma.booking.findMany({
    where: {
      aiPlanGenerated: true,
      scheduledStartTime: { lte: todayEnd },
      scheduledEndTime: { gte: today },
      status: { in: ["CONFIRMED", "IN_PROGRESS"] },
    },
    select: { id: true },
  });

  log.info(`[5am] Active bookings to process: ${activeBookings.length}`);

  const results = { success: 0, skipped: 0, failed: 0 };

  for (const { id } of activeBookings) {
    try {
      // Guard: skip if tasks already generated today
      // Safe to re-run the cron manually without double-charging the AI
      const existingPlan = await prisma.dailyPlan.findUnique({
        where: { bookingId: id },
        select: { lastGeneratedDate: true },
      });

      if (existingPlan?.lastGeneratedDate) {
        const lastGen = new Date(existingPlan.lastGeneratedDate);
        lastGen.setUTCHours(0, 0, 0, 0);
        if (lastGen.getTime() === today.getTime()) {
          log.info(`[5am] Booking ${id} — already generated today, skipping`);
          results.skipped++;
          continue;
        }
      }

      // Assess yesterday → writes ChildDevelopmentLog + updates ChildGoal fields
      // IMPORTANT: runs BEFORE generateDailyTasks because generateDailyTasks
      // calls deleteMany on today's tasks — yesterday's tasks (different forDate)
      // are untouched, so assessment always reads clean historical data.
      //
      // KEEP COMMENTED until schema changes applied + npx prisma generate passes:
      // await planService.assessYesterday(id);

      // Generate today's tasks from yesterday's summary + parent routine
      const tasks = await planService.generateDailyTasks(id);
      log.info(`[5am] Booking ${id} — ${tasks.length} tasks generated`);
      results.success++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[5am] Booking ${id} — failed: ${message}`);
      results.failed++;
    }
  }

  log.info(
    `[5am] Daily task job complete — success: ${ results.success}, skipped: ${results.skipped}, failed: ${results.failed}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Register both crons — call once after DB connects in index.ts
// ─────────────────────────────────────────────────────────────────────────────

export function registerDailyPlanJob() {
  // 12:00 AM IST = 18:30 UTC (previous calendar day)
  const midnightSchedule = process.env.MIDNIGHT_PLAN_CRON ?? "32 14 * * *";

  // 05:00 AM IST = 23:30 UTC (previous calendar day)
  const morningSchedule = process.env.MORNING_TASK_CRON ?? "30 23 * * *";

  if (!cron.validate(midnightSchedule)) {
    throw new Error(
      `Invalid cron expression for midnight job: "${midnightSchedule}"`
    );
  }
  if (!cron.validate(morningSchedule)) {
    throw new Error(
      `Invalid cron expression for morning job: "${morningSchedule}"`
    );
  }

  log.info(
    `Registering midnight plan job  — schedule: ${midnightSchedule} (UTC)`
  );
  log.info(
    `Registering 5am task job       — schedule: ${morningSchedule} (UTC)`
  );

  // JOB 1 — midnight
  cron.schedule(midnightSchedule, async () => {
    try {
      await runMidnightPlanJob();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[midnight] Unhandled error: ${message}`);
    }
  });

  // JOB 2 — 5 AM
  cron.schedule(morningSchedule, async () => {
    try {
      await runMorningTaskJob();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[5am] Unhandled error: ${message}`);
    }
  });
}
