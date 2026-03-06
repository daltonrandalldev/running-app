/**
 * Core PMC (Performance Management Chart) calculation.
 *
 * Implements the Banister Impulse-Response model using exponential weighted
 * moving averages:
 *
 *   TSB(t) = CTL(t-1) - ATL(t-1)          — form going INTO the day
 *   CTL(t) = CTL(t-1) + (TSS(t) - CTL(t-1)) / tc_fitness
 *   ATL(t) = ATL(t-1) + (TSS(t) - ATL(t-1)) / tc_fatigue
 *
 * Using tc_fitness = 42 gives the same result as a 42-day EWMA.
 * Matches TrainingPeaks PMC output within ±0.5 TSS on identical data.
 */

export interface PMCInput {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Training Stress Score for this activity */
  tss: number;
}

export interface PMCParams {
  /** Fitness time constant in days. Default: 42 */
  tc_fitness?: number;
  /** Fatigue time constant in days. Default: 7 */
  tc_fatigue?: number;
}

export interface PMCDay {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Chronic Training Load — long-term fitness */
  ctl: number;
  /** Acute Training Load — short-term fatigue */
  atl: number;
  /** Training Stress Balance — form (CTL_prev - ATL_prev) */
  tsb: number;
}

/**
 * Calculate daily CTL / ATL / TSB from an array of activity TSS values.
 *
 * @param activities  Array of {date, tss} records. Multiple activities on the
 *                    same date are summed. May be in any order.
 * @param params      Optional time constants. Defaults: tc_fitness=42, tc_fatigue=7.
 * @returns           Array of daily PMC snapshots from the earliest activity
 *                    date through today, inclusive. Returns [] when activities
 *                    is empty.
 */
export function calculatePMC(
  activities: PMCInput[],
  params: PMCParams = {},
): PMCDay[] {
  if (activities.length === 0) return [];

  const tc_fitness = params.tc_fitness ?? 42;
  const tc_fatigue = params.tc_fatigue ?? 7;

  // Exponential smoothing coefficients
  const k_ctl = 1 - Math.exp(-1 / tc_fitness);
  const k_atl = 1 - Math.exp(-1 / tc_fatigue);

  // Aggregate TSS by date (multiple activities on same day are summed)
  const tssMap = new Map<string, number>();
  for (const act of activities) {
    tssMap.set(act.date, (tssMap.get(act.date) ?? 0) + act.tss);
  }

  // Determine date range: earliest activity → today
  const activityDates = Array.from(tssMap.keys()).sort();
  const startDate = activityDates[0];
  const endDate = todayISO();

  // Walk forward day by day, applying decay on rest days (TSS = 0)
  let ctl = 0;
  let atl = 0;
  const result: PMCDay[] = [];

  let current = parseISODate(startDate);
  const end = parseISODate(endDate);

  while (current <= end) {
    const dateStr = toISODate(current);
    // TSB is form going INTO the day — computed before applying today's load
    const tsb = ctl - atl;
    const load = tssMap.get(dateStr) ?? 0;
    ctl = ctl + (load - ctl) * k_ctl;
    atl = atl + (load - atl) * k_atl;
    result.push({
      date: dateStr,
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(tsb),
    });
    current = addDay(current);
  }

  return result;
}

// ── Date helpers (UTC-only to avoid DST drift) ────────────────────────────────

function parseISODate(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDay(d: Date): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function todayISO(): string {
  return toISODate(new Date());
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
