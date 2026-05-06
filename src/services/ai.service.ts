/**
 * ai.service.ts
 *
 * Single responsibility: talk to Gemini.
 * Takes structured input, returns structured output.
 * No DB access — that is plan.service.ts's job.
 *
 * Exposed methods:
 *   generatePlan(input)       — called at 12 AM on booking start day
 *   generateDailyTasks(input) — called every morning by the cron job
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger }        from '../utils/logger';
import { AppError }            from '../utils/AppError';

const log = createLogger('ai');

// ─── Types (consumed by plan.service.ts) ─────────────────────────────────────

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
  parentGoalPrompt:       string;                           // FIX: restored — critical context
  childAgeMonths:         number;
  childGender:            string;
  overallStrategy:        string;
  weeklyFocusAreas:       { week: number; focus: string }[];
  currentWeek:            number;
  goals:                  GoalContext[];
  previousTaskSummary:    string;
  parentRequestedRoutine: { time: string; task: string }[]; // FIX: added — parent's routine
}

export interface AiTask {
  goalId:            string;
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

interface RawAiTask extends Omit<AiTask, 'goalId'> {
  goalIndex: number;
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
  // Called once at 12 AM on the day the booking starts.

  async generatePlan(input: GeneratePlanInput): Promise<AiDailyPlan> {
    log.info('Generating master plan (child age: %d months, %d days)', input.childAgeMonths, input.bookingDays);

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
- restWindows should be time ranges like "12:30 PM - 1:30 PM".
- overallStrategy should be 2-3 sentences describing the core approach.
- totalPlannedMinutes is the total structured activity per day (120-180 recommended).

Return only valid JSON.
    `.trim();

    const raw    = await this.callGemini(prompt);
    const parsed = this.parseJson<RawPlanResponse>(raw, 'generatePlan');

    this.validatePlan(parsed.dailyPlan);
    return parsed.dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every morning by the cron job.
  // Uses yesterday's TaskLog + parent's requested routine to adapt tasks.

  async generateDailyTasks(input: GenerateDailyTasksInput): Promise<AiTask[]> {
    log.info('Generating daily tasks (week %d, child age: %d months)', input.currentWeek, input.childAgeMonths);

    const weekFocus = input.weeklyFocusAreas.find((w) => w.week === input.currentWeek);

    // FIX: build routine section properly — was a dead comment before
    const routineSection = input.parentRequestedRoutine.length
      ? `Parent's requested routine for today (weave goal tasks around this):\n` +
        input.parentRequestedRoutine.map((r) => `  ${r.time}: ${r.task}`).join('\n')
      : `Parent's requested routine: not specified — use your best judgement for the day's structure.`;

    const prompt = `
You are an expert early childhood development planner for a professional nanny care platform in India.
You generate a daily activity schedule for a trained nanny to execute.

Rules:
- Total structured activity: 120-180 minutes spread across the day.
- Vary categories — never schedule two consecutive tasks of the same category.
- Tasks must be ordered chronologically by scheduledTime.
- Each task must map to exactly one goal via goalIndex (0-based index into goals array).
- Respect the parent's requested routine where possible — weave goal tasks around it.
- materials, successIndicators, skipIf, ifTooEasy, ifTooHard must be specific and actionable.
- Adapt difficulty based on yesterday's performance — if child struggled, reduce difficulty. If too easy, increase.

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

Parent's overall goal for their child:
"${input.parentGoalPrompt}"

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}

Overall strategy for this booking:
"${input.overallStrategy}"

Week ${input.currentWeek} focus:
"${weekFocus?.focus ?? 'Continue building on previous week'}"

${routineSection}

Yesterday's task summary (adapt today based on this):
${input.previousTaskSummary}

Goals (reference by goalIndex in tasks):
${this.formatGoals(input.goals)}

Return only valid JSON.
    `.trim();

    const raw    = await this.callGemini(prompt);
    const parsed = this.parseJson<RawTasksResponse>(raw, 'generateDailyTasks');

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new AppError('AI returned no tasks', 500);
    }

    // Resolve goalIndex → real ChildGoal.id
    return parsed.tasks.map((t) => {
      const goal = input.goals[t.goalIndex];
      if (!goal) {
        log.warn('Task "%s" has invalid goalIndex %d — goal link will be null', t.title, t.goalIndex);
      }
      return {
        goalId:            goal?.id            ?? '',
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async callGemini(prompt: string): Promise<string> {
    const model  = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();

    if (!raw) throw new AppError('Gemini returned an empty response', 500);

    // Strip markdown fences Gemini adds despite instructions
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
