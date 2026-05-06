/**
 * plan.service.ts
 *
 * Orchestrates the AI planning pipeline.
 * Reads from DB → calls AiService → writes results back to DB.
 *
 * Fixes in this version vs uploaded file:
 *   1. getDailyPlan uses setUTCHours not setHours
 *   2. forDate stored as noon UTC (no IST bleed)
 *   3. todayMidnight defined before planTask.create
 *   4. parentGoalPrompt restored in generateDailyTasks call
 *   5. parentRequestedRoutine loaded and passed to AI
 *   6. unused yesterday/yesterdayEnd removed from generateDailyTasks
 *   7. assessYesterday included (uses prisma as any until schema generate)
 */

import { prisma }                 from "../config/prisma";
import { AppError }               from "../utils/AppError";
import { createLogger }           from "../utils/logger";
import { AiService, GoalContext } from "./ai.service";
import { ageInMonths }            from "../utils/goalTemplates";
import { Prisma }                 from "@prisma/client";

const log       = createLogger("plan");
const aiService = new AiService();

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
          where: { forDate: { gte: todayStart, lte: todayEnd } },
        },
      },
    });

    if (!plan) throw new AppError("Daily Plan not found", 404);

    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      const isParent = plan.booking.userId === userId;
      const isNanny  = plan.booking.nanny?.userId === userId;
      if (!isParent && !isNanny)
        throw new AppError("You do not have permission to view this plan", 403);
    }

    return plan;
  }

  // ── generatePlan ────────────────────────────────────────────────────────────
  // Called at 12 AM on the day the booking starts (by the cron job).
  // childGoals is a direct relation on Booking.

  async generatePlan(bookingId: string) {
    log.info("generatePlan called for booking: %s", bookingId);

    const booking = await prisma.booking.findUnique({
      where:   { id: bookingId },
      include: {
        children:   true,
        childGoals: true,
        requestedDayWiseDailyPlan: {
          include: { requestedDailyPlan: true },
          orderBy: { date: "desc" },
        },
      },
    });

    if (!booking)
      throw new AppError("Booking not found", 404);
    if (booking.aiPlanGenerated)
      throw new AppError("AI plan already generated for this booking", 409);
    if (!booking.childGoals.length)
      throw new AppError("No ChildGoals found for this booking", 400);

    const goals          = this.extractGoals(booking.childGoals);
    const child          = booking.children;
    const childAgeMonths = ageInMonths(child.birthDate);
    const bookingDays    = Math.ceil(
      (booking.scheduledEndTime.getTime() - booking.scheduledStartTime.getTime()) /
      (1000 * 60 * 60 * 24),
    );

  const parentGoalPrompt = booking.childGoals
    .map((g) => g.parentDescription)
    .join(". ");

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
    log.info("DailyPlan saved: %s", dailyPlan.id);

    await this.generateDailyTasks(bookingId);

    await prisma.booking.update({
      where: { id: bookingId },
      data:  { aiPlanGenerated: true, aiPlanGeneratedAt: new Date() },
    });

    log.info("generatePlan complete for booking: %s", bookingId);
    return dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every morning by the cron job, and once inside generatePlan.

  async generateDailyTasks(bookingId: string) {
    log.info("generateDailyTasks called for booking: %s", bookingId);

    const dailyPlan = await prisma.dailyPlan.findUnique({
      where:   { bookingId },
      include: {
        booking: {
          include: {
            children:   true,
            childGoals: true,
            requestedDayWiseDailyPlan: {
              include: { requestedDailyPlan: true },
              orderBy: { date: "desc" },
            },
          },
        },
      },
    });

    if (!dailyPlan)
      throw new AppError(
        "No DailyPlan found for this booking — run generatePlan first",
        404,
      );

    const booking        = dailyPlan.booking;
    const child          = booking.children;
    const childAgeMonths = ageInMonths(child.birthDate);
    const goals          = this.extractGoals(booking.childGoals);

    // ── Which week of the booking we're in ───────────────────────────────────
    const daysSinceStart = Math.floor(
      (Date.now() - booking.scheduledStartTime.getTime()) /
      (1000 * 60 * 60 * 24),
    );
    const currentWeek = Math.min(Math.floor(daysSinceStart / 7) + 1, 5);

    // ── Today midnight UTC ────────────────────────────────────────────────────
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);

    // ── Pick parent's requested routine for today, fall back to latest ────────
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

    // ── Yesterday's summary for AI context ───────────────────────────────────
    const previousTaskSummary = await this.buildPreviousDaySummary(dailyPlan.id);

    const weeklyFocusAreas = dailyPlan.weeklyFocusAreas as {
      week: number;
      focus: string;
    }[];

    const parentGoalPrompt = booking.childGoals
    .map((g) => `${g.name}: ${g.parentDescription}`)
    .join(". ");

    const aiTasks = await aiService.generateDailyTasks({
      parentGoalPrompt,
      childAgeMonths,
      childGender:            child.gender,
      overallStrategy:        dailyPlan.overallStrategy ?? "",
      weeklyFocusAreas,
      currentWeek,
      goals,
      previousTaskSummary,
      parentRequestedRoutine,
    });

    // ── forDate stored as noon UTC — avoids IST/UTC midnight bleed ───────────
    const forDate = new Date(Date.UTC(
      todayMidnight.getUTCFullYear(),
      todayMidnight.getUTCMonth(),
      todayMidnight.getUTCDate(),
      12, 0, 0, 0,
    ));

    // ── Delete existing tasks for today (idempotent) ──────────────────────────
    const todayEnd = new Date(todayMidnight.getTime() + 86400000 - 1);
    await prisma.planTask.deleteMany({
      where: {
        planId:  dailyPlan.id,
        forDate: { gte: todayMidnight, lte: todayEnd },
      },
    });

    const savedTasks = await Promise.all(
      aiTasks.map((t: any) =>
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
            status:            "PENDING",
          },
        }),
      ),
    );

    await prisma.dailyPlan.update({
      where: { id: dailyPlan.id },
      data:  { lastGeneratedDate: new Date() },
    });

    log.info(
      "%d tasks generated for booking %s (week %d)",
      savedTasks.length,
      bookingId,
      currentWeek,
    );
    return savedTasks;
  }

  // ── assessYesterday ─────────────────────────────────────────────────────────
  // Called by cron BEFORE generateDailyTasks.
  // Reads yesterday's PlanTask[] + TaskLog[] → writes ChildDevelopmentLog.
  // Uses (prisma as any) until schema changes are applied + prisma generate run.

  async assessYesterday(bookingId: string): Promise<void> {
    log.info("assessYesterday called for booking: %s", bookingId);

    const dailyPlan = await prisma.dailyPlan.findUnique({
      where:   { bookingId },
      include: {
        booking: {
          include: { children: true, childGoals: true },
        },
      },
    });

    if (!dailyPlan) return;

    const booking = dailyPlan.booking;
    const child   = booking.children;

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday.getTime() + 86400000 - 1);

    const tasks = await prisma.planTask.findMany({
      where: {
        planId:  dailyPlan.id,
        forDate: { gte: yesterday, lte: yesterdayEnd },
      },
      include: { log: true, goal: true },
    });

    if (!tasks.length) {
      log.info("No tasks for yesterday — skipping assessment for booking: %s", bookingId);
      return;
    }

    const byCategory: Record<string, typeof tasks> = {};
    for (const task of tasks) {
      if (!byCategory[task.category]) byCategory[task.category] = [];
      byCategory[task.category].push(task);
    }

    const daysSinceStart = Math.floor(
      (yesterday.getTime() - booking.scheduledStartTime.getTime()) /
      (1000 * 60 * 60 * 24),
    );
    const weekNumber = Math.min(Math.floor(daysSinceStart / 7) + 1, 5);

    const developmentSummary: Record<string, {
      progressPct: number;
      summary:     string;
      lastUpdated: string;
    }> = {};

    for (const [category, categoryTasks] of Object.entries(byCategory)) {
      const total     = categoryTasks.length;
      const completed = categoryTasks.filter((t) => t.status === "COMPLETED").length;
      const skipped   = categoryTasks.filter((t) => t.status === "SKIPPED").length;

      const completionPcts = categoryTasks
        .filter((t) => t.log?.completionPct)
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
      ].filter(Boolean).join(", ");

      const aiSummary =
        progressPct >= 80
          ? `Strong performance in ${category.toLowerCase()} activities today.`
          : progressPct >= 50
          ? `Moderate progress in ${category.toLowerCase()} — some tasks need revisiting.`
          : `Challenging day for ${category.toLowerCase()} — consider reducing difficulty.`;

      const categoryGoals = booking.childGoals.filter((g) => g.category === category);

      // Uses (prisma as any) until ChildDevelopmentLog schema is applied
      await (prisma as any).childDevelopmentLog.create({
        data: {
          child:           { connect: { id: child.id } },
          ...(categoryGoals[0] ? { goal: { connect: { id: categoryGoals[0].id } } } : {}),
          category,
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

      for (const goal of categoryGoals) {
        const goalTasks     = categoryTasks.filter((t) => t.goalId === goal.id);
        if (!goalTasks.length) continue;
        const goalCompleted = goalTasks.filter((t) => t.status === "COMPLETED").length;
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
        lastUpdated: yesterday.toISOString().split("T")[0],
      };
    }

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
      "assessYesterday complete for booking %s — %d categories, week %d",
      bookingId,
      Object.keys(byCategory).length,
      weekNumber,
    );
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

  private async buildPreviousDaySummary(planId: string): Promise<string> {
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

    if (!tasks.length) return "No tasks were scheduled yesterday.";

    return tasks.map((t) => {
      const status = t.log?.completionPct
        ? `completed ${t.log.completionPct}%`
        : t.status === "SKIPPED"
        ? "skipped"
        : "not logged";
      const mood = t.log?.moodRating       ? `, mood ${t.log.moodRating}/5`             : "";
      const eng  = t.log?.engagementRating ? `, engagement ${t.log.engagementRating}/5` : "";
      const note = t.log?.nannyNote        ? `. Nanny note: "${t.log.nannyNote}"`        : "";
      return `- "${t.title}" (${t.category}): ${status}${mood}${eng}${note}`;
    }).join("\n");
  }
}