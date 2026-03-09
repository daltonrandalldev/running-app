/**
 * Training Monotony and Strain calculation library.
 *
 * Implements Foster (1998) definitions:
 *   Monotony = mean daily load / population stdev (7-day rolling window)
 *   Strain   = weekly load sum × monotony
 *
 * Three sport series are supported:
 *   'run'      — activities matching sport ILIKE '%run%', weight 1.0
 *   'cycle'    — activities matching sport ILIKE '%cycl%', weight 1.0
 *   'combined' — all activities; run → 1.0, cycle → 0.5, other → 1.0
 *
 * Pure TypeScript module — zero runtime imports, no Supabase dependency.
 */

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

// ── Exports ───────────────────────────────────────────────────────────────────

export const SPORT_WEIGHTS = {
  run: 1.0,
  cycle: 0.5,
} as const;

export interface MonotonyStrainDay {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Population mean / stdev over the 7-day window ending on this date.
   *  NULL when stdev = 0 (degenerate case) or when fewer than 7 days of
   *  history are available (days 1–6). */
  monotony: number | null;
  /** Weekly load sum * monotony. When monotony is NULL due to stdev=0,
   *  equals the weekly load sum only (no multiplier).
   *  NULL on days 1–6 (partial window). */
  strain: number | null;
}

/**
 * Calculate training monotony from exactly 7 daily load values.
 *
 * Uses population standard deviation (divide by N=7, not N-1).
 * Returns null when stdev is below floating-point epsilon (degenerate case
 * where all values are identical, e.g. all zeros or all the same load).
 * Throws if input length is not exactly 7.
 */
export function calculateMonotony(dailyLoads: number[]): number | null {
  if (dailyLoads.length !== 7) {
    throw new Error(`calculateMonotony requires exactly 7 values, got ${dailyLoads.length}`);
  }
  const mean = dailyLoads.reduce((s, v) => s + v, 0) / 7;
  const variance = dailyLoads.reduce((s, v) => s + (v - mean) ** 2, 0) / 7;
  const stdev = Math.sqrt(variance);
  if (stdev < 1e-9) return null;
  return mean / stdev;
}

/**
 * Calculate training strain from exactly 7 daily load values.
 *
 * Strain = weekly sum × monotony.
 * When monotony is null (zero-stdev degenerate case), strain equals the
 * raw weekly sum with no multiplier applied.
 */
export function calculateStrain(dailyLoads: number[]): number {
  const weeklySum = dailyLoads.reduce((s, v) => s + v, 0);
  const monotony = calculateMonotony(dailyLoads);
  if (monotony === null) return weeklySum;
  return weeklySum * monotony;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function sportWeight(sport: string): number {
  const s = sport.toLowerCase();
  if (s.includes('run')) return SPORT_WEIGHTS.run;   // 1.0
  if (s.includes('cycl')) return SPORT_WEIGHTS.cycle; // 0.5
  return 1.0; // all other sports (neither run nor cycle)
}

// ── Main rolling calculation ──────────────────────────────────────────────────

/**
 * Calculate daily monotony and strain for a rolling 7-day window.
 *
 * @param activities  Array of activity records with date, TSS, and sport.
 *                    Multiple activities on the same date are summed.
 *                    May be in any order.
 * @param sport       'run', 'cycle', or 'combined'. Determines filtering and
 *                    weighting of activities.
 * @returns           Array of daily monotony/strain snapshots from the earliest
 *                    activity date through today, inclusive. Returns [] when
 *                    activities is empty. Days 1–6 have monotony: null,
 *                    strain: null (partial window).
 */
export function calculateMonotonyStrain(
  activities: { date: string; tss: number; sport: string }[],
  sport: 'run' | 'cycle' | 'combined',
): MonotonyStrainDay[] {
  if (activities.length === 0) return [];

  // Filter and weight by sport
  const weighted = activities.flatMap((row) => {
    if (sport === 'run') {
      if (!row.sport.toLowerCase().includes('run')) return [];
      return [{ date: row.date, load: row.tss * 1.0 }];
    }
    if (sport === 'cycle') {
      if (!row.sport.toLowerCase().includes('cycl')) return [];
      return [{ date: row.date, load: row.tss * 1.0 }];
    }
    // combined: all activities with sport-specific weights
    return [{ date: row.date, load: row.tss * sportWeight(row.sport) }];
  });

  // Return early if no activities remain after filtering
  if (weighted.length === 0) return [];

  // Aggregate by date: sum weighted loads for activities on the same date
  const loadMap = new Map<string, number>();
  for (const entry of weighted) {
    loadMap.set(entry.date, (loadMap.get(entry.date) ?? 0) + entry.load);
  }

  // Determine date range: earliest activity → today
  const activityDates = Array.from(loadMap.keys()).sort();
  const startDate = activityDates[0];
  const endDate = todayISO();

  // Build contiguous daily load array (rest days contribute 0)
  const dateArray: string[] = [];
  const loadArray: number[] = [];

  let current = parseISODate(startDate);
  const end = parseISODate(endDate);

  while (current <= end) {
    const dateStr = toISODate(current);
    dateArray.push(dateStr);
    loadArray.push(loadMap.get(dateStr) ?? 0);
    current = addDay(current);
  }

  // Rolling 7-day window: emit one MonotonyStrainDay per index
  const result: MonotonyStrainDay[] = [];

  for (let i = 0; i < loadArray.length; i++) {
    const date = dateArray[i];

    if (i < 6) {
      // Partial window — fewer than 7 days of history available
      result.push({ date, monotony: null, strain: null });
    } else {
      const dailyLoads = loadArray.slice(i - 6, i + 1); // 7 values ending on index i
      const rawMonotony = calculateMonotony(dailyLoads);
      const rawStrain = calculateStrain(dailyLoads);

      // Round to prevent floating-point drift in stored values
      const monotony = rawMonotony !== null
        ? Math.round(rawMonotony * 10000) / 10000
        : null;
      const strain = Math.round(rawStrain * 100) / 100;

      result.push({ date, monotony, strain });
    }
  }

  return result;
}
