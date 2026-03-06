/**
 * PMC-003: Benchmark Effort pure utility functions.
 *
 * No external dependencies — safe to import in Node.js test environments.
 * DB interaction lives in benchmarkEfforts.ts which imports this module.
 *
 * Performance score normalization:
 *   Running  → VDOT (Jack Daniels formula). Comparable across all distances
 *              (5K through marathon). Higher = better. Typical range 30–85.
 *   Cycling  → normalized power in watts/kg (must be supplied by caller;
 *              not auto-calculable without NP and athlete weight).
 *   Other    → null (user must supply a score manually).
 *
 * Auto-detection criteria (AND logic — stricter than race detection):
 *   avg HR > 90% HRmax  AND  pace within 5% of personal best for that distance.
 */

import { calculateVdot } from './vdot.ts';

/**
 * Calculate a normalized performance score for a running activity using VDOT.
 *
 * Returns null when the sport is not running, or when distance/duration data
 * is unavailable — callers should prompt the user to enter a score manually.
 *
 * @param sport           Activity sport string (e.g. 'running', 'cycling')
 * @param distanceM       Distance in metres
 * @param durationSeconds Moving time in seconds
 */
export function calculatePerformanceScore(
  sport: string | null,
  distanceM: number | null,
  durationSeconds: number | null,
): number | null {
  if (!sport?.toLowerCase().includes('run')) return null;
  if (distanceM == null || distanceM <= 0) return null;
  if (durationSeconds == null || durationSeconds <= 0) return null;

  const timeMin = durationSeconds / 60;
  const vdot = calculateVdot(distanceM, timeMin);
  if (!isFinite(vdot) || vdot <= 0) return null;
  return Math.round(vdot * 10) / 10;
}

/**
 * Check whether an activity meets benchmark auto-detection criteria.
 *
 * Benchmark criteria use AND logic (both must be true):
 *   1. avg HR > 90% of athlete's estimated HRmax
 *   2. avg pace within 5% of the athlete's personal best for that distance
 *
 * Note: race detection (PMC-002) uses OR logic with an 88% HR threshold.
 * Benchmark detection is stricter — it requires both signals simultaneously.
 *
 * @param avgHr          Activity average heart rate (bpm), or null
 * @param hrMaxEstimate  Athlete's estimated max HR (bpm)
 * @param avgPaceSeconds Activity average pace (sec/km); lower = faster
 * @param pbPaceSeconds  Athlete's personal best pace for a similar distance (sec/km); null if unknown
 */
export function checkBenchmarkCriteria(
  avgHr: number | null,
  hrMaxEstimate: number,
  avgPaceSeconds: number | null,
  pbPaceSeconds: number | null,
): boolean {
  const hrOk = avgHr != null && avgHr > 0.90 * hrMaxEstimate;
  const paceOk =
    avgPaceSeconds != null &&
    pbPaceSeconds != null &&
    avgPaceSeconds <= pbPaceSeconds * 1.05;
  return hrOk && paceOk;
}

/**
 * Eligibility result returned by checkFittingEligibility.
 * This is the gate checked by PMC-004 before running the optimizer.
 */
export interface EligibilityResult {
  /** True when count >= 6 AND months_span >= 6 */
  eligible: boolean;
  /** Number of benchmark efforts on record */
  count: number;
  /** Months spanned from earliest to latest benchmark */
  months_span: number;
  /** Minimum benchmarks required (always 6) */
  needed: number;
}

/**
 * Compute fitting eligibility from a list of benchmark dates.
 *
 * Exported as a pure function so it can be unit-tested without DB access.
 * The async DB wrapper is checkFittingEligibility() in benchmarkEfforts.ts.
 */
export function computeFittingEligibility(dates: string[]): EligibilityResult {
  const needed = 6;
  const count = dates.length;
  if (count === 0) return { eligible: false, count, months_span: 0, needed };

  const sorted = [...dates].sort();
  const earliest = new Date(sorted[0] + 'T00:00:00Z');
  const latest = new Date(sorted[sorted.length - 1] + 'T00:00:00Z');
  const daysDiff = (latest.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24);
  const months_span = Math.round((daysDiff / 30.44) * 10) / 10;

  const eligible = count >= needed && months_span >= 6;
  return { eligible, count, months_span, needed };
}
