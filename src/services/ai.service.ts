/**
 * ai.service.ts
 *
 * Single place for all Claude API interactions.
 * Two calls are made:
 *   1. parseGoalsAndStrategy()  — called once on booking CONFIRMED
 *      Reads parentGoalPrompt + template goals → returns ChildGoal records
 *      + the DailyPlan master strategy.
 *
 *   2. generateDailyTasks()     — called every morning by the cron job
 *      Reads DailyPlan strategy + recent TaskLogs → returns today's PlanTask[].
 */

import { createLogger } from '../utils/logger';
import { config }       from '../config';
import type { GoalTemplate, PremiumGoal, DailyPlanSlot } from '../utils/goalTemplates';

const log = createLogger('ai');

// ── Types returned by this service ───────────────────────────────────────────

export interface ParsedGoal {
  goalId:           string;   // from goal.json
  name:             string;
  category:         string;
  priority:         string;
  timelineMonths:   number;
  parentDescription: string;
  milestones:       { month: number; milestone: string }[];
}

export interface MasterPlan {
  overallStrategy:     string;
  weeklyFocusAreas:    { week: number; focus: string; activities: string[] }[];
  difficultyLevel:     'LOW' | 'MEDIUM' | 'HIGH';
  totalPlannedMinutes: number;
  restWindows:         string[];
}

export interface GeneratedTask {
  title:             string;
  category:          string;
  durationMinutes:   number;
  scheduledTime:     string;   // "HH:MM"
  difficulty:        'LOW' | 'MEDIUM' | 'HIGH';
  description:       string;
  materials:         string[];
  successIndicators: string[];
  nannyNotes:        string;
  skipIf:            string;
  ifTooEasy:         string;
  ifTooHard:         string;
  goalId?:           string;   // which goal this task serves (optional)
}

// ── Internal helper: call Claude ─────────────────────────────────────────────

async function callClaude(
  systemPrompt: string,
  userMessage:  string,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-opus-4-5',
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json() as any;
  return data.content?.[0]?.text ?? '';
}

// ── Helper: safely parse JSON from Claude response ────────────────────────────

function extractJson<T>(raw: string): T {
  // Claude sometimes wraps JSON in ```json ... ``` fences — strip them
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}

// ── 1. Parse goals + build master strategy ────────────────────────────────────

interface ParseGoalsInput {
  childName:          string;
  ageMonths:          number;
  gender:             string;
  disabilities:       string[];
  parentGoalPrompt:   string;          // raw free text from parent
  selectedGoals:      PremiumGoal[];   // goals parent picked from template
  dailyPlanSlots:     DailyPlanSlot[]; // requestedDailyPlan.additionalNotes
  bookingDurationDays: number;
}

export interface ParseGoalsResult {
  parsedGoals: ParsedGoal[];
  masterPlan:  MasterPlan;
  rawResponse: any;
}

export async function parseGoalsAndStrategy(
  input: ParseGoalsInput,
): Promise<ParseGoalsResult> {
  const systemPrompt = `
You are an expert child development AI assistant.
Your job is to:
1. Analyse the parent's free-text goals and the pre-selected development goals.
2. Return structured ChildGoal records with milestones.
3. Build a master DailyPlan strategy that a nanny can execute daily.

You MUST respond ONLY with valid JSON. No preamble, no explanation, no markdown.
The JSON must exactly match this structure:
{
  "parsedGoals": [
    {
      "goalId": "string — from the selectedGoals list",
      "name": "string",
      "category": "COGNITIVE | PHYSICAL | SOCIAL | EMOTIONAL | CREATIVE",
      "priority": "HIGH | MEDIUM | LOW",
      "timelineMonths": number,
      "parentDescription": "string — what the parent said about this goal",
      "milestones": [{ "month": number, "milestone": "string" }]
    }
  ],
  "masterPlan": {
    "overallStrategy": "string — plain English, 2-3 sentences",
    "weeklyFocusAreas": [
      { "week": number, "focus": "string", "activities": ["string"] }
    ],
    "difficultyLevel": "LOW | MEDIUM | HIGH",
    "totalPlannedMinutes": number,
    "restWindows": ["HH:MM-HH:MM"]
  }
}
`.trim();

  const userMessage = `
CHILD PROFILE:
- Name: ${input.childName}
- Age: ${input.ageMonths} months
- Gender: ${input.gender}
- Disabilities: ${input.disabilities.length ? input.disabilities.join(', ') : 'None'}
- Booking duration: ${input.bookingDurationDays} days

PARENT'S GOAL DESCRIPTION (free text):
"${input.parentGoalPrompt}"

SELECTED PREMIUM GOALS:
${input.selectedGoals.map((g) => `- [${g.goalId}] ${g.name} (${g.category}): ${g.parentDescription}`).join('\n')}

DAILY ROUTINE SLOTS (from requested daily plan template):
${input.dailyPlanSlots.map((s) => `${s.time}:\n${s.tasks.map((t) => `  • ${t}`).join('\n')}`).join('\n\n')}

Generate the parsedGoals and masterPlan JSON now.
`.trim();

  log.info('Calling Claude: parseGoalsAndStrategy');
  const raw = await callClaude(systemPrompt, userMessage);

  let parsed: { parsedGoals: ParsedGoal[]; masterPlan: MasterPlan };
  try {
    parsed = extractJson(raw);
  } catch (e) {
    log.error('Failed to parse Claude response for goals', { raw });
    throw new Error('AI returned invalid JSON for goal parsing');
  }

  return {
    parsedGoals: parsed.parsedGoals,
    masterPlan:  parsed.masterPlan,
    rawResponse: parsed,
  };
}

