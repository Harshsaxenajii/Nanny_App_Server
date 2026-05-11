import { AppError } from "./AppError";
import { createLogger } from "./logger";

const log = createLogger("pricing");

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE TYPE CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Range bookings span multiple calendar days and are billed at a daily rate.
 * The parent picks a date range + which weekdays the nanny works.
 */
export const RANGE_SERVICE_TYPES = new Set([
  "FULL_TIME",
  "PART_TIME",
  "MONTHLY_SUBSCRIPTION",
  "NEWBORN_CARE",
  "MOTHERS_HELPER",
  "SPECIAL_NEEDS",
]);

/**
 * Emergency bookings add a flat per-hour surcharge on top of the hourly rate.
 */
const EMERGENCY_SERVICE_TYPES = new Set(["EMERGENCY"]);

// Everything not in either set (ONE_TIME, OVERNIGHT, HOURLY, EVENT,
// TRAVEL_NANNY, …) → billed as hourlyRate × sessionHours.

// ─────────────────────────────────────────────────────────────────────────────
// FEE CONSTANTS  — keep in sync with the frontend
// ─────────────────────────────────────────────────────────────────────────────

export const EMERGENCY_SURCHARGE_PER_HR   = 100;   // ₹ flat surcharge per hour
export const LUNCH_FEE_PER_DAY            = 100;   // ₹ per working day, FULL_TIME only
export const PLATFORM_FEE_PCT             = 0.05;  // 5% marketplace convenience fee
export const GST_PCT                      = 0.05;  // 5% GST on (discountedBase + platformFee)
export const DAILY_RATE_HOURS             = 9;     // standard full-day shift hours
export const DEFAULT_MONTHLY_WORKING_DAYS = 20;    // fallback when workingDays omitted
export const MAX_SESSION_HOURS            = 36;    // guard for single-session bookings
export const LATE_THRESHOLD_MINUTES       = 15;    // minutes after shift start → LATE
export const HALF_DAY_THRESHOLD_PCT       = 0.5;   // worked < 50% of shift → HALF_DAY

// ─────────────────────────────────────────────────────────────────────────────
// COUPON CATALOGUE
// ─────────────────────────────────────────────────────────────────────────────

