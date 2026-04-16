/**
 * ai.service.ts
 *
 * Single responsibility: talk to Claude.
 * Takes structured input, returns structured output.
 * No DB access — that is plan.service.ts's job.
 *
 * Exposed methods:
 *   generatePlan(input)  — called once when booking is confirmed
 *                          returns DailyPlan strategy + Week 1-5 focus areas
 *   generateDailyTasks(input) — called every morning by the cron job
 *                               returns today's PlanTask[]
 */

import Anthropic                   from '@anthropic-ai/sdk';
import { createLogger }            from '../utils/logger';
import { AppError }                from '../utils/AppError';

const log = createLogger('ai');

// ─── Re-exported types (plan.service + cron consume these) ───────────────────

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
  childGender:      string;        // 'BOY' | 'GIRL' | 'OTHER'
  bookingDays:      number;        // e.g. 35
  goals:            GoalContext[];
}

export interface AiDailyPlan {
  overallStrategy:     string;
  weeklyFocusAreas:    { week: number; focus: string }[];
  difficultyLevel:     'LOW' | 'MEDIUM' | 'HIGH';
  totalPlannedMinutes: number;
  restWindows:         string[];   // e.g. ["12:30 PM - 1:30 PM"]
}

export interface GenerateDailyTasksInput {
  parentGoalPrompt:    string;
  childAgeMonths:      number;
  childGender:         string;
  overallStrategy:     string;
  weeklyFocusAreas:    { week: number; focus: string }[];
  currentWeek:         number;     // which week of the booking we're in (1-based)
  goals:               GoalContext[];
  previousTaskSummary: string;     // brief summary of yesterday's completions
}

export interface AiTask {
  goalId:             string;      // real ChildGoal.id — resolved inside this service
  title:              string;
  category:           'COGNITIVE' | 'PHYSICAL' | 'SOCIAL' | 'EMOTIONAL' | 'CREATIVE' | 'ROUTINE';
  durationMinutes:    number;
  scheduledTime:      string;      // "HH:MM AM/PM"
  difficulty:         'LOW' | 'MEDIUM' | 'HIGH';
  description:        string;
  materials:          string[];
  successIndicators:  string[];
  nannyNotes:         string;
  skipIf:             string;
  ifTooEasy:          string;
  ifTooHard:          string;
}

// ─── Internal Claude response shapes (before goalIndex is resolved) ───────────

interface RawAiTask extends Omit<AiTask, 'goalId'> {
  goalIndex: number;   // Claude returns index, we resolve to real ID here
}

interface RawPlanResponse {
  dailyPlan: AiDailyPlan;
}

