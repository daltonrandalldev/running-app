/**
 * DEC-003 / DEC-004 / DEC-005 / DEC-006: Decoupling Recalculation Pipeline
 *
 * Reads activity lap data from Supabase, computes aerobic decoupling scores via
 * lib/decoupling.ts, and persists results to three tables:
 *   - activity_decoupling      (per-activity EF and decoupling metrics)
 *   - decoupling_baseline      (per-tier statistical baseline; DEC-004)
 *   - decoupling_trend         (rolling 30-day mean trend; DEC-005)
 *
 * DEC-006: computeActivityDecouplingBatch() is the sync pipeline entry-point.
 * Call it after recalculateAllSports() completes with the list of newly synced
 * activity IDs.
 *
 * Pattern follows pmcRecalc.ts: singleton Supabase client, try/catch on every
 * exported async function, sequential batch processing.
 */

import { supabase } from './supabase';
import {
  computeDecoupling,
  computeBaseline,
  computeRollingTrend,
  classifyEffortTier,
  type LapRecord,
  type ActivityMetadata,
  type DecouplingInput,
  type DecouplingResult,
  type EffortTier,
  type HRZoneThresholds,
} from './decoupling';
import { resolveHRZones } from './hrZones';

// ── Module constants ──────────────────────────────────────────────────────────

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Minimum total ascent (metres) required before GAP-adjusted distances are used. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Minimum number of qualifying runs before the baseline is considered established. */
const BASELINE_MIN_RUNS = 20;

/** Lookback window (days) used when querying activity_decoupling for trend computation. */
const TREND_LOOKBACK_DAYS = 90;

/** Rolling window (days) used inside computeRollingTrend. */
const ROLLING_WINDOW_DAYS = 30;

// ── Return-type interfaces ────────────────────────────────────────────────────

export interface DecouplingRecalcResult {
  ok: boolean;
  skipped?: boolean;
  skip_reason?: string;
  effort_tier?: EffortTier;
  error?: string;
}

export interface BatchDecouplingResult {
  ok: boolean;
  processed: number;
  skipped: number;
  errors: number;
  error?: string;
}

export interface BaselineRecalcResult {
  ok: boolean;
  rows_upserted?: number;
  error?: string;
}

export interface TrendRecalcResult {
  ok: boolean;
  rows_upserted?: number;
  error?: string;
}

// ── DEC-003: Per-activity decoupling computation ──────────────────────────────

/**
 * Compute and persist aerobic decoupling for a single activity.
 *
 * Fetches activity metadata and lap records from Supabase, resolves HR zone
 * thresholds to classify the effort tier, calls computeDecoupling(), and
 * upserts the result into activity_decoupling.
 *
 * Skipped activities are always upserted so the row exists with skipped=true.
 */
