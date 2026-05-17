import { AppError } from "./AppError";
import { createLogger } from "./logger";

const log = createLogger("pricing");

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT PRICING CONFIG  (mirrors PricingConfig DB defaults)
// The booking service fetches the live config from DB and passes it in;
// these defaults are used when no config record exists yet.
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingConfigShape {
  hourlyRate: number;        // ₹/hr for HOURLY bookings
  travelFee: number;         // flat ₹ added to every HOURLY booking
  dailyRate: number;         // ₹ flat for DAILY (9-hr shift)
  weeklyRate: number;        // ₹ base for WEEKLY (5-day Mon-Fri)
  weeklyExtraDayRate: number; // ₹ per extra day added to weekly
  monthlyRate: number;       // ₹ flat for FULL_TIME (26 days/month)
  overnightRate: number;     // ₹ flat for OVERNIGHT (9pm-9am, 12 hrs)
  subscriptionRate: number;  // ₹/month for MONTHLY_SUBSCRIPTION
  subscriptionFee: number;   // one-time signup for MONTHLY_SUBSCRIPTION
  lunchFeePerDay: number;    // ₹/working day, FULL_TIME only
  platformFeePct: number;    // e.g. 0.05 = 5% platform convenience fee
  gstPct: number;            // e.g. 0.05 = 5% GST
  nannySharePct: number;     // e.g. 0.70 = nanny gets 70% of baseFee
  nannyGoalSharePct: number; // e.g. 0.40 = nanny gets 40% of goalsFee (membership only)
}

export const DEFAULT_PRICING_CONFIG: PricingConfigShape = {
  hourlyRate:        199,
  travelFee:         200,
  dailyRate:         1799,
  weeklyRate:        8999,
  weeklyExtraDayRate: 1799,
  monthlyRate:       44999,
  overnightRate:     2399,
  subscriptionRate:  49999,
  subscriptionFee:   5000,
  lunchFeePerDay:    100,
  platformFeePct:    0,
  gstPct:            0,
  nannySharePct:     0.70,
  nannyGoalSharePct: 0.40,
};

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE TYPE CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/** Types that span a date range (have working days). */
export const RANGE_SERVICE_TYPES = new Set([
  "FULL_TIME",
  "MONTHLY_SUBSCRIPTION",
  "WEEKLY",
  // Legacy types kept for historical bookings
  "PART_TIME",
  "NEWBORN_CARE",
  "MOTHERS_HELPER",
  "SPECIAL_NEEDS",
]);

export const WEEKLY_WORKING_DAYS_BASE = 5; // Mon-Fri

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingInput {
  serviceType: string;
  /** For HOURLY: hours × hourlyRate; for legacy range types: nanny's daily rate. */
  hourlyRate?: number;
  dailyRate?: number | null;
  shiftStart: Date;
  shiftEnd: Date;
  /** Number of working days in range (required for FULL_TIME, WEEKLY, MONTHLY_SUBSCRIPTION). */
  workingDays?: number;
  /** Number of working days selected for WEEKLY (determines extra-day surcharge). */
  weeklySelectedDays?: number;
  couponCode?: string;
  resolvedCoupon?: { discountPct: number; label: string };
  /** Monthly add-on fee for selected child development goals. */
  goalsFee?: number;
  /** FULL_TIME only: add ₹lunchFeePerDay per working day. */
  lunch?: boolean;
  /** Live pricing config fetched from DB. Falls back to DEFAULT_PRICING_CONFIG. */
  config?: PricingConfigShape;
}

