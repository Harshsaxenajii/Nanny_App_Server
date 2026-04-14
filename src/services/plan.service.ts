/**
 * plan.service.ts
 *
 * Orchestrates the full AI planning flow:
 *
 *   triggerAiPlanForBooking()
 *     Called once when booking status → CONFIRMED (via payment webhook).
 *     1. Reads booking + child + selected goals from DB
 *     2. Calls ai.service → parseGoalsAndStrategy()
 *     3. Writes ChildGoal[] + DailyPlan to DB
 *     4. Calls generateAndSaveDailyTasks() for today
 *
 *   generateAndSaveDailyTasks()
 *     Called every morning by the cron job (and once on initial trigger).
 *     1. Reads DailyPlan + last 7 days of TaskLogs
 *     2. Calls ai.service → generateDailyTasks()
 *     3. Writes PlanTask[] for today
 */

import { prisma }                           from '../config/prisma';
import { createLogger }                     from '../utils/logger';
import { parseGoalsAndStrategy,
         generateDailyTasks }               from './ai.service';
import { getTemplateByAge,
         ageInMonths,
         isSubscriptionBooking,
         resolveGoals }                     from '../utils/goalTemplates';
import { GoalCategory, GoalPriority,
         PlanDifficulty, TaskCategory,
         TaskStatus }                       from '@prisma/client';

const log = createLogger('plan');

// ── Category mappers (goal.json strings → Prisma enums) ──────────────────────

function toGoalCategory(s: string): GoalCategory {
  const map: Record<string, GoalCategory> = {
    COGNITIVE: GoalCategory.COGNITIVE,
    PHYSICAL:  GoalCategory.PHYSICAL,
    SOCIAL:    GoalCategory.SOCIAL,
    EMOTIONAL: GoalCategory.EMOTIONAL,
    CREATIVE:  GoalCategory.CREATIVE,
    ROUTINE:   GoalCategory.COGNITIVE, // fallback — routine maps to cognitive
  };
  return map[s.toUpperCase()] ?? GoalCategory.COGNITIVE;
}

function toGoalPriority(s: string): GoalPriority {
  const map: Record<string, GoalPriority> = {
    HIGH:   GoalPriority.HIGH,
    MEDIUM: GoalPriority.MEDIUM,
    LOW:    GoalPriority.LOW,
  };
  return map[s.toUpperCase()] ?? GoalPriority.MEDIUM;
}

function toPlanDifficulty(s: string): PlanDifficulty {
  const map: Record<string, PlanDifficulty> = {
    LOW:    PlanDifficulty.LOW,
    MEDIUM: PlanDifficulty.MEDIUM,
    HIGH:   PlanDifficulty.HIGH,
  };
  return map[s.toUpperCase()] ?? PlanDifficulty.MEDIUM;
}

function toTaskCategory(s: string): TaskCategory {
  const map: Record<string, TaskCategory> = {
    COGNITIVE: TaskCategory.COGNITIVE,
    PHYSICAL:  TaskCategory.PHYSICAL,
    SOCIAL:    TaskCategory.SOCIAL,
    EMOTIONAL: TaskCategory.EMOTIONAL,
    CREATIVE:  TaskCategory.CREATIVE,
    ROUTINE:   TaskCategory.ROUTINE,
  };
  return map[s.toUpperCase()] ?? TaskCategory.ROUTINE;
}