export async function computeActivityDecoupling(
  activityId: string | number,
): Promise<DecouplingRecalcResult> {
  try {
    // Fetch activity metadata
    const { data: actRow, error: actErr } = await supabase
      .from('garmin_activities')
      .select(
        'activity_id, start_time, avg_hr, moving_time_seconds, distance, ascent, is_race, avg_pace_seconds',
      )
      .eq('activity_id', activityId)
      .maybeSingle();

    if (actErr) throw actErr;
    if (!actRow) {
      return { ok: false, error: `Activity ${activityId} not found` };
    }

    // Fetch lap records ordered by lap number
    const { data: lapRows, error: lapErr } = await supabase
      .from('garmin_activity_laps')
      .select(
        'lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr, ascent, descent',
      )
      .eq('activity_id', activityId)
      .order('lap', { ascending: true });

    if (lapErr) throw lapErr;

    const laps: LapRecord[] = (lapRows ?? []).map((r: any) => ({
      lap: r.lap,
      moving_time_seconds: r.moving_time_seconds,
      elapsed_time_seconds: r.elapsed_time_seconds,
      distance: r.distance,
      avg_hr: r.avg_hr,
      ascent: r.ascent,
      descent: r.descent,
    }));

    // Resolve effort tier
    const zones = await resolveHRZones();
    const thresholds: HRZoneThresholds = {
      hrz_3_min: zones[2].min,
      hrz_4_min: zones[3].min,
    };
    let effort_tier: EffortTier = 'moderate';
    if (actRow.avg_hr != null) {
      effort_tier = classifyEffortTier(actRow.avg_hr as number, thresholds);
    }

    // Build input and compute decoupling
    const activity: ActivityMetadata = {
      activity_id: String(actRow.activity_id),
      date: String(actRow.start_time).slice(0, 10),
      avg_hr: actRow.avg_hr,
      moving_time_seconds: actRow.moving_time_seconds,
      distance: actRow.distance,
      ascent: actRow.ascent,
      is_race: actRow.is_race === true,
      avg_pace_seconds: actRow.avg_pace_seconds,
    };

    const input: DecouplingInput = { activity, laps, effort_tier };
    const result: DecouplingResult = computeDecoupling(input);

    // Always upsert — even skipped activities get a row
    const upsertRow = {
      athlete_id: SINGLE_ATHLETE_ID,
      activity_id: String(actRow.activity_id),
      date: activity.date,
      effort_tier: result.effort_tier,
      ef_h1: result.ef_h1,
      ef_h2: result.ef_h2,
      decoupling_pct: result.decoupling_pct,
      ef_q1: result.ef_q1,
      ef_q2: result.ef_q2,
      ef_q3: result.ef_q3,
      ef_q4: result.ef_q4,
      decoupling_q1q4_pct: result.decoupling_q1q4_pct,
      decoupling_q1q2_pct: result.decoupling_q1q2_pct,
      gap_used: result.gap_used,
      awaiting_gap: result.awaiting_gap,
      hr_data_insufficient: result.hr_data_insufficient,
      laps_excluded_warmup: result.laps_excluded_warmup,
      laps_excluded_hr: result.laps_excluded_hr,
      qualifying_duration_s: result.qualifying_duration_s,
      skipped: result.skipped,
      skip_reason: result.skip_reason,
    };

    const { error: upsertErr } = await supabase
      .from('activity_decoupling')
      .upsert(upsertRow, { onConflict: 'activity_id' });

    if (upsertErr) throw upsertErr;

    return {
      ok: true,
      skipped: result.skipped,
      skip_reason: result.skip_reason ?? undefined,
      effort_tier: result.effort_tier,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── DEC-003: Batch entry-point ────────────────────────────────────────────────

/**
 * Process a list of activity IDs sequentially and recompute baselines / trends
 * for any effort tiers touched by successful non-skipped results.
 *
 * This is the DEC-006 sync pipeline entry-point: call it with the list of
 * newly synced activity IDs immediately after recalculateAllSports() completes.
 */
export async function computeActivityDecouplingBatch(
  activityIds: (string | number)[],
): Promise<BatchDecouplingResult> {
  if (activityIds.length === 0) {
    return { ok: true, processed: 0, skipped: 0, errors: 0 };
  }

  try {
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const affected_tiers = new Set<EffortTier>();

    for (const id of activityIds) {
      const result = await computeActivityDecoupling(id);

      if (!result.ok) {
        errors++;
        continue;
      }

      processed++;

      if (result.skipped) {
        skipped++;
      } else if (result.effort_tier) {
        affected_tiers.add(result.effort_tier);
      }
    }

    // Recompute baselines and trends for all affected tiers
    if (affected_tiers.size > 0) {
      const tiersArray = Array.from(affected_tiers);
      await recalculateDecouplingBaseline(tiersArray);
      await recalculateDecouplingTrend(tiersArray);
    }

    return { ok: true, processed, skipped, errors };
  } catch (e: any) {
    return { ok: false, processed: 0, skipped: 0, errors: 0, error: e?.message ?? 'Unknown error' };
  }
}

// ── DEC-004: Baseline recalculation ──────────────────────────────────────────

/**
 * Recompute the per-effort-tier decoupling baseline and upsert into
 * decoupling_baseline. If the baseline is established and the most recent
 * qualifying run falls outside the ±2σ bounds, inserts an athlete_notification.
 *
 * @param tiers  Effort tiers to process. Defaults to all three tiers.
 */
export async function recalculateDecouplingBaseline(
  tiers: EffortTier[] = ['easy', 'moderate', 'hard'],
): Promise<BaselineRecalcResult> {
  try {
    let rows_upserted = 0;

    for (const tier of tiers) {
      // Fetch all qualifying decoupling values for this tier (ascending by date)
      const { data: rows, error: fetchErr } = await supabase
        .from('activity_decoupling')
        .select('date, decoupling_pct')
        .eq('athlete_id', SINGLE_ATHLETE_ID)
        .eq('effort_tier', tier)
        .not('decoupling_pct', 'is', null)
        .order('date', { ascending: true });

      if (fetchErr) throw fetchErr;

      const values: number[] = (rows ?? []).map((r: any) => r.decoupling_pct as number);
      const baseline = computeBaseline(values);

      // Upsert baseline row
      const { error: upsertErr } = await supabase
        .from('decoupling_baseline')
        .upsert(
          {
            athlete_id: SINGLE_ATHLETE_ID,
            effort_tier: tier,
            n_qualifying_runs: baseline.n_qualifying_runs,
            mean_decoupling_pct: baseline.mean_decoupling_pct,
            stdev_decoupling_pct: baseline.stdev_decoupling_pct,
            lower_bound: baseline.lower_bound,
            upper_bound: baseline.upper_bound,
            is_established: baseline.is_established,
          },
          { onConflict: 'athlete_id,effort_tier' },
        );

      if (upsertErr) throw upsertErr;
      rows_upserted++;

      // Anomaly notification: only when baseline is established and rows exist
      if (baseline.is_established && (rows ?? []).length > 0) {
        const mostRecent = (rows as Array<{ date: string; decoupling_pct: number }>)
          [(rows as any[]).length - 1];

        const isAnomaly =
          mostRecent.decoupling_pct < baseline.lower_bound ||
          mostRecent.decoupling_pct > baseline.upper_bound;

        if (isAnomaly) {
          const sigma2 = 2 * baseline.stdev_decoupling_pct;
          await supabase.from('athlete_notifications').insert({
            athlete_id: SINGLE_ATHLETE_ID,
            sport: 'running',
            type: 'decoupling_anomaly',
            message:
              `Unusual decoupling on ${mostRecent.date}: ` +
              `${mostRecent.decoupling_pct.toFixed(1)}% ` +
              `(${tier} tier baseline: ${baseline.mean_decoupling_pct.toFixed(1)}% +/- ${sigma2.toFixed(1)}%)`,
            is_read: false,
          });
        }
      }
    }

    return { ok: true, rows_upserted };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── DEC-005: Trend recalculation ──────────────────────────────────────────────

/**
 * Recompute the rolling 30-day decoupling trend for the past 90 days and
 * persist to decoupling_trend. Deletes the existing window before re-inserting
 * to keep the table in sync with the latest activity data.
 *
 * @param tiers  Effort tiers to process. Defaults to all three tiers.
 */
export async function recalculateDecouplingTrend(
  tiers: EffortTier[] = ['easy', 'moderate', 'hard'],
): Promise<TrendRecalcResult> {
  try {
    // Compute lookback start date (UTC)
    const lookbackStart = new Date();
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - TREND_LOOKBACK_DAYS);
    const lookbackStartStr = lookbackStart.toISOString().slice(0, 10);

    // Single query: all qualifying decoupling rows within the lookback window
    const { data: allRows, error: fetchErr } = await supabase
      .from('activity_decoupling')
      .select('date, decoupling_pct, effort_tier')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .gte('date', lookbackStartStr)
      .not('decoupling_pct', 'is', null)
      .order('date', { ascending: true });

    if (fetchErr) throw fetchErr;

    const rowsData = (allRows ?? []) as Array<{
      date: string;
      decoupling_pct: number;
      effort_tier: string;
    }>;

    const BATCH_SIZE = 500;
    let totalRowsInserted = 0;

    for (const tier of tiers) {
      // Filter to this tier
      const tierRows = rowsData
        .filter((r) => r.effort_tier === tier)
        .map((r) => ({ date: r.date, decoupling_pct: r.decoupling_pct }));

      const trendEntries = computeRollingTrend(tierRows, TREND_LOOKBACK_DAYS);

      // Delete existing trend rows for this tier within the lookback window
      const { error: deleteErr } = await supabase
        .from('decoupling_trend')
        .delete()
        .eq('athlete_id', SINGLE_ATHLETE_ID)
        .eq('effort_tier', tier)
        .gte('date', lookbackStartStr);

      if (deleteErr) throw deleteErr;

      if (trendEntries.length === 0) continue;

      // Insert new rows in batches of 500
      const insertRows = trendEntries.map((entry) => ({
        athlete_id: SINGLE_ATHLETE_ID,
        effort_tier: tier,
        date: entry.date,
        rolling_30d_mean: entry.rolling_30d_mean,
        n_activities: entry.n_activities,
      }));

      for (let i = 0; i < insertRows.length; i += BATCH_SIZE) {
        const chunk = insertRows.slice(i, i + BATCH_SIZE);
        const { error: insertErr } = await supabase
          .from('decoupling_trend')
          .insert(chunk);
        if (insertErr) throw insertErr;
        totalRowsInserted += chunk.length;
      }
    }

    return { ok: true, rows_upserted: totalRowsInserted };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── DEC-007 stub (Section 6 dependency) ──────────────────────────────────────

/**
 * Backfill decoupling calculations using Grade Adjusted Pace (GAP) instead of
 * raw speed.
 *
 * Queries activity_decoupling for rows where awaiting_gap = true, checks
 * whether GAP data is available (from activity_gap and lap_gap), constructs
 * synthetic LapRecord objects with GAP-adjusted distance, and re-runs
 * computeDecoupling(). Updates activity_decoupling to set gap_used and
 * awaiting_gap = false.
 */
export async function backfillDecouplingWithGAP(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  try {
    // Step 1: Query all activity_decoupling rows where awaiting_gap = true
    const { data: pendingRows, error: fetchErr } = await supabase
      .from('activity_decoupling')
      .select('activity_id, effort_tier')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('awaiting_gap', true);

    if (fetchErr) throw fetchErr;
    if (!pendingRows || pendingRows.length === 0) {
      return { ok: true, count: 0 };
    }

    let count = 0;

    for (const pending of pendingRows) {
      const activityId = pending.activity_id as string;

      // Step 2: Fetch activity metadata from garmin_activities
      const { data: actRow, error: actErr } = await supabase
        .from('garmin_activities')
        .select('activity_id, start_time, avg_hr, moving_time_seconds, distance, ascent, is_race, avg_pace_seconds')
        .eq('activity_id', activityId)
        .maybeSingle();

      if (actErr) throw actErr;
      if (!actRow) continue;

      // Step 3: Fetch lap records from garmin_activity_laps (raw laps)
      const { data: lapRows, error: lapErr } = await supabase
        .from('garmin_activity_laps')
        .select('lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr, ascent, descent')
        .eq('activity_id', activityId)
        .order('lap', { ascending: true });

      if (lapErr) throw lapErr;

      const rawLaps: LapRecord[] = (lapRows ?? []).map((r: any) => ({
        lap: r.lap,
        moving_time_seconds: r.moving_time_seconds,
        elapsed_time_seconds: r.elapsed_time_seconds,
        distance: r.distance,
        avg_hr: r.avg_hr,
        ascent: r.ascent,
        descent: r.descent,
      }));

      // Step 4: Fetch activity_gap row to check threshold
      const { data: gapRow, error: gapRowErr } = await supabase
        .from('activity_gap')
        .select('gap_applied, total_ascent_m')
        .eq('activity_id', activityId)
        .maybeSingle();

      if (gapRowErr) throw gapRowErr;

      // Apply threshold: use GAP only when total_ascent > 100m AND gap_applied = true
      const useGap = (gapRow?.total_ascent_m ?? 0) > GAP_ASCENT_THRESHOLD_M
                  && gapRow?.gap_applied === true;

      let lapsForDecoupling: LapRecord[] = rawLaps;

      if (useGap) {
        // Step 5: Fetch lap_gap rows to get gap_pace_sec_per_km per lap
        const { data: lapGapRows, error: lapGapErr } = await supabase
          .from('lap_gap')
          .select('lap, gap_pace_sec_per_km')
          .eq('activity_id', activityId)
          .order('lap', { ascending: true });

        if (lapGapErr) throw lapGapErr;

        // Build lookup map: lap number → gap_pace_sec_per_km
        const gapPaceMap = new Map<number, number>(
          (lapGapRows ?? []).map((r: any) => [r.lap as number, r.gap_pace_sec_per_km as number]),
        );

        // Step 6: Construct synthetic LapRecord objects with GAP-adjusted distance
        // Formula: distance_m = (moving_time_seconds / gap_pace_sec_per_km) * 1000
        lapsForDecoupling = rawLaps.map((lap) => {
          const gapPace = gapPaceMap.get(lap.lap);
          if (
            gapPace == null ||
            gapPace <= 0 ||
            lap.moving_time_seconds == null ||
            lap.moving_time_seconds <= 0
          ) {
            return lap;
          }
          const gapDistance = Math.round(((lap.moving_time_seconds / gapPace) * 1000) * 100) / 100;
          return {
            ...lap,
            distance: gapDistance,
          };
        });
      }

      // Step 7: Re-run computeDecoupling() with the (possibly GAP-adjusted) laps
      const zones = await resolveHRZones();
      const thresholds: HRZoneThresholds = {
        hrz_3_min: zones[2].min,
        hrz_4_min: zones[3].min,
      };
      let effort_tier: EffortTier = (pending.effort_tier as EffortTier) ?? 'moderate';
      if (actRow.avg_hr != null) {
        effort_tier = classifyEffortTier(actRow.avg_hr as number, thresholds);
      }

      const activity: ActivityMetadata = {
        activity_id: String(actRow.activity_id),
        date: String(actRow.start_time).slice(0, 10),
        avg_hr: actRow.avg_hr,
        moving_time_seconds: actRow.moving_time_seconds,
        distance: actRow.distance,
        ascent: actRow.ascent,
        is_race: actRow.is_race === true,
        avg_pace_seconds: actRow.avg_pace_seconds,
      };

      const input: DecouplingInput = { activity, laps: lapsForDecoupling, effort_tier };
      const result: DecouplingResult = computeDecoupling(input);

      // Step 8: Upsert updated activity_decoupling row
      const upsertRow = {
        athlete_id: SINGLE_ATHLETE_ID,
        activity_id: String(actRow.activity_id),
        date: activity.date,
        effort_tier: result.effort_tier,
        ef_h1: result.ef_h1,
        ef_h2: result.ef_h2,
        decoupling_pct: result.decoupling_pct,
        ef_q1: result.ef_q1,
        ef_q2: result.ef_q2,
        ef_q3: result.ef_q3,
        ef_q4: result.ef_q4,
        decoupling_q1q4_pct: result.decoupling_q1q4_pct,
        decoupling_q1q2_pct: result.decoupling_q1q2_pct,
        gap_used: useGap,
        awaiting_gap: false,
        hr_data_insufficient: result.hr_data_insufficient,
        laps_excluded_warmup: result.laps_excluded_warmup,
        laps_excluded_hr: result.laps_excluded_hr,
        qualifying_duration_s: result.qualifying_duration_s,
        skipped: result.skipped,
        skip_reason: result.skip_reason,
      };

      const { error: upsertErr } = await supabase
        .from('activity_decoupling')
        .upsert(upsertRow, { onConflict: 'activity_id' });

      if (upsertErr) throw upsertErr;

      count++;
    }

    return { ok: true, count };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
