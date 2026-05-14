/**
 * ai.service.ts
 *
 * Single responsibility: talk to Gemini.
 * Takes structured input, returns structured output.
 * No DB access — that is plan.service.ts's job.
 *
 * Methods:
 *   generatePlan(input)           — called once per booking; creates master strategy
 *   generateDailyTasks(input)     — called every morning; blends routine + goal tasks
 *   generateMonthlySummary(input) — called 1st of each month; parent-facing report
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger }        from '../utils/logger';
import { AppError }            from '../utils/AppError';

const log = createLogger('ai');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoalContext {
  id:                string;
  name:              string;
  category:          string;
  priority:          string;
  parentDescription: string;
  milestones:        { week: number; target: string }[];
  timelineMonths:    number | null;
}

export interface GeneratePlanInput {
  parentGoalPrompt: string;
  childAgeMonths:   number;
  childGender:      string;
  bookingDays:      number;
  goals:            GoalContext[];
}

export interface AiDailyPlan {
  overallStrategy:     string;
  weeklyFocusAreas:    { week: number; focus: string }[];
  difficultyLevel:     'LOW' | 'MEDIUM' | 'HIGH';
  totalPlannedMinutes: number;
  restWindows:         string[];
}

export interface GenerateDailyTasksInput {
  parentGoalPrompt:       string;
  childAgeMonths:         number;
  childGender:            string;
  overallStrategy:        string;
  weeklyFocusAreas:       { week: number; focus: string }[];
  currentWeek:            number;
  goals:                  GoalContext[];
  previousTaskSummary:    string;
  yesterdayDayScore:      number | null;  // 0-100 avg completion of goal tasks; null on day 1
  parentRequestedRoutine: { time: string; task: string }[];
}

export interface AiTask {
  goalId:            string | null;  // null for ROUTINE tasks that have no goal link
  title:             string;
  category:          'COGNITIVE' | 'PHYSICAL' | 'SOCIAL' | 'EMOTIONAL' | 'CREATIVE' | 'ROUTINE';
  durationMinutes:   number;
  scheduledTime:     string;
  difficulty:        'LOW' | 'MEDIUM' | 'HIGH';
  description:       string;
  materials:         string[];
  successIndicators: string[];
  nannyNotes:        string;
  skipIf:            string;
  ifTooEasy:         string;
  ifTooHard:         string;
}

export interface GenerateMonthlyInput {
  childAgeMonths: number;
  childGender:    string;
  month:          string;  // "YYYY-MM"
  categoryStats:  {
    category:       string;
    avgProgress:    number;
    totalTasks:     number;
    completedTasks: number;
  }[];
  goals: {
    name:          string;
    category:      string;
    completionPct: number;
  }[];
}

export interface AiMonthlySummary {
  narrative:        string;
  overallScore:     number;
  categoryInsights: Record<string, string>;
  recommendations:  string[];
}

// Internal types for raw AI JSON shapes
interface RawAiTask extends Omit<AiTask, 'goalId'> {
  goalIndex: number;  // -1 = ROUTINE task with no goal link
}
interface RawPlanResponse  { dailyPlan: AiDailyPlan; }
interface RawTasksResponse { tasks: RawAiTask[]; }

// ─── Service ──────────────────────────────────────────────────────────────────

export class AiService {
  private gemini: GoogleGenerativeAI;

  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set in environment');
    }
    this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  // ── generatePlan ────────────────────────────────────────────────────────────
  // Called once per booking (by midnight cron) to build the master strategy.

  async generatePlan(input: GeneratePlanInput): Promise<AiDailyPlan> {
    log.info('generatePlan: child age %d months, %d days', input.childAgeMonths, input.bookingDays);

    const weeksCount = Math.ceil(input.bookingDays / 7);

    const prompt = `
You are an expert early childhood development planner for a professional nanny care platform in India.
You create structured, age-appropriate care plans that a trained nanny (not a therapist) can execute.

Your output must be a single valid JSON object. No markdown, no backticks, no explanation.
Schema:
{
  "dailyPlan": {
    "overallStrategy": string,
    "weeklyFocusAreas": [{ "week": number, "focus": string }],
    "difficultyLevel": "LOW" | "MEDIUM" | "HIGH",
    "totalPlannedMinutes": number,
    "restWindows": string[]
  }
}

Parent's goal for their child:
"${input.parentGoalPrompt}"

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}
- Booking duration: ${input.bookingDays} days (${weeksCount} weeks)

Structured goals selected by parent:
${this.formatGoals(input.goals)}

Rules:
- weeklyFocusAreas must have exactly ${weeksCount} entries (one per week).
- restWindows: time ranges like "12:30 PM - 1:30 PM".
- overallStrategy: 2-3 sentences describing the core developmental approach.
- totalPlannedMinutes: total structured goal-activity time per day (120-180 recommended).

Return only valid JSON.
    `.trim();

    const raw    = await this.callGemini(prompt);
    const parsed = this.parseJson<RawPlanResponse>(raw, 'generatePlan');
    this.validatePlan(parsed.dailyPlan);
    return parsed.dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every morning.  Blends parent's daily routine with goal-focused tasks.
  // ROUTINE tasks use goalIndex: -1 (no goal link).
  // GOAL tasks use goalIndex 0..N-1 (mapped to real ChildGoal.id after parsing).

  async generateDailyTasks(input: GenerateDailyTasksInput): Promise<AiTask[]> {
    log.info('generateDailyTasks: week %d, age %d months', input.currentWeek, input.childAgeMonths);

    const weekFocus = input.weeklyFocusAreas.find((w) => w.week === input.currentWeek);

    const routineSection = input.parentRequestedRoutine.length
      ? `Parent's daily routine (include each slot as a ROUTINE task, goalIndex: -1):\n` +
        input.parentRequestedRoutine.map((r) => `  ${r.time}: ${r.task}`).join('\n')
      : `Parent's routine: not specified — add sensible caregiving slots (bath, meals, nap) as ROUTINE tasks.`;

    const scoreSection = input.yesterdayDayScore !== null
      ? `Yesterday's goal-task score: ${input.yesterdayDayScore}/100 — ` +
        (input.yesterdayDayScore >= 75
          ? 'child performed well; maintain or slightly increase difficulty.'
          : input.yesterdayDayScore >= 50
          ? 'moderate performance; keep similar difficulty.'
          : 'child found tasks hard; reduce difficulty and simplify steps.')
      : 'First day — no performance data yet. Start with MEDIUM difficulty.';

    const prompt = `
You are an expert early childhood development planner for a professional nanny care platform in India.
Generate a full daily schedule that blends routine caregiving with goal-focused development activities.

Task types:
- ROUTINE tasks (goalIndex: -1, category: "ROUTINE"): Caregiving — bath, meals, nap, outdoor walk, storytime.
  Include ALL parent-requested routine slots as-is. Add any obvious caregiving slots not listed.
- GOAL tasks (goalIndex: 0..N-1, category: any except ROUTINE): Development activities mapped to a specific goal.
  Generate 4-6 goal tasks woven around the routine.

Scheduling rules:
- Order all tasks chronologically by scheduledTime.
- Total duration of GOAL tasks only: 120-180 minutes.
- Never place two consecutive GOAL tasks of the same category.
- ${scoreSection}
- materials, successIndicators, skipIf, ifTooEasy, ifTooHard must be specific and actionable.

Your output must be a single valid JSON object. No markdown, no backticks, no explanation.
Schema:
{
  "tasks": [{
    "goalIndex": number,
    "title": string,
    "category": "COGNITIVE" | "PHYSICAL" | "SOCIAL" | "EMOTIONAL" | "CREATIVE" | "ROUTINE",
    "durationMinutes": number,
    "scheduledTime": string,
    "difficulty": "LOW" | "MEDIUM" | "HIGH",
    "description": string,
    "materials": string[],
    "successIndicators": string[],
    "nannyNotes": string,
    "skipIf": string,
    "ifTooEasy": string,
    "ifTooHard": string
  }]
}

Parent's overall goal: "${input.parentGoalPrompt}"

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}

Overall strategy: "${input.overallStrategy}"

Week ${input.currentWeek} focus: "${weekFocus?.focus ?? 'Continue building on previous week'}"

${routineSection}

Yesterday's task summary (adapt today based on this):
${input.previousTaskSummary}

Goals (reference by goalIndex for GOAL tasks):
${this.formatGoals(input.goals)}

Return only valid JSON.
    `.trim();

    const raw    = await this.callGemini(prompt);
    const parsed = this.parseJson<RawTasksResponse>(raw, 'generateDailyTasks');

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new AppError('AI returned no tasks', 500);
    }

    // Resolve goalIndex → real ChildGoal.id  (goalIndex < 0 or out-of-range → null)
    return parsed.tasks.map((t) => {
      const goal = (t.goalIndex >= 0 && t.goalIndex < input.goals.length)
        ? input.goals[t.goalIndex]
        : null;

      if (t.goalIndex >= 0 && !goal) {
        log.warn('Task "%s" has invalid goalIndex %d — goal link set to null', t.title, t.goalIndex);
      }

      return {
        goalId:            goal?.id ?? null,
        title:             t.title,
        category:          t.category,
        durationMinutes:   t.durationMinutes,
        scheduledTime:     t.scheduledTime,
        difficulty:        t.difficulty,
        description:       t.description,
        materials:         t.materials         ?? [],
        successIndicators: t.successIndicators ?? [],
        nannyNotes:        t.nannyNotes        ?? '',
        skipIf:            t.skipIf            ?? '',
        ifTooEasy:         t.ifTooEasy         ?? '',
        ifTooHard:         t.ifTooHard         ?? '',
      };
    });
  }

  // ── generateMonthlySummary ──────────────────────────────────────────────────
  // Called on 1st of each month (by monthly cron) to produce a parent-facing report.

  async generateMonthlySummary(input: GenerateMonthlyInput): Promise<AiMonthlySummary> {
    log.info('generateMonthlySummary: month %s', input.month);

    const categoryLines = input.categoryStats.length
      ? input.categoryStats
          .map((c) =>
            `  ${c.category}: ${c.avgProgress}% avg progress` +
            ` (${c.completedTasks}/${c.totalTasks} tasks completed)`,
          )
          .join('\n')
      : '  No activity data recorded.';

    const goalLines = input.goals.length
      ? input.goals
          .map((g) => `  ${g.name} (${g.category}): ${g.completionPct}% complete`)
          .join('\n')
      : '  No goals set.';

    const prompt = `
You are a child development specialist writing a monthly progress report for parents on a nanny care platform in India.
Be warm, encouraging, and use simple parent-friendly language.

Your output must be a single valid JSON object. No markdown, no backticks, no explanation.
Schema:
{
  "narrative": string,
  "overallScore": number,
  "categoryInsights": { "<CATEGORY_NAME>": string },
  "recommendations": string[]
}

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}
- Month: ${input.month}

Category performance this month:
${categoryLines}

Goal progress:
${goalLines}

Rules:
- narrative: 3-4 warm, encouraging sentences summarising the month for parents.
- overallScore: 0-100, weighted average of category progress percentages.
- categoryInsights: one concise, parent-friendly sentence per category that had activity.
- recommendations: 3-5 specific, actionable suggestions for next month.

Return only valid JSON.
    `.trim();

    const raw    = await this.callGemini(prompt);
    const parsed = this.parseJson<AiMonthlySummary>(raw, 'generateMonthlySummary');
    return parsed;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async callGemini(prompt: string): Promise<string> {
    const model  = this.gemini.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();

    if (!raw) throw new AppError('Gemini returned an empty response', 500);

    return raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i,     '')
      .replace(/```\s*$/i,     '')
      .trim();
  }

  private parseJson<T>(raw: string, context: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      log.error('Gemini returned invalid JSON in %s:\n%s', context, raw);
      throw new AppError(`AI response was not valid JSON (${context})`, 500);
    }
  }

  private formatGoals(goals: GoalContext[]): string {
    return goals
      .map(
        (g, i) =>
          `[${i}] ${g.name} (${g.category}, ${g.priority} priority)\n` +
          `    Parent said: "${g.parentDescription}"\n` +
          `    Milestones: ${g.milestones.map((m) => `Week ${m.week}: ${m.target}`).join(' | ')}`,
      )
      .join('\n\n');
  }

  private validatePlan(plan: AiDailyPlan): void {
    if (!plan?.overallStrategy)          throw new AppError('AI plan missing overallStrategy', 500);
    if (!plan?.weeklyFocusAreas?.length) throw new AppError('AI plan missing weeklyFocusAreas', 500);
    if (!plan?.difficultyLevel)          throw new AppError('AI plan missing difficultyLevel', 500);
    if (!plan?.totalPlannedMinutes)      throw new AppError('AI plan missing totalPlannedMinutes', 500);
  }
}
