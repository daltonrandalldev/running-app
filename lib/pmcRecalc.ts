/**
 * PMC recalculation job.
 *
 * Reads activity load scores from garmin_activities, calls calculatePMC,
 * and upserts the results into daily_pmc_values.
 *
 * Trigger: call recalculatePMC(earliestAffectedDate) after any new/edited
 * activity. Pass no argument to backfill from the earliest activity on record
 * (capped at MAX_BACKFILL_DAYS).
 *
 * PMC-002 additions:
 *   - runAutoDetection() evaluates race detection rules on all unprocessed
 *     activities and writes is_race / race_detection_source / k_race_applied /
 *     effective_tss_race back to garmin_activities.
 *   - recalculatePMC now reads is_race and k_race_applied, passing atl_tss to
 *     calculatePMC so ATL reflects race fatigue multipliers while CTL stays raw.
 */

import { supabase } from './supabase';
import { calculatePMC, type PMCParams } from './pmc';
import { autoDetectRace, getKRace } from './raceDetection';

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Maximum days to backfill on first import (4 years). */
const MAX_BACKFILL_DAYS = 365 * 4;

export interface RecalcResult {
  ok: boolean;
  rowsUpserted?: number;
  error?: string;
}

export interface AutoDetectResult {
  ok: boolean;
  updated?: number;
  error?: string;
}

/**
 * Run auto-detection for all activities that have not yet been evaluated
 * (race_detection_source IS NULL or 'none'). Never overwrites user-confirmed
 * flags (race_detection_source = 'user').
 *
 * For each qualifying activity:
 *   - Evaluates OR-logic race criteria
 *   - Writes is_race, race_detection_source, k_race_applied, effective_tss_race
 */
export async function runAutoDetection(): Promise<AutoDetectResult> {
  try {
    // Fetch unevaluated activities (skip user-confirmed)
    const { data: activities, error: fetchErr } = await supabase
      .from('garmin_activities')
      .select(
        'activity_id, sport, avg_hr, moving_time_seconds, avg_pace_seconds, distance, active_load'
      )
      .or('race_detection_source.is.null,race_detection_source.eq.none')
      .not('active_load', 'is', null);

    if (fetchErr) throw fetchErr;
    if (!activities?.length) return { ok: true, updated: 0 };

    // Estimate athlete HRmax from historical maximum observed heart rate
    const { data: hrPeak } = await supabase
      .from('garmin_activities')
      .select('max_hr')
      .not('max_hr', 'is', null)
      .order('max_hr', { ascending: false })
      .limit(1);
    const hrMaxEstimate: number = hrPeak?.[0]?.max_hr ?? 185;

    // Fetch all running activities to compute per-distance personal bests
    const { data: runningActivities } = await supabase
      .from('garmin_activities')
      .select('distance, avg_pace_seconds')
      .ilike('sport', '%run%')
      .not('avg_pace_seconds', 'is', null)
      .not('distance', 'is', null);

    let updated = 0;

    for (const act of activities) {
      // Look up PB pace for activities with a similar distance (±15%)
      let pbPaceSeconds: number | null = null;
      if (act.distance != null && runningActivities) {
        const similar = runningActivities.filter(
          (r) =>
            r.distance >= act.distance * 0.85 &&
            r.distance <= act.distance * 1.15 &&
            r.avg_pace_seconds != null
        );
        if (similar.length > 0) {
          pbPaceSeconds = Math.min(...similar.map((r) => r.avg_pace_seconds as number));
        }
      }

      const detection = autoDetectRace({
        sport: act.sport,
        avg_hr: act.avg_hr,
        hr_max_estimate: hrMaxEstimate,
        avg_pace_seconds: act.avg_pace_seconds,
        pb_pace_seconds: pbPaceSeconds,
      });

      const durationHours = (act.moving_time_seconds ?? 0) / 3600;
      const k_race_applied = detection.is_race ? getKRace(durationHours) : null;
      const effective_tss_race =
        detection.is_race && k_race_applied != null && act.active_load != null
          ? act.active_load * k_race_applied
          : null;

      const { error: updateErr } = await supabase
        .from('garmin_activities')
        .update({
          is_race: detection.is_race,
          race_detection_source: detection.is_race ? 'auto' : 'none',
          k_race_applied,
          effective_tss_race,
        })
        .eq('activity_id', act.activity_id);

      if (!updateErr) updated++;
    }

    return { ok: true, updated };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

/**
 * Recalculate PMC values and persist them to daily_pmc_values.
 *
 * @param fromDate   ISO date (YYYY-MM-DD). Recalculate from this date onward.
 *                   Omit to recalculate from the earliest activity (capped at
 *                   MAX_BACKFILL_DAYS ago).
 * @param sport      Sport filter. Defaults to 'combined' (all sports summed).
 * @param params     Time constants. Defaults: tc_fitness=42, tc_fatigue=7.
 */
export async function recalculatePMC(
  fromDate?: string,
  sport: string = 'combined',
  params: PMCParams = {},
): Promise<RecalcResult> {
  const tc_fitness = params.tc_fitness ?? 42;
  const tc_fatigue = params.tc_fatigue ?? 7;

  try {
    // Determine the earliest date to fetch activities from
    const cutoff = fromDate ?? earliestAllowedDate();

    // Fetch activities with an active_load from the cutoff date onward.
    // Also fetch is_race and k_race_applied for PMC-002 race fatigue multiplier.
    let query = supabase
      .from('garmin_activities')
      .select('start_time, active_load, is_race, k_race_applied')
      .not('active_load', 'is', null)
      .gte('start_time', cutoff)
      .order('start_time', { ascending: true });

    // Sport filtering: 'combined' includes all sports, otherwise filter by type
    if (sport !== 'combined') {
      query = query.ilike('sport', `%${sport}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Map activities to PMC input format.
    // CTL uses raw active_load. ATL uses effective_tss (active_load × k_race_applied)
    // for race activities; raw active_load otherwise.
    const activities = (data ?? []).map(
      (row: { start_time: string; active_load: number; is_race: boolean | null; k_race_applied: number | null }) => {
        const rawTss = row.active_load;
        const atl_tss =
          row.is_race && row.k_race_applied != null
            ? rawTss * row.k_race_applied
            : undefined;
        return {
          date: row.start_time.slice(0, 10),
          tss: rawTss,
          atl_tss,
        };
      }
    );

    const pmcDays = calculatePMC(activities, { tc_fitness, tc_fatigue });

    if (pmcDays.length === 0) {
      return { ok: true, rowsUpserted: 0 };
    }

    // Upsert to daily_pmc_values — conflict target is (athlete_id, date, sport)
    const rows = pmcDays.map((day) => ({
      athlete_id: SINGLE_ATHLETE_ID,
      date: day.date,
      sport,
      ctl: day.ctl,
      atl: day.atl,
      tsb: day.tsb,
      tc_fitness_used: tc_fitness,
      tc_fatigue_used: tc_fatigue,
    }));

    // Batch upserts in chunks of 500 to avoid payload limits
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error: upsertError } = await supabase
        .from('daily_pmc_values')
        .upsert(chunk, { onConflict: 'athlete_id,date,sport' });
      if (upsertError) throw upsertError;
    }

    return { ok: true, rowsUpserted: rows.length };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

function earliestAllowedDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - MAX_BACKFILL_DAYS);
  return d.toISOString().slice(0, 10);
}
