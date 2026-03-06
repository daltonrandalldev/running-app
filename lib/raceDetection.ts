/**
 * PMC-002: Race detection and k_race multiplier logic.
 *
 * Two detection methods (OR logic):
 *   1. Garmin activity type/sport contains 'race'
 *   2. avg HR > 88% of estimated HRmax (approximation for "avg HR > 88% for >40% of duration")
 *   3. Pace within 5% of athlete's personal best for that distance
 *
 * User-confirmed flags always take precedence and are never overwritten by auto-detection.
 */

/**
 * Returns the default k_race multiplier for ATL based on race duration.
 *
 *  < 4 hours  → 1.0 (no adjustment)
 *  4–8 hours  → 1.5×
 *  8–12 hours → 2.0×
 *  > 12 hours → 2.5×
 */
export function getKRace(durationHours: number): number {
  if (durationHours < 4) return 1.0;
  if (durationHours < 8) return 1.5;
  if (durationHours < 12) return 2.0;
  return 2.5;
}

export interface AutoDetectInput {
  /** Activity sport/type string from Garmin (e.g. 'running', 'cycling', 'race') */
  sport: string | null;
  /** Average heart rate for the activity (bpm) */
  avg_hr: number | null;
  /** Athlete's estimated maximum heart rate (bpm). Default: 185. */
  hr_max_estimate: number;
  /** Activity average pace (sec/km). Lower = faster. */
  avg_pace_seconds: number | null;
  /** Athlete's personal best pace for a similar distance (sec/km). Null if unknown. */
  pb_pace_seconds: number | null;
}

export type DetectionReason = 'activity_type' | 'avg_hr' | 'pace' | null;

export interface AutoDetectResult {
  is_race: boolean;
  /** Which criterion triggered detection. Null when is_race = false. */
  detection_reason: DetectionReason;
}

/**
 * Determine whether an activity should be flagged as a race using OR logic.
 *
 * This is a pure function — callers are responsible for supplying HRmax and
 * PB pace from the database before calling.
 */
export function autoDetectRace(input: AutoDetectInput): AutoDetectResult {
  // Method 1: Garmin activity type tagged as 'race'
  if (input.sport?.toLowerCase().includes('race')) {
    return { is_race: true, detection_reason: 'activity_type' };
  }

  // Method 2: avg HR > 88% of estimated HRmax
  // Approximation for "avg HR > 88% HRmax for >40% of duration" —
  // if the average is above threshold, enough of the effort was in that zone.
  if (input.avg_hr != null && input.avg_hr > 0.88 * input.hr_max_estimate) {
    return { is_race: true, detection_reason: 'avg_hr' };
  }

  // Method 3: pace within 5% of personal best
  // Lower sec/km = faster. "Within 5%" means pace <= PB * 1.05 (slower by at most 5%).
  if (input.avg_pace_seconds != null && input.pb_pace_seconds != null) {
    if (input.avg_pace_seconds <= input.pb_pace_seconds * 1.05) {
      return { is_race: true, detection_reason: 'pace' };
    }
  }

  return { is_race: false, detection_reason: null };
}