// ─────────────────────────────────────────────────────────────────────────────
// triggerAiPlanForBooking
// Called once: booking CONFIRMED + duration >= 30 days
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerAiPlanForBooking(bookingId: string): Promise<void> {
  // ── 1. Load booking with child + selected goals ───────────────────────────
  const booking = await prisma.booking.findUnique({
    where:   { id: bookingId },
    include: {
      children: true,
      // selectedGoalIds are stored on the booking as a JSON field (string[])
      // We'll read childGoals that were pre-created during booking creation
      childGoals: true,
    },
  });

  if (!booking) {
    log.warn(`triggerAiPlanForBooking: booking ${bookingId} not found`);
    return;
  }

  // Guard: only run for subscription bookings
  const durationDays = Math.round(
    (booking.scheduledEndTime.getTime() - booking.scheduledStartTime.getTime()) /
    (1000 * 60 * 60 * 24),
  );
  if (!isSubscriptionBooking(booking.scheduledStartTime, booking.scheduledEndTime)) {
    log.info(`Booking ${bookingId} is < 30 days — skipping AI plan`);
    return;
  }

  // Guard: don't run twice
  if (booking.aiPlanGenerated) {
    log.info(`Booking ${bookingId} already has AI plan — skipping`);
    return;
  }

  const child    = booking.children;
  const ageMs    = ageInMonths(child.birthDate);
  const template = getTemplateByAge(ageMs);

  if (!template) {
    log.warn(`No goal template found for age ${ageMs} months — booking ${bookingId}`);
    await prisma.booking.update({
      where: { id: bookingId },
      data:  { aiPlanError: `No template for age ${ageMs} months` },
    });
    return;
  }

  // ── 2. Resolve which premium goals parent selected ────────────────────────
  // selectedGoalIds is stored as string[] on booking.parentGoalPrompt is free text.
  // The goal IDs are stored in booking as a separate JSON field: selectedGoalIds
  const selectedGoalIds: string[] = (booking as any).selectedGoalIds ?? [];
  const selectedGoals = selectedGoalIds.length
    ? resolveGoals(template, selectedGoalIds)
    : template.premiumGoals; // fallback: all goals for this age group

  try {
    // ── 3. Call Claude: parse goals + build master strategy ──────────────────
    const aiResult = await parseGoalsAndStrategy({
      childName:           child.name,
      ageMonths:           ageMs,
      gender:              child.gender,
      disabilities:        child.disabilities as string[],
      parentGoalPrompt:    booking.parentGoalPrompt ?? '',
      selectedGoals,
      dailyPlanSlots:      template.requestedDailyPlan.additionalNotes,
      bookingDurationDays: durationDays,
    });

    // ── 4. Write ChildGoal[] ─────────────────────────────────────────────────
    await prisma.childGoal.deleteMany({
      where: { bookingId, childId: child.id },
    });

    const createdGoals = await Promise.all(
      aiResult.parsedGoals.map((g) =>
        prisma.childGoal.create({
          data: {
            bookingId,
            childId:          child.id,
            name:             g.name,
            category:         toGoalCategory(g.category),
            priority:         toGoalPriority(g.priority),
            timelineMonths:   g.timelineMonths,
            parentDescription: g.parentDescription,
            milestones:       g.milestones as any,
          },
        }),
      ),
    );

    log.info(`Created ${createdGoals.length} ChildGoals for booking ${bookingId}`);

    // ── 5. Write DailyPlan (master) ──────────────────────────────────────────
    const mp = aiResult.masterPlan;

    // One DailyPlan per child — upsert so re-runs don't duplicate
    const dailyPlan = await prisma.dailyPlan.upsert({
      where:  { bookingId },
      update: {
        overallStrategy:     mp.overallStrategy,
        weeklyFocusAreas:    mp.weeklyFocusAreas as any,
        difficultyLevel:     toPlanDifficulty(mp.difficultyLevel),
        totalPlannedMinutes: mp.totalPlannedMinutes,
        restWindows:         mp.restWindows,
        rawAiResponse:       aiResult.rawResponse as any,
        generatedAt:         new Date(),
      },
      create: {
        bookingId,
        childId:             child.id,
        overallStrategy:     mp.overallStrategy,
        weeklyFocusAreas:    mp.weeklyFocusAreas as any,
        difficultyLevel:     toPlanDifficulty(mp.difficultyLevel),
        totalPlannedMinutes: mp.totalPlannedMinutes,
        restWindows:         mp.restWindows,
        rawAiResponse:       aiResult.rawResponse as any,
      },
    });

    // ── 6. Mark booking as AI-plan-generated ─────────────────────────────────
    await prisma.booking.update({
      where: { id: bookingId },
      data:  {
        aiPlanGenerated:   true,
        aiPlanGeneratedAt: new Date(),
        aiPlanError:       null,
      },
    });

    // ── 7. Generate today's tasks immediately ─────────────────────────────────
    await generateAndSaveDailyTasks(dailyPlan.id);

    log.info(`AI plan complete for booking ${bookingId}`);
  } catch (err: any) {
    log.error(`AI plan failed for booking ${bookingId}: ${err.message}`);
    await prisma.booking.update({
      where: { id: bookingId },
      data:  { aiPlanError: err.message },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generateAndSaveDailyTasks
// Called every morning by cron + once on initial trigger above
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAndSaveDailyTasks(planId: string): Promise<void> {
  // ── 1. Load plan with child + goals ──────────────────────────────────────
  const plan = await prisma.dailyPlan.findUnique({
    where:   { id: planId },
    include: {
      child:   true,
      booking: {
        include: {
          childGoals:         true,
          requestedDailyPlan: true,
        },
      },
    },
  });

  if (!plan) {
    log.warn(`generateAndSaveDailyTasks: plan ${planId} not found`);
    return;
  }

  const child   = plan.child;
  const ageMs   = ageInMonths(child.birthDate);
  const template = getTemplateByAge(ageMs);

  // ── 2. Load last 7 days of task logs ─────────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const recentLogs = await prisma.taskLog.findMany({
    where: {
      task: {
        planId,
        forDate: { gte: sevenDaysAgo },
      },
    },
    include: { task: true },
    orderBy: { createdAt: 'desc' },
    take:    50,
  });

  const logSummaries = recentLogs.map((l) => ({
    taskTitle:       l.task.title,
    completionPct:   l.completionPct,
    engagementRating: l.engagementRating ?? undefined,
    moodRating:      l.moodRating ?? undefined,
    nannyNote:       l.nannyNote ?? undefined,
  }));

  // ── 3. Compute day number ─────────────────────────────────────────────────
  const start     = plan.booking.scheduledStartTime;
  const today     = new Date();
  const dayNumber = Math.max(
    1,
    Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1,
  );

  const todayStr = today.toISOString().split('T')[0]; // "YYYY-MM-DD"

  // ── 4. Get daily routine slots ─────────────────────────────────────────────
  const dailySlots = template?.requestedDailyPlan.additionalNotes ?? [];

  // ── 5. Call Claude ────────────────────────────────────────────────────────
  const goals = plan.booking.childGoals.map((g) => ({
    goalId:   g.id,
    name:     g.name,
    category: g.category,
  }));

  const aiResult = await generateDailyTasks({
    childName:        child.name,
    ageMonths:        ageMs,
    overallStrategy:  plan.overallStrategy ?? '',
    weeklyFocusAreas: plan.weeklyFocusAreas as any[],
    goals,
    dailyPlanSlots:   dailySlots,
    recentTaskLogs:   logSummaries,
    today:            todayStr,
    dayNumber,
  });

  // ── 6. Delete any existing PENDING tasks for today (re-generation) ────────
  await prisma.planTask.deleteMany({
    where: {
      planId,
      forDate: {
        gte: new Date(`${todayStr}T00:00:00.000Z`),
        lt:  new Date(`${todayStr}T23:59:59.999Z`),
      },
      status: TaskStatus.PENDING,
    },
  });

  // ── 7. Build a goalId lookup: AI returns our ChildGoal.id strings ─────────
  const goalIdSet = new Set(plan.booking.childGoals.map((g) => g.id));

  // ── 8. Write PlanTask[] ───────────────────────────────────────────────────
  await prisma.planTask.createMany({
    data: aiResult.tasks.map((t) => ({
      planId,
      childId:          child.id,
      goalId:           t.goalId && goalIdSet.has(t.goalId) ? t.goalId : null,
      forDate:          new Date(`${todayStr}T00:00:00.000Z`),
      title:            t.title,
      category:         toTaskCategory(t.category),
      durationMinutes:  t.durationMinutes,
      scheduledTime:    t.scheduledTime,
      difficulty:       toPlanDifficulty(t.difficulty),
      description:      t.description,
      materials:        t.materials,
      successIndicators: t.successIndicators,
      nannyNotes:       t.nannyNotes,
      skipIf:           t.skipIf,
      ifTooEasy:        t.ifTooEasy,
      ifTooHard:        t.ifTooHard,
      status:           TaskStatus.PENDING,
    })),
  });

  // ── 9. Update lastGeneratedDate on the plan ───────────────────────────────
  await prisma.dailyPlan.update({
    where: { id: planId },
    data:  { lastGeneratedDate: today },
  });

  log.info(
    `Generated ${aiResult.tasks.length} tasks for plan ${planId} (day ${dayNumber})`,
  );
}
