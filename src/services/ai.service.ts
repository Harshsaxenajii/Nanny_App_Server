/**
 * ai.service.ts
 *
 * Single responsibility: talk to Gemini.
 * Takes structured input, returns structured output.
 * No DB access — that is plan.service.ts's job.
 *
 * Exposed methods:
 *   generatePlan(input)       — called once when booking is confirmed
 *                               returns DailyPlan strategy + weekly focus areas
 *   generateDailyTasks(input) — called every morning by the cron job
 *                               returns today's PlanTask[]
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger }       from '../utils/logger';
import { AppError }           from '../utils/AppError';

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
  childGender:      string;   // 'BOY' | 'GIRL' | 'OTHER'
  bookingDays:      number;   // e.g. 35
  goals:            GoalContext[];
}

export interface AiDailyPlan {
  overallStrategy:     string;
  weeklyFocusAreas:    { week: number; focus: string }[];
  difficultyLevel:     'LOW' | 'MEDIUM' | 'HIGH';
  totalPlannedMinutes: number;
  restWindows:         string[];  // e.g. ["12:30 PM - 1:30 PM"]
}

export interface GenerateDailyTasksInput {
  // parentGoalPrompt:    string;
  childAgeMonths:      number;
  childGender:         string;
  overallStrategy:     string;
  weeklyFocusAreas:    { week: number; focus: string }[];
  currentWeek:         number;  // which week of the booking we're in (1-based)
  goals:               GoalContext[];
  previousTaskSummary: string;  // brief summary of yesterday's completions
}

export interface AiTask {
  goalId:            string;   // real ChildGoal.id — resolved inside this service
  title:             string;
  category:          'COGNITIVE' | 'PHYSICAL' | 'SOCIAL' | 'EMOTIONAL' | 'CREATIVE' | 'ROUTINE';
  durationMinutes:   number;
  scheduledTime:     string;  // "HH:MM AM/PM"
  difficulty:        'LOW' | 'MEDIUM' | 'HIGH';
  description:       string;
  materials:         string[];
  successIndicators: string[];
  nannyNotes:        string;
  skipIf:            string;
  ifTooEasy:         string;
  ifTooHard:         string;
}

// ─── Internal Gemini response shapes (before goalIndex is resolved) ───────────

interface RawAiTask extends Omit<AiTask, 'goalId'> {
  goalIndex: number;  // Gemini returns 0-based index, we resolve to real ID here
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
  // Called once when booking is confirmed.
  // Returns the master strategy stored in DailyPlan for the whole booking.

  async generatePlan(input: GeneratePlanInput): Promise<AiDailyPlan> {
    log.info('Generating master plan (child age: %d months)', input.childAgeMonths);

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

Parent's goal prompt: "${input.parentGoalPrompt}"

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}
- Booking duration: ${input.bookingDays} days

Goals:
${this.formatGoals(input.goals)}

The weeklyFocusAreas array must have exactly ${Math.ceil(input.bookingDays / 7)} entries.
Return only valid JSON.
    `.trim();

    const raw = await this.callGemini(prompt);

    let parsed: RawPlanResponse;
    try {
      parsed = JSON.parse(raw) as RawPlanResponse;
    } catch {
      log.error('Gemini returned invalid JSON for generatePlan:\n%s', raw);
      throw new AppError('AI plan generation failed — invalid response format', 500);
    }

    this.validatePlan(parsed.dailyPlan);
    return parsed.dailyPlan;
  }

  // ── generateDailyTasks ──────────────────────────────────────────────────────
  // Called every morning by the cron job.
  // Returns today's tasks with real goalIds resolved from goalIndex.

  async generateDailyTasks(input: GenerateDailyTasksInput): Promise<AiTask[]> {
    log.info(
      'Generating daily tasks (week %d, child age: %d months)',
      input.currentWeek,
      input.childAgeMonths,
    );

    const weekFocus = input.weeklyFocusAreas.find((w) => w.week === input.currentWeek);

    const prompt = `
You are an expert early childhood development planner for a professional nanny care platform in India.
You create daily activity schedules that a trained nanny can execute without specialist equipment.

Rules:
- Total structured activity: 120-180 minutes across the day.
- Vary categories — never two consecutive tasks of the same category.
- Tasks ordered chronologically by scheduledTime.
- Each task maps to exactly one goal via goalIndex (0-based index into goals array).
- All string fields must be specific and actionable.

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

// Parent's goal prompt: " "

Child info:
- Age: ${input.childAgeMonths} months
- Gender: ${input.childGender}

Overall strategy: "${input.overallStrategy}"

Week ${input.currentWeek} focus: "${weekFocus?.focus ?? 'Continue with previous week goals'}"

Previous day: "${input.previousTaskSummary || 'First day — no previous data.'}"

Goals (0-based index):
${this.formatGoals(input.goals)}

Return only valid JSON.
    `.trim();

    const raw = await this.callGemini(prompt);

    let parsed: RawTasksResponse;
    try {
      parsed = JSON.parse(raw) as RawTasksResponse;
    } catch {
      log.error('Gemini returned invalid JSON for generateDailyTasks:\n%s', raw);
      throw new AppError('AI task generation failed — invalid response format', 500);
    }

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new AppError('AI returned no tasks', 500);
    }

    // Resolve goalIndex → real ChildGoal.id
    return parsed.tasks.map((t) => {
      const goal = input.goals[t.goalIndex];
      if (!goal) {
        log.warn('Task "%s" has invalid goalIndex %d', t.title, t.goalIndex);
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

  // Calls Gemini and returns cleaned plain text.
  // Strips markdown fences Gemini adds despite being told not to.
  private async callGemini(prompt: string): Promise<string> {
    const model  = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();

    if (!raw) throw new AppError('Gemini returned an empty response', 500);

    return raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i,     '')
      .replace(/```\s*$/i,     '')
      .trim();
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
    if (!plan.overallStrategy)          throw new AppError('AI plan missing overallStrategy', 500);
    if (!plan.weeklyFocusAreas?.length) throw new AppError('AI plan missing weeklyFocusAreas', 500);
    if (!plan.difficultyLevel)          throw new AppError('AI plan missing difficultyLevel', 500);
    if (!plan.totalPlannedMinutes)      throw new AppError('AI plan missing totalPlannedMinutes', 500);
  }
}

// test-claude.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reads prompt.txt → fires Claude API → logs raw JSON response

// Run:
//   ANTHROPIC_API_KEY=your_key npx ts-node test-claude.ts
// ─────────────────────────────────────────────────────────────────────────────

// import fs from "fs";
// import path from "path";
// import { GoogleGenerativeAI } from "@google/generative-ai";

// async function main() {
//   // 1. Read the prompt from the text file
//   const promptPath = path.join(__dirname, "../prompts/prompt.txt");
//   const prompt = fs.readFileSync(promptPath, "utf-8").trim();

//   console.log("─────────────────────────────────");
//   console.log("PROMPT:");
//   console.log(prompt);
//   console.log("─────────────────────────────────");

//   // 2. Fire Gemini API
//   const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
//   console.log(process.env.GEMINI_API_KEY)
//   const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

//   const result = await model.generateContent(prompt);
//   const rawText = result.response.text().trim();

//   console.log("RAW RESPONSE FROM GEMINI:");
//   console.log(rawText);
//   console.log("─────────────────────────────────");

//   // 3. Parse as JSON to verify it worked
//   // Gemini sometimes wraps response in ```json ... ``` — strip it
//   const cleaned = rawText
//     .replace(/^```json\s*/i, "")
//     .replace(/^```\s*/i, "")
//     .replace(/```\s*$/i, "")
//     .trim();

//   try {
//     const parsed = JSON.parse(cleaned);
//     console.log("PARSED JSON:");
//     console.log(JSON.stringify(parsed, null, 2));
//     console.log("─────────────────────────────────");
//     console.log("✅ Gemini integration working.");
//   } catch (err) {
//     console.error("❌ Response is not valid JSON:", err);
//     console.log("Raw text was:", rawText);
//   }
// }

// main().catch(console.error);