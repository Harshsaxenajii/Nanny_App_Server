/**
 * plan.service.ts
 *
 * Orchestrates the AI planning pipeline.
 * Reads from DB → calls AiService → writes results back to DB.
 * No Claude logic lives here — that is ai.service.ts's job.
 *
 * Exposed methods:
 *   generatePlan(bookingId)       — called once on booking confirmation
 *   generateDailyTasks(bookingId) — called every morning by the cron job
 */

import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { AiService, GoalContext } from "./ai.service";
import { ageInMonths } from "../utils/goalTemplates";
import { Prisma } from "@prisma/client";

const log = createLogger("plan");
const aiService = new AiService();

export class PlanService {
  // ── generatePlan ────────────────────────────────────────────────────────────
  // Triggered once when booking is confirmed (via POST /api/v1/plan/generate/:bookingId).
  // 1. Loads booking + child + goals from DB
  // 2. Calls AiService.generatePlan
  // 3. Saves DailyPlan
  // 4. Immediately generates today's first PlanTask[] as well
  // 5. Marks booking.aiPlanGenerated = true

  async generatePlan(bookingId: string) {
    log.info("generatePlan called for booking: %s", bookingId);

    // ── Load booking ──────────────────────────────────────────────────────────
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        children: true,
        childCollectionOfGoals: {
          include: { childGoals: true },
        },
      },
    });

    if (!booking) throw new AppError("Booking not found", 404);
    if (booking.aiPlanGenerated)
      throw new AppError("AI plan already generated for this booking", 409);
    if (!booking.parentGoalPrompt)
      throw new AppError("Booking has no parentGoalPrompt", 400);
    if (!booking.childCollectionOfGoals.length)
      throw new AppError(
        "No ChildCollectionOfGoals found for this booking",
        400
      );

    const goals = this.extractGoals(booking.childCollectionOfGoals);
    if (!goals.length)
      throw new AppError("No ChildGoals found for this booking", 400);

    const child = booking.children;
    const childAgeMonths = ageInMonths(child.birthDate);
    const bookingDays = Math.ceil(
      (booking.scheduledEndTime.getTime() -
        booking.scheduledStartTime.getTime()) /
        (1000 * 60 * 60 * 24)
    );

    // ── Call AI ───────────────────────────────────────────────────────────────
    const aiPlan = await aiService.generatePlan({
      parentGoalPrompt: booking.childCollectionOfGoals[0].childGoals[0].name,
      childAgeMonths,
      childGender: child.gender,
      bookingDays,
      goals,
    });

    // ── Save DailyPlan ────────────────────────────────────────────────────────
    const dailyPlan = await prisma.dailyPlan.create({
      data: {
        booking: { connect: { id: bookingId } },
        child: { connect: { id: child.id } },
        overallStrategy: aiPlan.overallStrategy,
        weeklyFocusAreas: aiPlan.weeklyFocusAreas,
        difficultyLevel: aiPlan.difficultyLevel,
        totalPlannedMinutes: aiPlan.totalPlannedMinutes,
        restWindows: aiPlan.restWindows ?? [],
        rawAiResponse: {
          ...aiPlan,
          lastGeneratedDate: new Date().toISOString(),
        } as Prisma.InputJsonValue,
        lastGeneratedDate: new Date(),
      },
    });
    log.info("DailyPlan saved: %s", dailyPlan.id);

    // ── Generate today's tasks immediately ────────────────────────────────────
    await this.generateDailyTasks(bookingId);

    // ── Flip flag on booking ──────────────────────────────────────────────────
    await prisma.booking.update({
      where: { id: bookingId },
      data: { aiPlanGenerated: true, aiPlanGeneratedAt: new Date() },
    });

    log.info("generatePlan complete for booking: %s", bookingId);
    return dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every morning by the cron job (and once inside generatePlan).
  // 1. Loads DailyPlan + goals + yesterday's TaskLog summary
  // 2. Calls AiService.generateDailyTasks
  // 3. Saves PlanTask[] for today

  async generateDailyTasks(bookingId: string) {
    log.info("generateDailyTasks called for booking: %s", bookingId);

    // ── Load plan + booking ───────────────────────────────────────────────────
    const dailyPlan = await prisma.dailyPlan.findUnique({
      where: { bookingId },
      include: {
        booking: {
          include: {
            children: true,
            childCollectionOfGoals: { include: { childGoals: true } },
          },
        },
      },
    });

    if (!dailyPlan)
      throw new AppError(
        "No DailyPlan found for this booking — run generatePlan first",
        404
      );

    const booking = dailyPlan.booking;
    const child = booking.children;
    const childAgeMonths = ageInMonths(child.birthDate);
    const goals = this.extractGoals(booking.childCollectionOfGoals);

    // ── Work out which week of the booking we're in ───────────────────────────
    const daysSinceStart = Math.floor(
      (Date.now() - booking.scheduledStartTime.getTime()) /
        (1000 * 60 * 60 * 24)
    );
    const currentWeek = Math.min(Math.floor(daysSinceStart / 7) + 1, 5);

    // ── Build yesterday's task summary ────────────────────────────────────────
    const previousTaskSummary = await this.buildPreviousDaySummary(
      dailyPlan.id
    );

    // ── Call AI ───────────────────────────────────────────────────────────────
    const weeklyFocusAreas = dailyPlan.weeklyFocusAreas as {
      week: number;
      focus: string;
    }[];

    const aiTasks = await aiService.generateDailyTasks({
      parentGoalPrompt: booking.parentGoalPrompt ?? "",
      childAgeMonths,
      childGender: child.gender,
      overallStrategy: dailyPlan.overallStrategy ?? "",
      weeklyFocusAreas,
      currentWeek,
      goals,
      previousTaskSummary,
    });

    // ── Save PlanTask[] for today ─────────────────────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Delete any existing tasks for today (idempotent — safe to re-run)
    await prisma.planTask.deleteMany({
      where: {
        planId: dailyPlan.id,
        forDate: { gte: today, lte: new Date(today.getTime() + 86400000 - 1) },
      },
    });

    const savedTasks = await Promise.all(
      aiTasks.map((t) =>
        prisma.planTask.create({
          data: {
            plan: { connect: { id: dailyPlan.id } },
            child: { connect: { id: child.id } },
            ...(t.goalId ? { goal: { connect: { id: t.goalId } } } : {}),
            forDate: today,
            title: t.title,
            category: t.category,
            durationMinutes: t.durationMinutes,
            scheduledTime: t.scheduledTime,
            difficulty: t.difficulty,
            description: t.description,
            materials: t.materials,
            successIndicators: t.successIndicators,
            nannyNotes: t.nannyNotes || null,
            skipIf: t.skipIf || null,
            ifTooEasy: t.ifTooEasy || null,
            ifTooHard: t.ifTooHard || null,
            status: "PENDING",
          },
        })
      )
    );

    // ── Update lastGeneratedDate on plan ──────────────────────────────────────
    await prisma.dailyPlan.update({
      where: { id: dailyPlan.id },
      data: { lastGeneratedDate: new Date() },
    });

    log.info(
      "%d tasks generated for booking %s (week %d)",
      savedTasks.length,
      bookingId,
      currentWeek
    );
    return savedTasks;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  // Flattens ChildCollectionOfGoals[] → GoalContext[]
  private extractGoals(
    collections: {
      childGoals: {
        id: string;
        name: string;
        category: string;
        priority: string;
        parentDescription: string;
        milestones: unknown;
        timelineMonths: number | null;
      }[];
    }[]
  ): GoalContext[] {
    return collections.flatMap((col) =>
      col.childGoals.map((g) => ({
        id: g.id,
        name: g.name,
        category: g.category,
        priority: g.priority,
        parentDescription: g.parentDescription,
        milestones: g.milestones as { week: number; target: string }[],
        timelineMonths: g.timelineMonths,
      }))
    );
  }

  // Builds a plain-English summary of yesterday's completions for Claude's context
  private async buildPreviousDaySummary(planId: string): Promise<string> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday.getTime() + 86400000 - 1);

    const tasks = await prisma.planTask.findMany({
      where: {
        planId,
        forDate: { gte: yesterday, lte: yesterdayEnd },
      },
      include: { log: true, goal: true },
    });

    if (!tasks.length) return "No tasks were scheduled yesterday.";

    const lines = tasks.map((t) => {
      const status = t.log?.completionPct
        ? `completed ${t.log.completionPct}%`
        : t.status === "SKIPPED"
        ? "skipped"
        : "not logged";

      const mood = t.log?.moodRating ? `, mood ${t.log.moodRating}/5` : "";
      const eng = t.log?.engagementRating
        ? `, engagement ${t.log.engagementRating}/5`
        : "";
      const note = t.log?.nannyNote ? `. Nanny note: "${t.log.nannyNote}"` : "";

      return `- "${t.title}" (${t.category}): ${status}${mood}${eng}${note}`;
    });

    return lines.join("\n");
  }
}