export interface PricingResult {
  sessionHours: number;
  workingDays: number;
  baseFee: number;
  travelFee: number;
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
  nannyEarnings: number;  // amount the nanny receives (after platform's cut)
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY CONSTANTS (kept for backwards compat with old code paths)
// ─────────────────────────────────────────────────────────────────────────────

export const EMERGENCY_SURCHARGE_PER_HR   = 100;
export const LUNCH_FEE_PER_DAY            = 100;
export const PLATFORM_FEE_PCT             = 0;
export const GST_PCT                      = 0;
export const DAILY_RATE_HOURS             = 9;
export const DEFAULT_MONTHLY_WORKING_DAYS = 26;
export const MAX_SESSION_HOURS            = 36;
export const LATE_THRESHOLD_MINUTES       = 15;
export const HALF_DAY_THRESHOLD_PCT       = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// COUPON CATALOGUE (legacy — DB coupons take priority)
// ─────────────────────────────────────────────────────────────────────────────

const COUPON_CATALOGUE: Record<string, { discountPct: number; label: string }> = {
  FIRSTCARE: { discountPct: 0.2, label: "20% off your first booking" },
  MOM20:     { discountPct: 0.2, label: "20% off for MOM members" },
  NANNY10:   { discountPct: 0.1, label: "10% off any booking" },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

export function getWorkingDates(
  startDate: Date,
  endDate: Date,
  workingDayNames: string[],
): Date[] {
  const activeDays = new Set(
    workingDayNames.map((d) => WEEKDAY_MAP[d.toUpperCase().trim()] ?? -1),
  );

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
//
// Booking type → billing logic:
//
//   HOURLY              → hourlyRate × hours + travelFee (flat)
//   DAILY               → dailyRate  (flat, 9-hr shift)
//   WEEKLY              → weeklyRate (5-day base) + extraDays × weeklyExtraDayRate
//   FULL_TIME           → monthlyRate (flat, 26 working days)
//                         [+lunchFeePerDay × workingDays if lunch=true]
//   OVERNIGHT           → overnightRate (flat, 9pm-9am 12 hrs)
//   MONTHLY_SUBSCRIPTION→ subscriptionRate (flat) + subscriptionFee (first booking)
//   EMERGENCY (legacy)  → (hourlyRate + ₹100/hr surcharge) × hours
//   ONE_TIME (legacy)   → hourlyRate × hours
//   PART_TIME (legacy)  → dailyRate × workingDays
// ─────────────────────────────────────────────────────────────────────────────

export function calcPricing(input: PricingInput): PricingResult {
  const cfg: PricingConfigShape = { ...DEFAULT_PRICING_CONFIG, ...input.config };

  const {
    serviceType,
    shiftStart,
    shiftEnd,
    workingDays: inputDays,
    weeklySelectedDays,
    couponCode,
    resolvedCoupon,
    goalsFee = 0,
    lunch = false,
  } = input;

  // Legacy per-nanny rates (used for PART_TIME, ONE_TIME, EMERGENCY, OVERNIGHT legacy path)
  const legacyHourlyRate = input.hourlyRate ?? cfg.hourlyRate;
  const legacyDailyRate  = input.dailyRate && input.dailyRate > 0
    ? input.dailyRate
    : legacyHourlyRate * DAILY_RATE_HOURS;

  if (isNaN(shiftStart.getTime()) || isNaN(shiftEnd.getTime()))
    throw new AppError("Invalid shiftStart or shiftEnd", 500);

  const hours = calcSessionHours(shiftStart, shiftEnd);
  const days  = inputDays ?? 1;

  let baseFee            = 0;
  let travelFee          = 0;
  let emergencySurcharge = 0;
  let description        = "";

  switch (serviceType) {
    // ── New types ──────────────────────────────────────────────────────────

    case "HOURLY": {
      baseFee     = Math.round(hours * cfg.hourlyRate);
      travelFee   = cfg.travelFee;
      description = `${hours.toFixed(1)} hrs × ₹${cfg.hourlyRate}/hr`;
      break;
    }

    case "DAILY": {
      const DAILY_STD_HOURS = 9;
      const DAILY_MAX_HOURS = 12;
      const dailyOvertimeRate = Math.round(cfg.dailyRate / 8);
      if (hours <= DAILY_STD_HOURS) {
        baseFee     = cfg.dailyRate;
        description = `₹${cfg.dailyRate} flat (9-hr shift)`;
      } else {
        const cappedHours  = Math.min(hours, DAILY_MAX_HOURS);
        const overtimeHrs  = +(cappedHours - DAILY_STD_HOURS).toFixed(2);
        const overtimeCost = Math.round(overtimeHrs * dailyOvertimeRate);
        baseFee     = cfg.dailyRate + overtimeCost;
        description = `₹${cfg.dailyRate} (9-hr base) + ${overtimeHrs.toFixed(1)} OT hrs × ₹${dailyOvertimeRate}/hr`;
      }
      break;
    }

    case "WEEKLY": {
      // <5 days: prorated at weeklyExtraDayRate per day
      // =5 days: flat weeklyRate (best value)
      // >5 days: weeklyRate + extra days at weeklyExtraDayRate each
      const selectedDays = weeklySelectedDays ?? WEEKLY_WORKING_DAYS_BASE;
      if (selectedDays < WEEKLY_WORKING_DAYS_BASE) {
        baseFee     = selectedDays * cfg.weeklyExtraDayRate;
        description = `${selectedDays} days × ₹${cfg.weeklyExtraDayRate}/day`;
      } else if (selectedDays === WEEKLY_WORKING_DAYS_BASE) {
        baseFee     = cfg.weeklyRate;
        description = `₹${cfg.weeklyRate} (Mon-Fri, 5 days)`;
      } else {
        const extraDays = selectedDays - WEEKLY_WORKING_DAYS_BASE;
        baseFee     = cfg.weeklyRate + extraDays * cfg.weeklyExtraDayRate;
        description = `₹${cfg.weeklyRate} (5 days) + ${extraDays} extra × ₹${cfg.weeklyExtraDayRate}`;
      }
      break;
    }

    case "FULL_TIME": {
      baseFee     = cfg.monthlyRate;
      description = `₹${cfg.monthlyRate}/month (26 working days)`;
      break;
    }

    case "OVERNIGHT": {
      baseFee     = cfg.overnightRate;
      description = `₹${cfg.overnightRate} flat (9pm-9am, 12 hrs)`;
      break;
    }

    case "MONTHLY_SUBSCRIPTION": {
      baseFee     = cfg.subscriptionRate + cfg.subscriptionFee;
      description = `₹${cfg.subscriptionRate}/month + ₹${cfg.subscriptionFee} one-time signup`;
      break;
    }

    // ── Legacy types (kept for historical data) ────────────────────────────

    case "EMERGENCY": {
      emergencySurcharge = Math.round(hours * EMERGENCY_SURCHARGE_PER_HR);
      baseFee            = Math.round(hours * legacyHourlyRate) + emergencySurcharge;
      description        =
        `${hours.toFixed(1)} hrs × ₹${legacyHourlyRate}/hr` +
        ` + ₹${EMERGENCY_SURCHARGE_PER_HR}/hr emergency surcharge`;
      break;
    }

    case "ONE_TIME": {
      baseFee     = Math.round(hours * legacyHourlyRate);
      description = `${hours.toFixed(1)} hrs × ₹${legacyHourlyRate}/hr`;
      break;
    }

    case "PART_TIME":
    case "NEWBORN_CARE":
    case "MOTHERS_HELPER":
    case "SPECIAL_NEEDS": {
      if (hours <= DAILY_RATE_HOURS) {
        baseFee     = legacyDailyRate * days;
        description = `₹${legacyDailyRate}/day × ${days} days`;
      } else {
        const overtimeHrs = hours - DAILY_RATE_HOURS;
        const dailyCost   = legacyDailyRate + Math.round(overtimeHrs * legacyHourlyRate);
        baseFee     = dailyCost * days;
        description =
          `(₹${legacyDailyRate}/day + ${overtimeHrs.toFixed(1)} OT hrs × ₹${legacyHourlyRate}/hr)` +
          ` × ${days} days`;
      }
      break;
    }

    default: {
      baseFee     = Math.round(hours * legacyHourlyRate);
      description = `${hours.toFixed(1)} hrs × ₹${legacyHourlyRate}/hr`;
    }
  }

  // Coupon
  let discount    = 0;
  let appliedCode: string | null = null;
  let couponLabel: string | null = null;

  if (couponCode) {
    const key   = couponCode.toUpperCase().trim();
    const entry = resolvedCoupon ?? COUPON_CATALOGUE[key];
    if (entry) {
      discount    = Math.round(baseFee * entry.discountPct);
      appliedCode = key;
      couponLabel = entry.label;
    }
  }

  const discountedBase = baseFee - discount;
  const platformFee    = Math.round(discountedBase * cfg.platformFeePct);
  const gst            = Math.round((discountedBase + platformFee) * cfg.gstPct);

  // Lunch: FULL_TIME only, ₹lunchFeePerDay per working day
  const lunchFee =
    lunch && serviceType === "FULL_TIME"
      ? cfg.lunchFeePerDay * (days > 0 ? days : DEFAULT_MONTHLY_WORKING_DAYS)
      : 0;

  const total = discountedBase + travelFee + platformFee + gst + goalsFee + lunchFee;

  // Nanny payout: configurable share of baseFee.
  // For MONTHLY_SUBSCRIPTION: base share + full lunch + partial goals share.
  // For all others: base share + travel fee (pass-through reimbursement).
  // Nanny payout rules:
  //   MONTHLY_SUBSCRIPTION → 70% of subscriptionRate (not signup fee) + lunchFee + 40% of goalsFee
  //   All others           → 70% of baseFee + travelFee (pass-through) + lunchFee (pass-through for FULL_TIME)
  const nannyEarnings = serviceType === "MONTHLY_SUBSCRIPTION"
    ? Math.round(cfg.subscriptionRate * cfg.nannySharePct) + lunchFee + Math.round(goalsFee * cfg.nannyGoalSharePct)
    : Math.round(baseFee * cfg.nannySharePct) + travelFee + lunchFee;

  log.info(
    `[calcPricing] ${serviceType} | hours=${hours.toFixed(2)} days=${days}` +
    ` | base=₹${baseFee} travel=₹${travelFee} discount=₹${discount}` +
    ` platform=₹${platformFee} gst=₹${gst} goals=₹${goalsFee} lunch=₹${lunchFee} total=₹${total}`,
  );

  return {
    sessionHours: hours,
    workingDays: days,
    baseFee,
    travelFee,
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
    nannyEarnings,
    description,
  };
}
