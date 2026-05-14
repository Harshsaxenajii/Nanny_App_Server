/**
 * plan.service.ts
 *
 * Orchestrates the AI planning pipeline.
 * Reads from DB → calls AiService → writes results back to DB.
 *
 * Public methods:
 *   generatePlan(bookingId)               — called at midnight for new bookings
 *   generateDailyTasks(bookingId)         — called every 5 AM for active bookings
 *   assessYesterday(bookingId)            — called before generateDailyTasks; writes ChildDevelopmentLog
 *   generateMonthlySummary(childId, y, m) — called 1st of month; writes Children.developmentSummary
 *   getDailyPlan(bookingId, userId, role) — read today's plan + tasks
 */

import { prisma }                 from '../config/prisma';
import { AppError }               from '../utils/AppError';
import { createLogger }           from '../utils/logger';
import { AiService, GoalContext } from './ai.service';
import { ageInMonths }            from '../utils/goalTemplates';
import { GoalCategory, Prisma }   from '@prisma/client';

const log       = createLogger('plan');
const aiService = new AiService();

// Returns the UTC Monday of a given ISO week (week 1 = week containing Jan 4)
function isoWeekStart(year: number, week: number): Date {
  const jan4      = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // 1=Mon … 7=Sun
  const week1Mon  = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
  return new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);
}

export class PlanService {

  // ── getDailyPlan ────────────────────────────────────────────────────────────

  async getDailyPlan(bookingId: string, userId: string, role: string) {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setUTCHours(23, 59, 59, 999);

    const plan = await prisma.dailyPlan.findUnique({
      where:   { bookingId },
      include: {
        booking: { include: { nanny: true } },
        tasks: {
          where:   { forDate: { gte: todayStart, lte: todayEnd } },
          orderBy: { scheduledTime: 'asc' },
          include: { goal: true, log: true },
        },
      },
    });

    if (!plan) throw new AppError('Daily Plan not found', 404);

    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      const isParent = plan.booking.userId === userId;
      const isNanny  = plan.booking.nanny?.userId === userId;
      if (!isParent && !isNanny)
        throw new AppError('You do not have permission to view this plan', 403);
    }

