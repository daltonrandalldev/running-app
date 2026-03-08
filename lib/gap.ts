/**
 * GAP-001: Core Grade Adjusted Pace (GAP) Calculation Library
 *
 * Pure TypeScript — zero I/O, zero external dependencies.
 * Implements Minetti et al. (2002) metabolic cost curve to normalize
 * running pace for elevation change.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Flat-ground metabolic cost from the Minetti curve: C(0) = 3.6 J/kg/m */
const C_FLAT = 3.6;

/** Minimum fractional grade (clamping lower bound). */
const GRADE_MIN = -0.40;

/** Maximum fractional grade (clamping upper bound). */
const GRADE_MAX = 0.45;

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GarminLap {
  lap: number;
  moving_time_seconds: number | null;
  distance: number | null;  // in meters
  ascent: number | null;
  descent: number | null;
}

export interface LapGapResult {
  lap: number;
  raw_pace_sec_per_km: number;
  gap_pace_sec_per_km: number;
  grade_fractional: number;
  grade_clamped: boolean;
  distance_km: number;
}

export interface ActivityGapResult {
  avg_gap_pace_seconds: number | null;
  avg_raw_pace_seconds: number | null;
  total_ascent_m: number;
  gap_applied: boolean;
  lap_count: number;
  laps_grade_clamped: number;
}

export interface GAPResult {
  lapGapResults: LapGapResult[];
  activityGap: ActivityGapResult;
}

// ── Exported Functions ────────────────────────────────────────────────────────

/**
 * Computes the Minetti et al. (2002) metabolic cost of running at a given
 * fractional grade. Returns cost in J/kg/m.
 */
export function minettiCost(grade: number): number {
  const g = grade;
  return (
    155.4 * g ** 5 -
    30.4  * g ** 4 -
    43.3  * g ** 3 +
    46.3  * g ** 2 +
    19.5  * g +
    3.6
  );
}

/**
 * Clamps a fractional grade to [GRADE_MIN, GRADE_MAX] where the Minetti curve
 * is well-behaved. Returns the clamped grade and whether clamping occurred.
 */
export function clampGrade(grade: number): { grade: number; clamped: boolean } {
  if (grade < GRADE_MIN) return { grade: GRADE_MIN, clamped: true };
  if (grade > GRADE_MAX) return { grade: GRADE_MAX, clamped: true };
  return { grade, clamped: false };
}

/**
 * Computes the fractional grade for a lap given ascent, descent, and distance.
 * Null ascent/descent values are treated as 0.
 */
export function lapGrade(
  ascent: number | null,
  descent: number | null,
  distanceKm: number,
): number {
  if (distanceKm <= 0) return 0;
  const asc = ascent ?? 0;
  const desc = descent ?? 0;
  return (asc - desc) / (distanceKm * 1000);
}

/**
 * Computes the Grade Adjusted Pace for a single lap given the actual pace
 * (in sec/km) and the fractional grade (already clamped).
 */
export function lapGapPace(actualPaceSecPerKm: number, grade: number): number {
  const cost = minettiCost(grade);
  if (cost <= 0) return actualPaceSecPerKm;
  return round2(actualPaceSecPerKm * (C_FLAT / cost));
}

/**
 * Computes per-lap GAP results and activity-level summary from a set of
 * Garmin lap records. Laps with zero or null moving_time or distance are
 * skipped. Activity-level averages are distance-weighted.
 */
export function computeGAP(laps: GarminLap[]): GAPResult {
  const lapGapResults: LapGapResult[] = [];
  let totalWeightedGapPace = 0;
  let totalWeightedRawPace = 0;
  let totalDistance = 0;
  let totalAscent = 0;
  let hasElevationData = false;
  let lapsGradeClamped = 0;

  for (const lap of laps) {
    const distanceKm = (lap.distance ?? 0) / 1000;
    const movingTime = lap.moving_time_seconds ?? 0;

    if (distanceKm <= 0 || movingTime <= 0) continue;

    const rawPace = movingTime / distanceKm;

    const rawGrade = lapGrade(lap.ascent, lap.descent, distanceKm);
    const { grade: clampedGrade, clamped } = clampGrade(rawGrade);
    const gapPace = lapGapPace(rawPace, clampedGrade);

    if (clamped) lapsGradeClamped++;

    if ((lap.ascent != null && lap.ascent !== 0) || (lap.descent != null && lap.descent !== 0)) {
      hasElevationData = true;
    }

    totalAscent += lap.ascent ?? 0;

    totalWeightedGapPace += gapPace * distanceKm;
    totalWeightedRawPace += rawPace * distanceKm;
    totalDistance += distanceKm;

    lapGapResults.push({
      lap: lap.lap,
      raw_pace_sec_per_km: round2(rawPace),
      gap_pace_sec_per_km: gapPace,
      grade_fractional: round2(clampedGrade),
      grade_clamped: clamped,
      distance_km: round2(distanceKm),
    });
  }

  const activityGap: ActivityGapResult = {
    avg_gap_pace_seconds: totalDistance > 0 ? round2(totalWeightedGapPace / totalDistance) : null,
    avg_raw_pace_seconds: totalDistance > 0 ? round2(totalWeightedRawPace / totalDistance) : null,
    total_ascent_m: round2(totalAscent),
    gap_applied: hasElevationData,
    lap_count: lapGapResults.length,
    laps_grade_clamped: lapsGradeClamped,
  };

  return { lapGapResults, activityGap };
}