interface RawTasksResponse {
  tasks: RawAiTask[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AiService {
  private client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in environment');
    }
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  // ── generatePlan ────────────────────────────────────────────────────────────
  // Called once when booking is confirmed.
  // Returns the master strategy that lives in DailyPlan for the whole booking.

  async generatePlan(input: GeneratePlanInput): Promise<AiDailyPlan> {
    log.info('Generating master plan for booking (child age: %d months)', input.childAgeMonths);

    const system = `
You are an expert early childhood development planner for a professional nanny care platform in India.
You create structured, age-appropriate care plans that a trained nanny (not a therapist) can execute.

Your output must be a single valid JSON object with no markdown, no backticks, no explanation.
Schema:
{
  "dailyPlan": {
    "overallStrategy": string,          // 2-3 sentences on the core approach
    "weeklyFocusAreas": [               // one entry per week of the booking
      { "week": number, "focus": string }
    ],
    "difficultyLevel": "LOW" | "MEDIUM" | "HIGH",
    "totalPlannedMinutes": number,      // total structured activity per day
    "restWindows": string[]             // e.g. ["12:30 PM - 1:30 PM"]
  }
}
    `.trim();

    const user = `
Parent's goal prompt:
"${input.parentGoalPrompt}"

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}
- Booking duration: ${input.bookingDays} days

Structured goals selected by parent:
${this.formatGoals(input.goals)}

Generate the master DailyPlan strategy now.
The weeklyFocusAreas array must have exactly ${Math.ceil(input.bookingDays / 7)} entries (one per week).
    `.trim();

    const raw = await this.callClaude(system, user, 1024);

    let parsed: RawPlanResponse;
    try {
      parsed = JSON.parse(raw) as RawPlanResponse;
    } catch {
      log.error('Claude returned invalid JSON for generatePlan:\n%s', raw);
      throw new AppError('AI plan generation failed — invalid response format', 500);
    }

    this.validatePlan(parsed.dailyPlan);
    return parsed.dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every morning by the cron job.
  // Returns today's tasks with real goalIds resolved.

  async generateDailyTasks(input: GenerateDailyTasksInput): Promise<AiTask[]> {
    log.info(
      'Generating daily tasks (week %d, child age: %d months)',
      input.currentWeek,
      input.childAgeMonths,
    );

    const system = `
You are an expert early childhood development planner for a professional nanny care platform in India.
You create daily activity schedules that a trained nanny can execute without specialist equipment.

Rules:
- Total structured activity: 120-180 minutes spread across the day.
- Vary categories — never schedule two consecutive tasks of the same category.
- Tasks must be ordered chronologically by scheduledTime.
- Each task must map to exactly one goal via goalIndex (0-based index into the goals array).
- materials, successIndicators, skipIf, ifTooEasy, ifTooHard must be specific and actionable.
- Difficulty must match the child's current week of the booking (week ${input.currentWeek}).

Your output must be a single valid JSON object with no markdown, no backticks, no explanation.
Schema:
{
  "tasks": [
    {
      "goalIndex": number,
      "title": string,
      "category": "COGNITIVE" | "PHYSICAL" | "SOCIAL" | "EMOTIONAL" | "CREATIVE" | "ROUTINE",
      "durationMinutes": number,
      "scheduledTime": string,        // "HH:MM AM/PM" e.g. "09:00 AM"
      "difficulty": "LOW" | "MEDIUM" | "HIGH",
      "description": string,
      "materials": string[],
      "successIndicators": string[],
      "nannyNotes": string,
      "skipIf": string,
      "ifTooEasy": string,
      "ifTooHard": string
    }
  ]
}
    `.trim();

    const weekFocus = input.weeklyFocusAreas.find((w) => w.week === input.currentWeek);

    const user = `
Parent's goal prompt:
"${input.parentGoalPrompt}"

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}

Overall strategy:
"${input.overallStrategy}"

This week's focus (Week ${input.currentWeek}):
"${weekFocus?.focus ?? 'Continue with previous week goals'}"

Previous day summary:
"${input.previousTaskSummary || 'First day of booking — no previous data.'}"

Goals (use goalIndex to reference in tasks):
${this.formatGoals(input.goals)}

Generate today's full task schedule now.
    `.trim();

    const raw = await this.callClaude(system, user, 2048);

    let parsed: RawTasksResponse;
    try {
      parsed = JSON.parse(raw) as RawTasksResponse;
    } catch {
      log.error('Claude returned invalid JSON for generateDailyTasks:\n%s', raw);
      throw new AppError('AI task generation failed — invalid response format', 500);
    }

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new AppError('AI returned no tasks', 500);
    }

    // Resolve goalIndex → real goalId
    return parsed.tasks.map((t) => {
      const goal = input.goals[t.goalIndex];
      if (!goal) {
        log.warn('Task "%s" has invalid goalIndex %d — goal link will be null', t.title, t.goalIndex);
      }
      return {
        goalId:            goal?.id ?? '',
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

  private async callClaude(system: string, user: string, maxTokens: number): Promise<string> {
    const response = await this.client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = response.content
      .filter((b:any) => b.type === 'text')
      .map((b:any) => (b as { type: 'text'; text: string }).text)
      .join('');

    if (!text) {
      throw new AppError('Claude returned an empty response', 500);
    }

    return text.trim();
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
    if (!plan.overallStrategy)     throw new AppError('AI plan missing overallStrategy', 500);
    if (!plan.weeklyFocusAreas?.length) throw new AppError('AI plan missing weeklyFocusAreas', 500);
    if (!plan.difficultyLevel)     throw new AppError('AI plan missing difficultyLevel', 500);
    if (!plan.totalPlannedMinutes) throw new AppError('AI plan missing totalPlannedMinutes', 500);
  }
}