    return plan;
  }

  // ── generatePlan ────────────────────────────────────────────────────────────
  // Called by the midnight cron for every CONFIRMED FULL_TIME booking that
  // does not yet have an AI plan.  Creates the master DailyPlan record and
  // immediately generates day-1 tasks.

  async generatePlan(bookingId: string) {
    log.info('generatePlan: %s', bookingId);

    const booking = await prisma.booking.findUnique({
      where:   { id: bookingId },
      include: {
        children:   true,
        childGoals: true,
        requestedDayWiseDailyPlan: {
          include: { requestedDailyPlan: true },
          orderBy: { date: 'desc' },
        },
      },
    });

    if (!booking)                   throw new AppError('Booking not found', 404);
    if (booking.aiPlanGenerated)    throw new AppError('AI plan already generated for this booking', 409);
    if (!booking.childGoals.length) throw new AppError('No ChildGoals found for this booking', 400);

    const goals          = this.extractGoals(booking.childGoals);
    const child          = booking.children;
    const childAgeMonths = ageInMonths(child.birthDate);
    const bookingDays    = Math.ceil(
      (booking.scheduledEndTime.getTime() - booking.scheduledStartTime.getTime()) /
      (1000 * 60 * 60 * 24),
    );

    const parentGoalPrompt = booking.childGoals
      .map((g) => g.parentDescription)
      .join('. ');

    const aiPlan = await aiService.generatePlan({
      parentGoalPrompt,
      childAgeMonths,
      childGender: child.gender,
      bookingDays,
      goals,
    });

    const dailyPlan = await prisma.dailyPlan.create({
      data: {
        booking:             { connect: { id: bookingId } },
        child:               { connect: { id: child.id } },
        overallStrategy:     aiPlan.overallStrategy,
        weeklyFocusAreas:    aiPlan.weeklyFocusAreas,
        difficultyLevel:     aiPlan.difficultyLevel,
        totalPlannedMinutes: aiPlan.totalPlannedMinutes,
        restWindows:         aiPlan.restWindows ?? [],
        rawAiResponse:       aiPlan as unknown as Prisma.InputJsonValue,
        lastGeneratedDate:   new Date(),
      },
    });
    log.info('DailyPlan saved: %s', dailyPlan.id);

    // Only generate tasks immediately if the booking has already started.
    // For future bookings the 5 AM job will generate day-1 tasks on the correct date.
    if (booking.scheduledStartTime.getTime() <= Date.now()) {
      await this.generateDailyTasks(bookingId);
      log.info('generatePlan: booking already started — day-1 tasks generated');
    } else {
      log.info('generatePlan: booking starts in the future — day-1 tasks deferred to 5 AM job');
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data:  { aiPlanGenerated: true, aiPlanGeneratedAt: new Date() },
    });

    log.info('generatePlan complete: %s', bookingId);
    return dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every 5 AM (after assessYesterday) and once inside generatePlan.
  // Blends parent's daily routine + goal-focused development tasks.

  async generateDailyTasks(bookingId: string) {
    log.info('generateDailyTasks: %s', bookingId);

    const dailyPlan = await prisma.dailyPlan.findUnique({
      where:   { bookingId },
      include: {
        booking: {
          include: {
            children:   true,
            childGoals: true,
            requestedDayWiseDailyPlan: {
              include: { requestedDailyPlan: true },
              orderBy: { date: 'desc' },
            },
          },
        },
      },
    });

    if (!dailyPlan)
      throw new AppError('No DailyPlan found for this booking — run generatePlan first', 404);

    const booking        = dailyPlan.booking;
    const child          = booking.children;
    const childAgeMonths = ageInMonths(child.birthDate);
    const goals          = this.extractGoals(booking.childGoals);

    const daysSinceStart = Math.floor(
      (Date.now() - booking.scheduledStartTime.getTime()) / (1000 * 60 * 60 * 24),
    );
    const currentWeek = Math.min(Math.floor(daysSinceStart / 7) + 1, 5);

    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);

    // Pick parent's requested routine for today; fall back to latest
    const dayWisePlans  = booking.requestedDayWiseDailyPlan;
    const todaysDayWise = dayWisePlans.find((d) => {
      const d0 = new Date(d.date);
      d0.setUTCHours(0, 0, 0, 0);
      return d0.getTime() === todayMidnight.getTime();
    });
    const activeDayWise = todaysDayWise ?? dayWisePlans[0] ?? null;

    const parentRequestedRoutine: { time: string; task: string }[] =
      activeDayWise?.requestedDailyPlan.flatMap(
        (p) => p.additionalNotes as { time: string; task: string }[],
      ) ?? [];

    // Previous day summary + score (null on day 1)
    const { summary: previousTaskSummary, dayScore: yesterdayDayScore } =
      await this.buildPreviousDaySummary(dailyPlan.id);

    const weeklyFocusAreas = dailyPlan.weeklyFocusAreas as { week: number; focus: string }[];

    const parentGoalPrompt = booking.childGoals
      .map((g) => `${g.name}: ${g.parentDescription}`)
      .join('. ');

    const aiTasks = await aiService.generateDailyTasks({
      parentGoalPrompt,
      childAgeMonths,
      childGender:            child.gender,
      overallStrategy:        dailyPlan.overallStrategy ?? '',
      weeklyFocusAreas,
      currentWeek,
      goals,
      previousTaskSummary,
      yesterdayDayScore,
      parentRequestedRoutine,
    });

    // Store tasks at noon UTC to avoid IST/UTC midnight bleed
    const forDate = new Date(Date.UTC(
      todayMidnight.getUTCFullYear(),
      todayMidnight.getUTCMonth(),
      todayMidnight.getUTCDate(),
      12, 0, 0, 0,
    ));

    // Idempotent: delete existing tasks for today before recreating
    const todayEnd = new Date(todayMidnight.getTime() + 86400000 - 1);
    await prisma.planTask.deleteMany({
      where: {
        planId:  dailyPlan.id,
        forDate: { gte: todayMidnight, lte: todayEnd },
      },
    });

    const savedTasks = await Promise.all(
      aiTasks.map((t) =>
        prisma.planTask.create({
          data: {
            plan:              { connect: { id: dailyPlan.id } },
            child:             { connect: { id: child.id } },
            ...(t.goalId ? { goal: { connect: { id: t.goalId } } } : {}),
            forDate,
            title:             t.title,
            category:          t.category,
            durationMinutes:   t.durationMinutes,
            scheduledTime:     t.scheduledTime,
            difficulty:        t.difficulty,
            description:       t.description,
            materials:         t.materials,
            successIndicators: t.successIndicators,
            nannyNotes:        t.nannyNotes  || null,
            skipIf:            t.skipIf      || null,
            ifTooEasy:         t.ifTooEasy   || null,
            ifTooHard:         t.ifTooHard   || null,
            status:            'PENDING',
          },
        }),
      ),
    );

    await prisma.dailyPlan.update({
      where: { id: dailyPlan.id },
      data:  { lastGeneratedDate: new Date() },
    });

    log.info('%d tasks generated for booking %s (week %d)', savedTasks.length, bookingId, currentWeek);
    return savedTasks;
  }

  // ── assessYesterday ─────────────────────────────────────────────────────────
  // Called by the morning cron BEFORE generateDailyTasks.
  // Reads yesterday's PlanTask[] + TaskLog[] → writes ChildDevelopmentLog records
  // → updates ChildGoal completion → updates DailyPlan.dayScore
  // → merges category stats into Children.developmentSummary.

  async assessYesterday(bookingId: string): Promise<void> {
    log.info('assessYesterday: %s', bookingId);

    const dailyPlan = await prisma.dailyPlan.findUnique({
      where:   { bookingId },
      include: {
        booking: { include: { children: true, childGoals: true } },
      },
    });

    if (!dailyPlan) return;

    const booking = dailyPlan.booking;
    const child   = booking.children;

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday.getTime() + 86400000 - 1);

    // Idempotency guard: skip if we already assessed this child yesterday
    const alreadyAssessed = await prisma.childDevelopmentLog.findFirst({
      where: { childId: child.id, loggedAt: { gte: yesterday, lte: yesterdayEnd } },
    });
    if (alreadyAssessed) {
      log.info('assessYesterday: already done for child %s on %s — skipping', child.id, yesterday.toISOString().split('T')[0]);
      return;
    }

    const tasks = await prisma.planTask.findMany({
      where: {
        planId:  dailyPlan.id,
        forDate: { gte: yesterday, lte: yesterdayEnd },
      },
      include: { log: true, goal: true },
    });

    if (!tasks.length) {
      log.info('assessYesterday: no tasks yesterday for booking %s — skipping', bookingId);
      return;
    }

    // Group tasks by category
    const byCategory: Record<string, typeof tasks> = {};
    for (const task of tasks) {
      if (!byCategory[task.category]) byCategory[task.category] = [];
      byCategory[task.category].push(task);
    }

    const daysSinceStart = Math.floor(
      (yesterday.getTime() - booking.scheduledStartTime.getTime()) / (1000 * 60 * 60 * 24),
    );
    const weekNumber = Math.min(Math.floor(daysSinceStart / 7) + 1, 5);

    const developmentSummary: Record<string, { progressPct: number; summary: string; lastUpdated: string }> = {};

    for (const [category, categoryTasks] of Object.entries(byCategory)) {
      const total     = categoryTasks.length;
      const completed = categoryTasks.filter((t) => t.status === 'COMPLETED').length;
      const skipped   = categoryTasks.filter((t) => t.status === 'SKIPPED').length;

      const completionPcts = categoryTasks
        .filter((t) => t.log?.completionPct !== undefined && t.log.completionPct !== null)
        .map((t) => t.log!.completionPct);
      const avgCompletionPct = completionPcts.length
        ? Math.round(completionPcts.reduce((a, b) => a + b, 0) / completionPcts.length)
        : 0;

      const engagements = categoryTasks
        .filter((t) => t.log?.engagementRating)
        .map((t) => t.log!.engagementRating!);
      const avgEngagement = engagements.length
        ? Math.round(engagements.reduce((a, b) => a + b, 0) / engagements.length)
        : null;

      const moods = categoryTasks
        .filter((t) => t.log?.moodRating)
        .map((t) => t.log!.moodRating!);
      const avgMood = moods.length
        ? Math.round(moods.reduce((a, b) => a + b, 0) / moods.length)
        : null;

      const progressPct      = Math.round((completed / total) * 100);
      const milestoneReached = progressPct >= 80;

      const aiObservation = [
        `${completed}/${total} tasks completed (${progressPct}%)`,
        skipped > 0   ? `${skipped} skipped`                : null,
        avgEngagement ? `avg engagement: ${avgEngagement}/5` : null,
        avgMood       ? `avg mood: ${avgMood}/5`             : null,
      ].filter(Boolean).join(', ');

      const aiSummary =
        progressPct >= 80 ? `Strong performance in ${category.toLowerCase()} activities today.`
        : progressPct >= 50 ? `Moderate progress in ${category.toLowerCase()} — some tasks need revisiting.`
        : `Challenging day for ${category.toLowerCase()} — consider reducing difficulty.`;

      const categoryGoals = booking.childGoals.filter((g) => g.category === category);

      await prisma.childDevelopmentLog.create({
        data: {
          child:           { connect: { id: child.id } },
          ...(categoryGoals[0] ? { goal: { connect: { id: categoryGoals[0].id } } } : {}),
          category:        category as GoalCategory,
          weekNumber,
          progressPct,
          milestoneReached,
          aiObservation,
          aiSummary,
          totalTasks:      total,
          completedTasks:  completed,
          skippedTasks:    skipped,
          avgCompletionPct,
          avgEngagement,
          avgMood,
          loggedAt:        yesterday,
        },
      });

      // Update individual goal completion + milestone progression
      for (const goal of categoryGoals) {
        const goalTasks     = categoryTasks.filter((t) => t.goalId === goal.id);
        if (!goalTasks.length) continue;
        const goalCompleted = goalTasks.filter((t) => t.status === 'COMPLETED').length;
        const goalPct       = Math.round((goalCompleted / goalTasks.length) * 100);
        const newWeek       = goalPct >= 70
          ? Math.min(goal.currentMilestoneWeek + 1, 4)
          : goal.currentMilestoneWeek;

        await prisma.childGoal.update({
          where: { id: goal.id },
          data:  { completionPct: goalPct, currentMilestoneWeek: newWeek },
        });
      }

      developmentSummary[category] = {
        progressPct,
        summary:     aiSummary,
        lastUpdated: yesterday.toISOString().split('T')[0],
      };
    }

    // dayScore: average of goal-task nannyScores mapped from 1–5 to 0–100
    const goalTasksWithScore = tasks.filter((t) => t.goalId && t.nannyScore !== null);
    const dayScore = goalTasksWithScore.length > 0
      ? Math.round(
          goalTasksWithScore.reduce((sum, t) => sum + ((t.nannyScore! - 1) * 25), 0) /
          goalTasksWithScore.length,
        )
      : 0;

    await prisma.dailyPlan.update({
      where: { id: dailyPlan.id },
      data:  { dayScore, dayScoreAt: new Date() },
    });

    // Merge into Children.developmentSummary (keyed by category)
    const existingChild = await prisma.children.findUnique({
      where:  { id: child.id },
      select: { developmentSummary: true },
    });
    const existing = (existingChild?.developmentSummary ?? {}) as Record<string, unknown>;
    const merged   = { ...existing, ...developmentSummary };

    await prisma.children.update({
      where: { id: child.id },
      data:  { developmentSummary: merged as unknown as Prisma.InputJsonValue },
    });

    log.info(
      'assessYesterday complete: booking %s — %d categories, week %d, dayScore %d',
      bookingId, Object.keys(byCategory).length, weekNumber, dayScore,
    );
  }

  // ── generateWeeklySummary ───────────────────────────────────────────────────
  // Called by the weekly cron every Monday morning.
  // Aggregates ChildDevelopmentLog for the completed ISO week → AI narrative
  // → stored in Children.developmentSummary under key "YYYY-WXX".
  // Also purges PlanTask records older than 7 days to keep the DB lean.

  async generateWeeklySummary(childId: string, year: number, isoWeek: number): Promise<void> {
    const weekKey   = `${year}-W${String(isoWeek).padStart(2, '0')}`;
    const weekStart = isoWeekStart(year, isoWeek);
    const weekEnd   = new Date(weekStart.getTime() + 7 * 86400000 - 1);

    log.info('generateWeeklySummary: child %s, week %s', childId, weekKey);

    const child = await prisma.children.findUnique({
      where:   { id: childId },
      include: {
        developmentLogs: {
          where: { loggedAt: { gte: weekStart, lte: weekEnd } },
        },
        childGoals: true,
      },
    });

    if (!child || !child.developmentLogs.length) {
      log.info('generateWeeklySummary: no development logs for child %s in %s — skipping', childId, weekKey);
      return;
    }

    const categoryMap = new Map<string, { progressSum: number; total: number; completed: number; count: number }>();
    for (const entry of child.developmentLogs) {
      const prev = categoryMap.get(entry.category) ?? { progressSum: 0, total: 0, completed: 0, count: 0 };
      categoryMap.set(entry.category, {
        progressSum: prev.progressSum + entry.progressPct,
        total:       prev.total + entry.totalTasks,
        completed:   prev.completed + entry.completedTasks,
        count:       prev.count + 1,
      });
    }

    const categoryStats = Array.from(categoryMap.entries()).map(([category, data]) => ({
      category,
      avgProgress:    Math.round(data.progressSum / data.count),
      totalTasks:     data.total,
      completedTasks: data.completed,
    }));

    const childAgeMonths = ageInMonths(child.birthDate);

    const aiSummary = await aiService.generateWeeklySummary({
      childAgeMonths,
      childGender: child.gender,
      week:        weekKey,
      categoryStats,
      goals: child.childGoals.map((g) => ({
        name:          g.name,
        category:      g.category,
        completionPct: g.completionPct,
      })),
    });

    const existing = (child.developmentSummary ?? {}) as Record<string, unknown>;
    existing[weekKey] = { ...aiSummary, generatedAt: new Date().toISOString() };

    await prisma.children.update({
      where: { id: childId },
      data:  { developmentSummary: existing as unknown as Prisma.InputJsonValue },
    });

    log.info('generateWeeklySummary done: child %s, week %s', childId, weekKey);
  }

  // ── purgeStalePlanTasks ──────────────────────────────────────────────────────
  // Deletes PlanTask records older than 7 days for all active FULL_TIME bookings.
  // Called by the weekly cron AFTER weekly summaries are saved.

  async purgeStalePlanTasks(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 86400000);

    // Only delete from active bookings — completed bookings keep their history
    const activeBookingIds = (await prisma.booking.findMany({
      where:  { serviceType: 'FULL_TIME', status: { in: ['CONFIRMED', 'IN_PROGRESS'] } },
      select: { id: true },
    })).map((b) => b.id);

    if (!activeBookingIds.length) return 0;

    const activePlanIds = (await prisma.dailyPlan.findMany({
      where:  { bookingId: { in: activeBookingIds } },
      select: { id: true },
    })).map((p) => p.id);

    if (!activePlanIds.length) return 0;

    const { count } = await prisma.planTask.deleteMany({
      where: { planId: { in: activePlanIds }, forDate: { lt: cutoff } },
    });

    log.info('purgeStalePlanTasks: deleted %d tasks older than %s', count, cutoff.toISOString().split('T')[0]);
    return count;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private extractGoals(
    goals: {
      id:                string;
      name:              string;
      category:          string;
      priority:          string;
      parentDescription: string;
      milestones:        unknown;
      timelineMonths:    number | null;
    }[],
  ): GoalContext[] {
    return goals.map((g) => ({
      id:                g.id,
      name:              g.name,
      category:          g.category,
      priority:          g.priority,
      parentDescription: g.parentDescription,
      milestones:        g.milestones as { week: number; target: string }[],
      timelineMonths:    g.timelineMonths,
    }));
  }

  // Returns the text summary AND the computed dayScore (null if no goal tasks logged).
  private async buildPreviousDaySummary(
    planId: string,
  ): Promise<{ summary: string; dayScore: number | null }> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday.getTime() + 86400000 - 1);

    const tasks = await prisma.planTask.findMany({
      where: {
        planId,
        forDate: { gte: yesterday, lte: yesterdayEnd },
      },
      include: { log: true, goal: true },
    });

    if (!tasks.length) {
      return { summary: 'No tasks were scheduled yesterday.', dayScore: null };
    }

    // dayScore: average of goal-task nannyScores mapped 1–5 → 0–100
    const goalTasksWithScore = tasks.filter((t) => t.goalId && t.nannyScore !== null);
    const dayScore = goalTasksWithScore.length > 0
      ? Math.round(
          goalTasksWithScore.reduce((sum, t) => sum + ((t.nannyScore! - 1) * 25), 0) /
          goalTasksWithScore.length,
        )
      : null;

    const SCORE_LABELS: Record<number, string> = {
      1: 'Very Poor', 2: 'Poor', 3: 'Good', 4: 'Very Good', 5: 'Great',
    };

    const summary = tasks.map((t) => {
      const status = t.status === 'COMPLETED' ? 'completed'
        : t.status === 'SKIPPED' ? 'skipped'
        : 'pending';
      const scoreLabel = t.goalId && t.nannyScore
        ? ` [nanny score: ${SCORE_LABELS[t.nannyScore]} (${t.nannyScore}/5)]`
        : '';
      const note = t.log?.nannyNote ? `. Nanny note: "${t.log.nannyNote}"` : '';
      return `- "${t.title}" (${t.category}): ${status}${scoreLabel}${note}`;
    }).join('\n');

    return { summary, dayScore };
  }
}