// ── 2. Generate today's tasks ─────────────────────────────────────────────────

interface TaskLogSummary {
  taskTitle:       string;
  completionPct:   number;
  engagementRating?: number;
  moodRating?:      number;
  nannyNote?:       string;
}

interface GenerateDailyTasksInput {
  childName:         string;
  ageMonths:         number;
  overallStrategy:   string;
  weeklyFocusAreas:  any[];
  goals:             { goalId: string; name: string; category: string }[];
  dailyPlanSlots:    DailyPlanSlot[];
  recentTaskLogs:    TaskLogSummary[];   // last 7 days of logs
  today:             string;            // "YYYY-MM-DD"
  dayNumber:         number;            // which day of the subscription (1, 2, 3…)
}

export async function generateDailyTasks(
  input: GenerateDailyTasksInput,
): Promise<{ tasks: GeneratedTask[]; rawResponse: any }> {
  const systemPrompt = `
You are an expert child development AI assistant.
Generate today's activity tasks for a nanny to execute with a child.

Rules:
- Tasks must fit within the daily routine slots provided.
- Adapt difficulty based on recent task logs (lower if engagement < 3, raise if > 4).
- Each task must serve one of the child's active goals where possible.
- Avoid repeating the same task from the last 3 days.
- Output ONLY valid JSON. No preamble, no markdown.

JSON structure:
{
  "tasks": [
    {
      "title": "string",
      "category": "COGNITIVE | PHYSICAL | SOCIAL | EMOTIONAL | CREATIVE | ROUTINE",
      "durationMinutes": number,
      "scheduledTime": "HH:MM",
      "difficulty": "LOW | MEDIUM | HIGH",
      "description": "string — step-by-step what the nanny should do",
      "materials": ["string"],
      "successIndicators": ["string"],
      "nannyNotes": "string",
      "skipIf": "string",
      "ifTooEasy": "string",
      "ifTooHard": "string",
      "goalId": "string or null"
    }
  ]
}
`.trim();

  const logsText = input.recentTaskLogs.length
    ? input.recentTaskLogs
        .map(
          (l) =>
            `- "${l.taskTitle}": ${l.completionPct}% done, engagement=${l.engagementRating ?? '?'}/5, mood=${l.moodRating ?? '?'}/5. Note: ${l.nannyNote ?? 'none'}`,
        )
        .join('\n')
    : 'No recent logs yet — this is the first day.';

  const userMessage = `
CHILD: ${input.childName}, ${input.ageMonths} months old
TODAY: ${input.today} (Day ${input.dayNumber} of subscription)

OVERALL STRATEGY:
${input.overallStrategy}

WEEKLY FOCUS AREAS:
${JSON.stringify(input.weeklyFocusAreas, null, 2)}

ACTIVE GOALS:
${input.goals.map((g) => `- [${g.goalId}] ${g.name} (${g.category})`).join('\n')}

DAILY ROUTINE SLOTS:
${input.dailyPlanSlots.map((s) => `${s.time}:\n${s.tasks.map((t) => `  • ${t}`).join('\n')}`).join('\n\n')}

RECENT TASK PERFORMANCE (last 7 days):
${logsText}

Generate today's tasks now.
`.trim();

  log.info(`Calling Claude: generateDailyTasks for day ${input.dayNumber}`);
  const raw = await callClaude(systemPrompt, userMessage);

  let parsed: { tasks: GeneratedTask[] };
  try {
    parsed = extractJson(raw);
  } catch (e) {
    log.error('Failed to parse Claude response for daily tasks', { raw });
    throw new Error('AI returned invalid JSON for daily task generation');
  }

  return { tasks: parsed.tasks, rawResponse: parsed };
}
