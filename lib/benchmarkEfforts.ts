/**
 * PMC-003: Benchmark Effort System
 *
 * Provides ground-truth performance observations for adaptive parameter
 * fitting (PMC-004). A benchmark effort is a near-maximal activity that
 * reveals the athlete's current performance capacity at a specific date.
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

import { supabase } from './supabase';
import { recalculatePMC } from './pmcRecalc';
import {
  calculatePerformanceScore,
  checkBenchmarkCriteria,
  computeFittingEligibility,
  type EligibilityResult,
} from './benchmarkUtils';

// Re-export pure utilities so callers only need one import
export {
  calculatePerformanceScore,
  checkBenchmarkCriteria,
  computeFittingEligibility,
  type EligibilityResult,
} from './benchmarkUtils';

/** Placeholder athlete ID until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

// ── DB types ──────────────────────────────────────────────────────────────────

export interface BenchmarkEffort {
  id: string;
  athlete_id: string;
  activity_id: string | null;
  date: string;
  sport: string;
  duration_seconds: number;
  performance_score: number;
  effort_level: 'user_confirmed' | 'auto_detected';
  ctl_on_date: number | null;
  atl_on_date: number | null;
  notes: string | null;
  created_at: string;
}

export interface SaveBenchmarkParams {
  activity_id: string;
  date: string;
  sport: string;
  duration_seconds: number;
  performance_score: number;
  effort_level: 'user_confirmed' | 'auto_detected';
  notes?: string;
}

export interface SaveBenchmarkResult {
  ok: boolean;
  data?: BenchmarkEffort;
  error?: string;
}

// ── DB functions ──────────────────────────────────────────────────────────────

/**
 * Save (insert or update) a benchmark effort for an activity.
 *
 * Automatically populates ctl_on_date / atl_on_date from daily_pmc_values
 * for the benchmark date. If PMC values don't exist yet, triggers a
 * recalculation from that date before inserting (R4).
 */
