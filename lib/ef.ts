/**
 * EF-002: Efficiency Factor (EF) Calculation Library
 *
 * Pure TypeScript module — zero I/O, zero external dependencies.
 * No imports from Supabase, AsyncStorage, or React Native.
 */

// Re-export from hrZones.ts for convenience (do not redefine):
export type { HRZoneBounds, HRZones } from './hrZones';

import type { HRZones } from './hrZones';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EFLapRecord {
  lap: number;
  moving_time_seconds: number | null;
  elapsed_time_seconds: number | null;  // cumulative elapsed from activity start
  distance: number | null;              // meters
  avg_hr: number | null;
  gap_pace_sec_per_km: number | null;   // from lap_gap table; null if GAP not computed
}

export interface EFFromLapsResult {
  efValue: number;
  lapCount: number;
  gapUsed: boolean;
}

export interface QualifyingResult {
  qualifying: boolean;
  reason?: 'duration_too_short' | 'temp_out_of_range' | 'hr_outside_z2' | 'insufficient_laps';
}

export interface EFRegressionResult {
  slope: number;       // EF per day (positive = improving)
  intercept: number;   // EF at day 0 (epoch baseline)
  rSquared: number;    // Coefficient of determination [0, 1]
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Calculate Efficiency Factor from speed and heart rate.
 * Returns null if avgHR <= 0 or speedMps <= 0.
 */
export function calculateEFRun(speedMps: number, avgHR: number): number | null {
  if (avgHR <= 0 || speedMps <= 0) return null;
  return speedMps / avgHR;
}

/**
 * Calculate EF from lap records using time-weighted averaging.
 * Warmup exclusion: drops laps where elapsed_time_seconds is null or < 600.
 * Uses GAP pace when available, otherwise raw distance/time.
 * Returns null if no valid post-warmup laps remain.
 */
export function calculateEFFromLaps(laps: EFLapRecord[]): EFFromLapsResult | null {
  // Filter post-warmup laps: elapsed_time_seconds must be non-null and >= 600
  const postWarmup = laps.filter(
    (lap) => lap.elapsed_time_seconds !== null && lap.elapsed_time_seconds >= 600,
  );

  if (postWarmup.length === 0) return null;

  // Build valid laps (skip laps with null/zero moving_time or avg_hr)
  let weightedSpeedSum = 0;
  let weightedHRSum = 0;
  let totalWeight = 0;
  let gapUsed = false;
  let lapCount = 0;

  for (const lap of postWarmup) {
    const movingTime = lap.moving_time_seconds;
    const avgHR = lap.avg_hr;

    if (!movingTime || movingTime <= 0) continue;
    if (!avgHR || avgHR <= 0) continue;

    let speedMps: number;
    if (lap.gap_pace_sec_per_km !== null) {
      // GAP pace available: speed = 1000m / gap_pace_sec_per_km
      speedMps = 1000 / lap.gap_pace_sec_per_km;
      gapUsed = true;
    } else {
      // Raw speed from distance / moving time
      speedMps = (lap.distance ?? 0) / movingTime;
    }

    weightedSpeedSum += speedMps * movingTime;
    weightedHRSum += avgHR * movingTime;
    totalWeight += movingTime;
    lapCount++;
  }

  if (lapCount === 0 || totalWeight === 0) return null;

  const avgSpeed = weightedSpeedSum / totalWeight;
  const avgHR = weightedHRSum / totalWeight;
  const efValue = calculateEFRun(avgSpeed, avgHR);

  if (efValue === null) return null;

  return { efValue, lapCount, gapUsed };
}

/**
 * Determine whether a run qualifies for EF tracking.
 * Evaluates conditions in order: duration, temperature, HR zone (first-match wins).
 */
export function isQualifyingRun(params: {
  movingTimeSec: number;
  avgHR: number;
  zones: HRZones;
  avgTempC: number | null;
}): QualifyingResult {
  const { movingTimeSec, avgHR, zones, avgTempC } = params;

  // 1. Duration check (must be > 1800s)
  if (movingTimeSec <= 1800) {
    return { qualifying: false, reason: 'duration_too_short' };
  }

  // 2. Temperature check (null temperature does not disqualify)
  if (avgTempC !== null && (avgTempC > 27 || avgTempC < 0)) {
    return { qualifying: false, reason: 'temp_out_of_range' };
  }

  // 3. HR zone check: must be within Z1 min and Z2 max (zones[0] = Z1, zones[1] = Z2)
  if (avgHR > zones[1].max || avgHR < zones[0].min) {
    return { qualifying: false, reason: 'hr_outside_z2' };
  }

  return { qualifying: true };
}

/**
 * Compute the rolling average EF over a window of days ending at referenceDate (inclusive).
 * Window: [referenceDate - windowDays + 1, referenceDate].
 * Returns null if no entries fall within the window.
 */
export function computeRollingEFAvg(
  entries: Array<{ date: string; efValue: number }>,
  windowDays: number,
  referenceDate?: string,
): number | null {
  const refDate = referenceDate ?? new Date().toISOString().slice(0, 10);

  // Calculate window start date
  const refMs = new Date(refDate).getTime();
  const windowStartMs = refMs - (windowDays - 1) * 24 * 60 * 60 * 1000;
  const windowStart = new Date(windowStartMs).toISOString().slice(0, 10);

  const inWindow = entries.filter(
    (e) => e.date >= windowStart && e.date <= refDate,
  );

  if (inWindow.length === 0) return null;

  const sum = inWindow.reduce((acc, e) => acc + e.efValue, 0);
  return sum / inWindow.length;
}

/**
 * Compute OLS linear regression of EF values over time.
 * Day index = days since the earliest date in the input set.
 * Returns null for fewer than 3 points or zero x-variance (all same date).
 */
export function computeEFRegression(
  entries: Array<{ date: string; efValue: number }>,
): EFRegressionResult | null {
  if (entries.length < 3) return null;

  // Find the earliest date to use as day 0
  const dates = entries.map((e) => e.date);
  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const minMs = new Date(minDate).getTime();

  // Convert dates to day indices
  const points = entries.map((e) => ({
    x: Math.round((new Date(e.date).getTime() - minMs) / (24 * 60 * 60 * 1000)),
    y: e.efValue,
  }));

  // Check for zero x-variance (all same date)
  const xValues = points.map((p) => p.x);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  if (xMin === xMax) return null;

  const n = points.length;
  const sumX = points.reduce((acc, p) => acc + p.x, 0);
  const sumY = points.reduce((acc, p) => acc + p.y, 0);
  const sumXY = points.reduce((acc, p) => acc + p.x * p.y, 0);
  const sumX2 = points.reduce((acc, p) => acc + p.x * p.x, 0);

  const meanX = sumX / n;
  const meanY = sumY / n;

  const slope = (sumXY - n * meanX * meanY) / (sumX2 - n * meanX * meanX);
  const intercept = meanY - slope * meanX;

  // Compute R²
  const ssTot = points.reduce((acc, p) => acc + (p.y - meanY) ** 2, 0);
  let rSquared: number;
  if (ssTot === 0) {
    // All EF values identical
    rSquared = 1.0;
  } else {
    const ssRes = points.reduce((acc, p) => {
      const yHat = slope * p.x + intercept;
      return acc + (p.y - yHat) ** 2;
    }, 0);
    rSquared = 1 - ssRes / ssTot;
  }

  // TODO (Section 21): add computeEFPolynomialRegression() when qualifying run count grows

  return { slope, intercept, rSquared };
}

/**
 * Detect whether the 30-day rolling EF has diverged from the 90-day baseline
 * by more than the threshold (default 5%).
 * Returns false if avg90d is 0 or either value is not finite.
 */
export function detectEFAlert(
  avg30d: number,
  avg90d: number,
  threshold = 0.05,
): boolean {
  if (avg90d === 0) return false;
  if (!Number.isFinite(avg30d) || !Number.isFinite(avg90d)) return false;
  return Math.abs(avg30d - avg90d) / avg90d > threshold;
}

/**
 * Normalize EF for temperature effects.
 * STUB — returns ef unchanged pending Section 21 model fitting.
 */
export function normalizeTempEF(
  ef: number,
  tempC: number,
  refTempC = 15,
): number {
  // TODO (Section 21): implement normalization.
  // Suggested signature for the final implementation:
  //   normalizeTempEF(ef, tempC, refTempC) → ef_normalized
  //   using model: ef_adjusted = ef / (1 + k * (tempC - refTempC))
  //   where k is a fitted per-athlete coefficient from Section 21.
  // Reference: Ely et al. (2007) ~1% HR increase per 1°C above 10°C at threshold intensity.
  void tempC; void refTempC;
  return ef;
}
