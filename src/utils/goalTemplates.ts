/**
 * goalTemplates.ts
 *
 * Loads goal.json (the master template file) and exposes helpers
 * to query it by child age and booking type.
 *
 * goal.json lives at: src/data/goal.json
 * It is read once at startup and cached in memory.
 */

import * as fs   from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GoalMilestone {
  month:     number;
  milestone: string;
}

export interface PremiumGoal {
  goalId:               string;
  name:                 string;
  category:             string;
  priority:             string;
  pricePerMonthRupees:  number;
  parentDescription:    string;
  milestones:           GoalMilestone[];
}

export interface DailyPlanSlot {
  time:  string;    // e.g. "Morning (High Energy & Mental)"
  tasks: string[];
}

export interface GoalTemplate {
  templateId:   string;
  filtering: {
    minAgeMonths:          number;
    maxAgeMonths:          number;
    supportedBookingTypes: string[];
  };
  uiDisplay: {
    title:            string;
    shortDescription: string;
  };
  premiumGoals:       PremiumGoal[];
  requestedDailyPlan: {
    additionalNotes: DailyPlanSlot[];
  };
}

// ── Load once ─────────────────────────────────────────────────────────────────

let _templates: GoalTemplate[] | null = null;

function loadTemplates(): GoalTemplate[] {
  if (_templates) return _templates;

  // Resolves to src/data/goal.json regardless of CWD
  const filePath = path.resolve(__dirname, '../../data/goal.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`goal.json not found at ${filePath}`);
  }

  _templates = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GoalTemplate[];
  return _templates;
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Returns the single template that matches the child's age in months.
 * Returns null if no template covers this age.
 */
export function getTemplateByAge(ageMonths: number): GoalTemplate | null {
  const templates = loadTemplates();
  return (
    templates.find(
      (t) =>
        ageMonths >= t.filtering.minAgeMonths &&
        ageMonths <  t.filtering.maxAgeMonths,
    ) ?? null
  );
}

/**
 * Returns all templates (used by GET /api/v1/goals to power the frontend carousel).
 */
export function getAllTemplates(): GoalTemplate[] {
  return loadTemplates();
}

/**
 * Returns the PremiumGoal objects for a given list of goalIds within a template.
 * Throws if any goalId is not found in the template.
 */
export function resolveGoals(
  template: GoalTemplate,
  goalIds: string[],
): PremiumGoal[] {
  const resolved: PremiumGoal[] = [];

  for (const id of goalIds) {
    const found = template.premiumGoals.find((g) => g.goalId === id);
    if (!found) {
      throw new Error(
        `Goal "${id}" not found in template "${template.templateId}"`,
      );
    }
    resolved.push(found);
  }

  return resolved;
}

/**
 * Computes the child's age in whole months from their birth date.
 */
export function ageInMonths(birthDate: Date): number {
  const now   = new Date();
  const years = now.getFullYear() - birthDate.getFullYear();
  const months = now.getMonth()  - birthDate.getMonth();
  return years * 12 + months;
}

/**
 * Checks whether a booking duration qualifies for AI planning.
 * AI only kicks in for subscriptions >= 30 days.
 */
export function isSubscriptionBooking(start: Date, end: Date): boolean {
  const diffMs   = end.getTime() - start.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 30;
}