export async function saveBenchmarkEffort(
  params: SaveBenchmarkParams,
): Promise<SaveBenchmarkResult> {
  try {
    // R4: Look up CTL/ATL for the benchmark date from daily_pmc_values
    let ctlOnDate: number | null = null;
    let atlOnDate: number | null = null;

    const { data: pmcRow } = await supabase
      .from('daily_pmc_values')
      .select('ctl, atl')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('date', params.date)
      .eq('sport', 'combined')
      .maybeSingle();

    if (pmcRow) {
      ctlOnDate = pmcRow.ctl;
      atlOnDate = pmcRow.atl;
    } else {
      // Trigger PMC recalculation from this date forward, then retry
      await recalculatePMC(params.date);
      const { data: retryRow } = await supabase
        .from('daily_pmc_values')
        .select('ctl, atl')
        .eq('athlete_id', SINGLE_ATHLETE_ID)
        .eq('date', params.date)
        .eq('sport', 'combined')
        .maybeSingle();
      if (retryRow) {
        ctlOnDate = retryRow.ctl;
        atlOnDate = retryRow.atl;
      }
    }

    // Check whether a row already exists for this activity to decide insert vs update
    const { data: existing } = await supabase
      .from('benchmark_efforts')
      .select('id')
      .eq('activity_id', params.activity_id)
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .maybeSingle();

    const payload = {
      athlete_id: SINGLE_ATHLETE_ID,
      activity_id: params.activity_id,
      date: params.date,
      sport: params.sport,
      duration_seconds: params.duration_seconds,
      performance_score: params.performance_score,
      effort_level: params.effort_level,
      ctl_on_date: ctlOnDate,
      atl_on_date: atlOnDate,
      notes: params.notes ?? null,
    };

    let data: BenchmarkEffort | null = null;
    let error: { message: string } | null = null;

    if (existing) {
      ({ data, error } = await supabase
        .from('benchmark_efforts')
        .update(payload)
        .eq('id', existing.id)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('benchmark_efforts')
        .insert(payload)
        .select()
        .single());
    }

    if (error) throw error;
    return { ok: true, data: data ?? undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

/**
 * Remove the benchmark effort tied to an activity.
 * Called when the user toggles "Mark as benchmark effort" off.
 */
export async function removeBenchmarkEffort(
  activityId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('benchmark_efforts')
      .delete()
      .eq('activity_id', activityId)
      .eq('athlete_id', SINGLE_ATHLETE_ID);
    if (error) throw error;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

/**
 * Fetch the existing benchmark effort record for an activity, if any.
 * Returns null when no benchmark has been set for this activity.
 */
export async function getBenchmarkForActivity(
  activityId: string,
): Promise<BenchmarkEffort | null> {
  const { data } = await supabase
    .from('benchmark_efforts')
    .select('*')
    .eq('activity_id', activityId)
    .eq('athlete_id', SINGLE_ATHLETE_ID)
    .maybeSingle();
  return data ?? null;
}

/**
 * Check whether an athlete has enough benchmark data for adaptive fitting.
 *
 * Returns {eligible: true} when count >= 6 AND months_span >= 6.
 * This is the gate checked by PMC-004 before running the optimizer (R5).
 *
 * @param athleteId  Defaults to the single-athlete placeholder.
 * @param sport      Filter by sport. 'combined' queries all sports.
 */
export async function checkFittingEligibility(
  athleteId: string = SINGLE_ATHLETE_ID,
  sport: string = 'combined',
): Promise<EligibilityResult> {
  try {
    let query = supabase
      .from('benchmark_efforts')
      .select('date')
      .eq('athlete_id', athleteId);

    if (sport !== 'combined') {
      query = query.eq('sport', sport);
    }

    const { data } = await query;
    const dates = (data ?? []).map((r: { date: string }) => r.date);
    return computeFittingEligibility(dates);
  } catch {
    return { eligible: false, count: 0, months_span: 0, needed: 6 };
  }
}

/**
 * Auto-detect benchmark efforts from garmin_activities and insert them.
 *
 * Applies AND-logic criteria to running activities:
 *   avg HR > 90% HRmax  AND  pace within 5% of personal best
 *
 * Only inserts new rows — does not overwrite user-confirmed benchmarks (R3).
 * Performance score is calculated as VDOT.
 * Only running activities are auto-detected (cycling requires manual entry).
 */
export async function runBenchmarkAutoDetection(): Promise<{
  ok: boolean;
  inserted: number;
  error?: string;
}> {
  try {
    // Collect activity IDs that already have a benchmark row (any effort_level)
    const { data: existing } = await supabase
      .from('benchmark_efforts')
      .select('activity_id')
      .eq('athlete_id', SINGLE_ATHLETE_ID);
    const existingIds = new Set(
      (existing ?? []).map((r: { activity_id: string }) => r.activity_id),
    );

    // Estimate HRmax from highest observed max_hr
    const { data: hrPeak } = await supabase
      .from('garmin_activities')
      .select('max_hr')
      .not('max_hr', 'is', null)
      .order('max_hr', { ascending: false })
      .limit(1);
    const hrMaxEstimate: number = hrPeak?.[0]?.max_hr ?? 185;

    // Fetch all running activities with the fields needed for detection
    const { data: activities, error: fetchErr } = await supabase
      .from('garmin_activities')
      .select(
        'activity_id, sport, start_time, moving_time_seconds, distance, avg_hr, avg_pace_seconds',
      )
      .ilike('sport', '%run%')
      .not('avg_hr', 'is', null)
      .not('avg_pace_seconds', 'is', null)
      .not('distance', 'is', null);

    if (fetchErr) throw fetchErr;
    if (!activities?.length) return { ok: true, inserted: 0 };

    // Fetch all running activities to build per-distance personal bests
    const { data: allRunning } = await supabase
      .from('garmin_activities')
      .select('distance, avg_pace_seconds')
      .ilike('sport', '%run%')
      .not('avg_pace_seconds', 'is', null)
      .not('distance', 'is', null);

    let inserted = 0;

    for (const act of activities) {
      if (existingIds.has(act.activity_id)) continue;

      // Find PB pace for a similar distance band (±15%)
      let pbPaceSeconds: number | null = null;
      if (allRunning) {
        const similar = allRunning.filter(
          (r) =>
            r.distance >= act.distance * 0.85 &&
            r.distance <= act.distance * 1.15 &&
            r.avg_pace_seconds != null,
        );
        if (similar.length > 0) {
          pbPaceSeconds = Math.min(
            ...similar.map((r) => r.avg_pace_seconds as number),
          );
        }
      }

      if (
        !checkBenchmarkCriteria(
          act.avg_hr,
          hrMaxEstimate,
          act.avg_pace_seconds,
          pbPaceSeconds,
        )
      ) {
        continue;
      }

      const durationSeconds: number = act.moving_time_seconds ?? 0;
      const performanceScore = calculatePerformanceScore(
        'running',
        act.distance,
        durationSeconds,
      );
      if (performanceScore == null) continue;

      const date: string = act.start_time.slice(0, 10);

      // Look up CTL/ATL from daily_pmc_values (best-effort; null if not yet calculated)
      const { data: pmcRow } = await supabase
        .from('daily_pmc_values')
        .select('ctl, atl')
        .eq('athlete_id', SINGLE_ATHLETE_ID)
        .eq('date', date)
        .eq('sport', 'combined')
        .maybeSingle();

      const { error: insertErr } = await supabase
        .from('benchmark_efforts')
        .insert({
          athlete_id: SINGLE_ATHLETE_ID,
          activity_id: act.activity_id,
          date,
          sport: 'running',
          duration_seconds: durationSeconds,
          performance_score: performanceScore,
          effort_level: 'auto_detected',
          ctl_on_date: pmcRow?.ctl ?? null,
          atl_on_date: pmcRow?.atl ?? null,
          notes: null,
        });

      if (!insertErr) inserted++;
    }

    return { ok: true, inserted };
  } catch (e: any) {
    return { ok: false, inserted: 0, error: e?.message ?? 'Unknown error' };
  }
}