const COUPON_CATALOGUE: Record<string, { discountPct: number; label: string }> = {
  FIRSTCARE: { discountPct: 0.2, label: "20% off your first booking" },
  MOM20:     { discountPct: 0.2, label: "20% off for MOM members" },
  NANNY10:   { discountPct: 0.1, label: "10% off any booking" },
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingInput {
  serviceType: string;
  hourlyRate: number;
  dailyRate?: number | null;
  /**
   * Always pass full ISO datetime strings from the frontend — both start and end.
   * For range bookings  → daily shift window on each working day (e.g. 09:00–18:00).
   * For single-session  → full session window (e.g. 14:00–20:00 same day, or
   *                       22:00 one day → 06:00 next day for OVERNIGHT).
   * sessionHours = (shiftEnd − shiftStart) in milliseconds; must be > 0.
   */
  shiftStart: Date;
  shiftEnd: Date;
  /** Actual number of working days in the booking range. Required for range types. */
  workingDays?: number;
  couponCode?: string;
  /** Monthly add-on fee for selected child development goals (not subject to GST). */
  goalsFee?: number;
  /**
   * If true and serviceType === "FULL_TIME", adds ₹100 per working day as a
   * lunch allowance. Ignored for all other service types.
   */
  lunch?: boolean;
}

export interface PricingResult {
  sessionHours: number;
  workingDays: number;
  baseFee: number;
  emergencySurcharge: number;
  couponCode: string | null;
  couponLabel: string | null;
  discount: number;
  discountedBase: number;
  platformFee: number;
  gst: number;
  goalsFee: number;
  lunchFee: number;
  total: number;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session length in hours.
 * Always receives two full ISO datetimes, so the diff is always positive.
 */
export function calcSessionHours(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 3_600_000;
}

export function isRangeType(serviceType: string): boolean {
  return RANGE_SERVICE_TYPES.has(serviceType);
}

export function validateCoupon(code: string): { valid: boolean; label?: string } {
  const entry = COUPON_CATALOGUE[code.toUpperCase().trim()];
  return entry ? { valid: true, label: entry.label } : { valid: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS  (shared by booking creation & attendance seeding)
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

/**
 * Returns all UTC-midnight Date objects within [startDate, endDate] that fall
 * on one of the specified weekday names (e.g. ["MON","WED","FRI"]).
 * If workingDayNames is empty, every calendar date in the range is returned.
 */
export function getWorkingDates(
  startDate: Date,
  endDate: Date,
  workingDayNames: string[],
): Date[] {
  const activeDays = new Set(
    workingDayNames.map((d) => WEEKDAY_MAP[d.toUpperCase().trim()] ?? -1),
  );

  // Iterate at noon UTC to avoid DST off-by-one errors
  const cur  = new Date(`${startDate.toISOString().split("T")[0]}T12:00:00.000Z`);
  const ceil = new Date(`${endDate.toISOString().split("T")[0]}T23:59:59.999Z`);
  const dates: Date[] = [];

  while (cur <= ceil) {
    if (activeDays.size === 0 || activeDays.has(cur.getUTCDay())) {
      const d = new Date(cur);
      d.setUTCHours(0, 0, 0, 0);
      dates.push(d);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE PRICING ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Charge order (standard for Indian gig / marketplace platforms):
//
//   1. Base fee        — depends on service type (see table below)
//   2. Coupon discount — % off baseFee
//   3. Platform fee    — 5% of discountedBase  (marketplace convenience fee)
//   4. GST             — 5% of (discountedBase + platformFee)
//   5. Goals add-on    — flat monthly fee, NOT subject to GST or platform fee
//   6. Lunch fee       — ₹100/working day, FULL_TIME only, NOT subject to GST
//   ─────────────────────────────────────────────────────────────────────────
//   Total = discountedBase + platformFee + gst + goalsFee + lunchFee
//
// Service type → billing logic:
//
//   EMERGENCY            → (hourlyRate + ₹100/hr surcharge) × sessionHours
//   FULL_TIME            → dailyRate × workingDays  [+OT if shift > 9 hrs]
//                          [+₹100/day lunch allowance if lunch=true]
//   PART_TIME            → dailyRate × workingDays  [+OT if shift > 9 hrs]
//   MONTHLY_SUBSCRIPTION → dailyRate × workingDays  [+OT if shift > 9 hrs]
//   NEWBORN_CARE         → dailyRate × workingDays  [+OT if shift > 9 hrs]
//   MOTHERS_HELPER       → dailyRate × workingDays  [+OT if shift > 9 hrs]
//   SPECIAL_NEEDS        → dailyRate × workingDays  [+OT if shift > 9 hrs]
//   ONE_TIME / OVERNIGHT → hourlyRate × sessionHours
//   HOURLY / EVENT / …   → hourlyRate × sessionHours  (default)
//
// ─────────────────────────────────────────────────────────────────────────────

export function calcPricing(input: PricingInput): PricingResult {
  const {
    serviceType,
    hourlyRate,
    dailyRate,
    shiftStart,
    shiftEnd,
    workingDays: inputDays,
    couponCode,
    goalsFee = 0,
    lunch = false,
  } = input;

  if (isNaN(shiftStart.getTime()) || isNaN(shiftEnd.getTime()))
    throw new AppError("Invalid shiftStart or shiftEnd passed to pricing engine", 500);

  const hours   = calcSessionHours(shiftStart, shiftEnd);
  const isRange = isRangeType(serviceType);
  const days    = isRange ? (inputDays ?? DEFAULT_MONTHLY_WORKING_DAYS) : 1;

  let baseFee            = 0;
  let emergencySurcharge = 0;
  let description        = "";

  if (EMERGENCY_SERVICE_TYPES.has(serviceType)) {
    emergencySurcharge = hours * EMERGENCY_SURCHARGE_PER_HR;
    baseFee            = hours * hourlyRate + emergencySurcharge;
    description =
      `${hours.toFixed(1)} hrs × ₹${hourlyRate}/hr` +
      ` + ₹${EMERGENCY_SURCHARGE_PER_HR}/hr emergency surcharge`;

  } else if (isRange) {
    // If no daily rate is configured, derive it from 9 hrs at the hourly rate
    const effectiveDailyRate =
      dailyRate && dailyRate > 0 ? dailyRate : hourlyRate * DAILY_RATE_HOURS;

    if (hours <= DAILY_RATE_HOURS) {
      baseFee     = effectiveDailyRate * days;
      description = `₹${effectiveDailyRate}/day × ${days} days`;
    } else {
      const overtimeHrs = hours - DAILY_RATE_HOURS;
      const dailyCost   = effectiveDailyRate + overtimeHrs * hourlyRate;
      baseFee     = dailyCost * days;
      description =
        `(₹${effectiveDailyRate}/day + ${overtimeHrs.toFixed(1)} OT hrs × ₹${hourlyRate}/hr)` +
        ` × ${days} days`;
    }

  } else {
    baseFee     = hours * hourlyRate;
    description = `${hours.toFixed(1)} hrs × ₹${hourlyRate}/hr`;
  }

  // Coupon discount
  let discount    = 0;
  let appliedCode: string | null = null;
  let couponLabel: string | null = null;

  if (couponCode) {
    const key   = couponCode.toUpperCase().trim();
    const entry = COUPON_CATALOGUE[key];
    if (entry) {
      discount    = Math.round(baseFee * entry.discountPct);
      appliedCode = key;
      couponLabel = entry.label;
    }
  }

  const discountedBase = baseFee - discount;
  const platformFee    = Math.round(discountedBase * PLATFORM_FEE_PCT);
  // GST on service value + marketplace convenience fee (standard Indian practice)
  const gst            = Math.round((discountedBase + platformFee) * GST_PCT);
  // Lunch allowance: ₹100/working day, only for FULL_TIME bookings
  const lunchFee       = lunch && serviceType === "FULL_TIME" ? LUNCH_FEE_PER_DAY * days : 0;
  const total          = discountedBase + platformFee + gst + goalsFee + lunchFee;

  log.info(
    `[calcPricing] ${serviceType} | hours=${hours.toFixed(2)} days=${days}` +
    ` | base=₹${baseFee} discount=₹${discount} platform=₹${platformFee}` +
    ` gst=₹${gst} goals=₹${goalsFee} lunch=₹${lunchFee} total=₹${total}`,
  );

  return {
    sessionHours: hours,
    workingDays: days,
    baseFee,
    emergencySurcharge,
    couponCode: appliedCode,
    couponLabel,
    discount,
    discountedBase,
    platformFee,
    gst,
    goalsFee,
    lunchFee,
    total,
    description,
  };
}
