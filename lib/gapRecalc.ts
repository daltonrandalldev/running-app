/**
 * GAP-003: Supabase I/O Pipeline for Grade Adjusted Pace
 *
 * Reads lap records from garmin_activity_laps, calls the pure computeGAP()
 * function from lib/gap.ts, upserts results into lap_gap and activity_gap,
 * and delegates to backfillDecouplingWithGAP() to trigger Section 5
 * re-computation.
 *
 * Pattern follows decouplingRecalc.ts: singleton Supabase client, try/catch
 * on every exported async function, sequential batch processing.
 */

import { supabase } from './supabase';
import {
  computeGAP,
  type GarminLap,
  type GAPResult,
  type LapGapResult,
  type ActivityGapResult,
} from './gap';
import { backfillDecouplingWithGAP } from './decouplingRecalc';
import { recalculateEF } from './efRecalc';

// ── Module constants ───────────────────────────────────────────────────────────

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Minimum total ascent (meters) for GAP to be considered meaningful. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Batch size for upsert operations (matches pmcRecalc.ts pattern). */
const BATCH_SIZE = 500;

// ── Return-type interfaces ────────────────────────────────────────────────────

export interface GAPRecalcResult {
  ok: boolean;
  activityId?: string;
  gap_applied?: boolean;
  lap_count?: number;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

export interface BatchGAPResult {
  ok: boolean;
  processed: number;
  skipped: number;
  errors: number;
  backfill_triggered: number;
  error?: string;
}

// ── GAP-003: Per-activity GAP computation ─────────────────────────────────────

/**
 * Compute and persist Grade Adjusted Pace for a single activity.
 *
 * Fetches activity metadata and lap records from Supabase, calls computeGAP(),
 * upserts per-lap results into lap_gap, and upserts the activity-level summary
 * into activity_gap.
 */
export async function computeGAPForActivity(activityId: string): Promise<GAPRecalcResult> {
  try {
    // Step 1: Fetch activity metadata
    const { data: actRow, error: actErr } = await supabase
      .from('garmin_activities')
      .select('activity_id, start_time, ascent')
      .eq('activity_id', activityId)
      .maybeSingle();

    if (actErr) throw actErr;
    if (!actRow) return { ok: false, error: `Activity ${activityId} not found` };

    // Step 2: Fetch lap records
    const { data: lapRows, error: lapErr } = await supabase
      .from('garmin_activity_laps')
      .select('lap, moving_time_seconds, distance, ascent, descent')
      .eq('activity_id', activityId)
      .order('lap', { ascending: true });

    if (lapErr) throw lapErr;

    // Step 3: Map to GarminLap[]
    const laps: GarminLap[] = (lapRows ?? []).map((r: any) => ({
      lap: r.lap,
      moving_time_seconds: r.moving_time_seconds,
      distance: r.distance,
      ascent: r.ascent,
      descent: r.descent,
    }));

    // Step 4: Compute GAP
    const result = computeGAP(laps);

    // Step 5: Upsert lap_gap (batched)
    const lapUpsertRows = result.lapGapResults.map((l) => ({
      athlete_id: SINGLE_ATHLETE_ID,
      activity_id: String(actRow.activity_id),
      lap: l.lap,
      raw_pace_sec_per_km: l.raw_pace_sec_per_km,
      gap_pace_sec_per_km: l.gap_pace_sec_per_km,
      grade_fractional: l.grade_fractional,
      grade_clamped: l.grade_clamped,
      distance_km: l.distance_km,
    }));

    for (let i = 0; i < lapUpsertRows.length; i += BATCH_SIZE) {
      const chunk = lapUpsertRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from('lap_gap')
        .upsert(chunk, { onConflict: 'activity_id,lap' });
      if (error) throw error;
    }

    // Step 6: Upsert activity_gap
    const { error: actUpsertErr } = await supabase
      .from('activity_gap')
      .upsert({
        athlete_id: SINGLE_ATHLETE_ID,
        activity_id: String(actRow.activity_id),
        date: String(actRow.start_time).slice(0, 10),
        avg_gap_pace_seconds: result.activityGap.avg_gap_pace_seconds,
        avg_raw_pace_seconds: result.activityGap.avg_raw_pace_seconds,
        total_ascent_m: result.activityGap.total_ascent_m,
        gap_applied: result.activityGap.gap_applied,
        lap_count: result.activityGap.lap_count,
        laps_grade_clamped: result.activityGap.laps_grade_clamped,
      }, { onConflict: 'activity_id' });

    if (actUpsertErr) throw actUpsertErr;

    // Step 7: Return result
    return {
      ok: true,
      activityId: String(actRow.activity_id),
      gap_applied: result.activityGap.gap_applied,
      lap_count: result.activityGap.lap_count,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── GAP-003: Batch entry-point ────────────────────────────────────────────────

/**
 * Process a list of activity IDs sequentially, then trigger a decoupling
 * backfill once all activities have been processed.
 *
 * Sequential processing is intentional — no Promise.all.
 */
export async function computeGAPBatch(activityIds: string[]): Promise<BatchGAPResult> {
  if (activityIds.length === 0) {
    return { ok: true, processed: 0, skipped: 0, errors: 0, backfill_triggered: 0 };
  }

  try {
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const id of activityIds) {
      const result = await computeGAPForActivity(id);
      if (!result.ok) {
        errors++;
      } else if (result.skipped) {
        skipped++;
      } else {
        processed++;
      }
    }

    const backfillResult = await triggerDecouplingBackfill();
    const backfill_triggered = backfillResult.ok ? (backfillResult.count ?? 0) : 0;

    await triggerEFRecalc(/* fromDate is not passed here; recalculate all */);

    return { ok: true, processed, skipped, errors, backfill_triggered };
  } catch (e: any) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: 0,
      backfill_triggered: 0,
      error: e?.message ?? 'Unknown error',
    };
  }
}

// ── EF-005: EF recalculation delegation ──────────────────────────────────────

/**
 * Delegates to recalculateEF() from efRecalc.ts.
 * Does not duplicate any logic — thin wrapper for error isolation only.
 */
export async function triggerEFRecalc(fromDate?: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const result = await recalculateEF(fromDate);
    return { ok: result.ok, error: result.error };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── GAP-003: Decoupling backfill delegation ───────────────────────────────────

/**
 * Delegates to backfillDecouplingWithGAP() from decouplingRecalc.ts.
 * Does not duplicate any logic — thin wrapper for error isolation only.
 */
export async function triggerDecouplingBackfill(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  try {
    const result = await backfillDecouplingWithGAP();
    return result;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
