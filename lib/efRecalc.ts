/**
 * EF-003: Supabase I/O Pipeline for Efficiency Factor (EF)
 *
 * Resolves HR zones, fetches run activities and lap records, computes EF per
 * activity using functions from lib/ef.ts, upserts results to activity_ef and
 * daily_ef_trend, and checks the 5% alert condition.
 *
 * Pattern follows gapRecalc.ts: singleton Supabase client, try/catch on every
 * exported async function, sequential (no Promise.all) batch processing.
 */

import { supabase } from './supabase';
import {
  calculateEFFromLaps,
  isQualifyingRun,
  computeRollingEFAvg,
  computeEFRegression,
  detectEFAlert,
  normalizeTempEF,
  type EFLapRecord,
} from './ef';
import { loadHRZones, type HRZones } from './hrZones';

// ── Module constants ────────────────────────────────────────────────────────

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Batch size for upsert operations (matches gapRecalc.ts pattern). */
const BATCH_SIZE = 500;

/** Minimum total ascent (meters) for GAP to be considered applicable to EF. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Relative change threshold for the EF alert (5%). */
const EF_ALERT_THRESHOLD = 0.05;

// ── Local stub for resolveHRZones (EF-004 will supply the real implementation)
// TODO (EF-004): replace this stub with the real resolveHRZones() from hrZones.ts
// once EF-004 is complete. Import it as:
//   import { resolveHRZones } from './hrZones';
// and remove this local implementation.

/** Default HR zones used when no athlete-specific zones are stored. */
const DEFAULT_HR_ZONES: HRZones = [
  { min: 100, max: 140 }, // Z1
  { min: 141, max: 160 }, // Z2
  { min: 161, max: 175 }, // Z3
  { min: 176, max: 188 }, // Z4
  { min: 189, max: 220 }, // Z5
];

/**
 * Resolve HR zones for the athlete.
 * Reads from AsyncStorage via loadHRZones(); falls back to DEFAULT_HR_ZONES.
 *
 * TODO (EF-004): this stub will be replaced by the real resolveHRZones()
 * exported from lib/hrZones.ts once that ticket ships.
 */
async function resolveHRZones(): Promise<HRZones> {
  const stored = await loadHRZones();
  return stored ?? DEFAULT_HR_ZONES;
}

// ── Return-type interfaces ───────────────────────────────────────────────────

export interface EFRecalcResult {
  ok: boolean;
  activitiesProcessed?: number;
  activitiesSkipped?: number;
  errors?: number;
  trendRowsUpserted?: number;
  alertTriggered?: boolean;
  error?: string;
}

// ── recalculateEF ────────────────────────────────────────────────────────────

/**
 * Compute and persist Efficiency Factor for all qualifying run activities.
 *
 * 1. Resolves HR zones once.
 * 2. Fetches run activities from garmin_activities.
 * 3. Per-activity (sequential): fetches laps, merges GAP pace, calls EF
 *    calculation, upserts to activity_ef.
 * 4. Computes rolling 30d / 90d EF averages over all qualifying rows.
 * 5. Computes OLS linear regression for the full qualifying history.
 * 6. Upserts daily_ef_trend (batched).
 * 7. Checks 5% alert condition and inserts a notification if triggered.
 */
export async function recalculateEF(fromDate?: string): Promise<EFRecalcResult> {
  try {
    // ── Step 1: Resolve HR zones ────────────────────────────────────────────
    const zones = await resolveHRZones();

    // ── Step 2: Fetch run activities ────────────────────────────────────────
    let activitiesQuery = supabase
      .from('garmin_activities')
      .select('activity_id, start_time, moving_time_seconds, avg_hr, avg_temperature, ascent')
      .ilike('sport', '%run%');

    if (fromDate) {
      activitiesQuery = activitiesQuery.gte('start_time', fromDate);
    }

    const { data: activities, error: activitiesErr } = await activitiesQuery;
    if (activitiesErr) throw activitiesErr;

    const actRows = activities ?? [];

    // ── Step 3: Per-activity EF computation (sequential) ───────────────────
    let activitiesProcessed = 0;
    let activitiesSkipped = 0;
    let errors = 0;

    for (const actRow of actRows) {
      try {
        // 3a. Fetch laps
        const { data: lapRows, error: lapErr } = await supabase
          .from('garmin_activity_laps')
          .select('lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr')
          .eq('activity_id', actRow.activity_id)
          .order('lap', { ascending: true });

        if (lapErr) throw lapErr;

        // 3b. Fetch GAP data
        const { data: lapGapRows, error: lapGapErr } = await supabase
          .from('lap_gap')
          .select('lap, gap_pace_sec_per_km')
          .eq('activity_id', actRow.activity_id);

        if (lapGapErr) throw lapGapErr;

        const { data: activityGapRow, error: activityGapErr } = await supabase
          .from('activity_gap')
          .select('gap_applied, total_ascent_m')
          .eq('activity_id', actRow.activity_id)
          .maybeSingle();

        if (activityGapErr) throw activityGapErr;

        // 3c. GAP fallback decision (activity-level)
        const useGAP =
          activityGapRow !== null &&
          activityGapRow.gap_applied === true &&
          (activityGapRow.total_ascent_m ?? 0) > GAP_ASCENT_THRESHOLD_M;

        // Build lap_gap lookup by lap number
        const lapGapMap = new Map<number, number | null>();
        for (const lg of lapGapRows ?? []) {
          lapGapMap.set(lg.lap, lg.gap_pace_sec_per_km ?? null);
        }

        // Build EFLapRecord[]
        const laps: EFLapRecord[] = (lapRows ?? []).map((r: any) => ({
          lap: r.lap,
          moving_time_seconds: r.moving_time_seconds,
          elapsed_time_seconds: r.elapsed_time_seconds,
          distance: r.distance,
          avg_hr: r.avg_hr,
          gap_pace_sec_per_km: useGAP
            ? (lapGapMap.has(r.lap) ? lapGapMap.get(r.lap) ?? null : null)
            : null,
        }));

        // 3d. Calculate EF from laps
        const efResult = calculateEFFromLaps(laps);
        if (efResult === null) {
          activitiesSkipped++;
          console.log(
            `[efRecalc] Skipped activity ${actRow.activity_id}: calculateEFFromLaps returned null`,
          );
          continue;
        }

        // 3e. Determine qualifying run
        const qualifyingResult = isQualifyingRun({
          movingTimeSec: actRow.moving_time_seconds ?? 0,
          avgHR: actRow.avg_hr ?? 0,
          zones,
          avgTempC: actRow.avg_temperature ?? null,
        });

        // 3f. Temperature normalization — stub; store temp_adjusted = false and
        //     ef_temp_adjusted = null (do not persist the stub's return value).
        void normalizeTempEF(efResult.efValue, actRow.avg_temperature ?? 15);

        // 3g. Upsert to activity_ef
        const { error: upsertErr } = await supabase
          .from('activity_ef')
          .upsert(
            {
              athlete_id: SINGLE_ATHLETE_ID,
              activity_id: String(actRow.activity_id),
              date: String(actRow.start_time).slice(0, 10),
              sport: 'run',
              ef_value: efResult.efValue,
              gap_used: efResult.gapUsed,
              qualifying: qualifyingResult.qualifying,
              disqualification_reason: qualifyingResult.reason ?? null,
              temp_c: actRow.avg_temperature ?? null,
              temp_adjusted: false,
              ef_temp_adjusted: null,
            },
            { onConflict: 'athlete_id,activity_id' },
          );

        if (upsertErr) throw upsertErr;

        activitiesProcessed++;
      } catch (activityErr: any) {
        console.error(
          `[efRecalc] Error processing activity ${actRow.activity_id}:`,
          activityErr?.message,
        );
        errors++;
      }
    }

    // ── Step 4: Compute rolling averages ────────────────────────────────────
    const { data: qualifyingRows, error: qualifyingErr } = await supabase
      .from('activity_ef')
      .select('date, ef_value')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('qualifying', true)
      .order('date', { ascending: true });

    if (qualifyingErr) throw qualifyingErr;

    const allQualifyingEntries: Array<{ date: string; efValue: number }> = (
      qualifyingRows ?? []
    ).map((r: any) => ({ date: r.date, efValue: r.ef_value }));

    if (allQualifyingEntries.length === 0) {
      return {
        ok: true,
        activitiesProcessed,
        activitiesSkipped,
        errors,
        trendRowsUpserted: 0,
        alertTriggered: false,
      };
    }

    // Enumerate every calendar date from earliest qualifying date to today
    const today = new Date().toISOString().slice(0, 10);
    const earliestDate = allQualifyingEntries[0].date;

    const dateRange: string[] = [];
    const cursor = new Date(earliestDate);
    const end = new Date(today);
    while (cursor <= end) {
      dateRange.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }

    // ── Step 5: Compute linear regression ───────────────────────────────────
    const regressionResult = computeEFRegression(allQualifyingEntries);

    // ── Step 6: Build and upsert daily_ef_trend rows (batched) ──────────────
    interface TrendRow {
      athlete_id: string;
      date: string;
      rolling_30d_ef: number | null;
      rolling_90d_ef: number | null;
      ef_slope: number | null;
      ef_slope_r2: number | null;
      n_qualifying_30d: number;
      n_qualifying_90d: number;
    }

    const trendRows: TrendRow[] = dateRange.map((dateStr) => {
      const rolling30 = computeRollingEFAvg(allQualifyingEntries, 30, dateStr);
      const rolling90 = computeRollingEFAvg(allQualifyingEntries, 90, dateStr);

      // Count qualifying entries in each window
      const refMs = new Date(dateStr).getTime();
      const window30StartMs = refMs - 29 * 24 * 60 * 60 * 1000;
      const window90StartMs = refMs - 89 * 24 * 60 * 60 * 1000;
      const window30Start = new Date(window30StartMs).toISOString().slice(0, 10);
      const window90Start = new Date(window90StartMs).toISOString().slice(0, 10);

      const n30 = allQualifyingEntries.filter(
        (e) => e.date >= window30Start && e.date <= dateStr,
      ).length;
      const n90 = allQualifyingEntries.filter(
        (e) => e.date >= window90Start && e.date <= dateStr,
      ).length;

      return {
        athlete_id: SINGLE_ATHLETE_ID,
        date: dateStr,
        rolling_30d_ef: rolling30,
        rolling_90d_ef: rolling90,
        ef_slope: regressionResult?.slope ?? null,
        ef_slope_r2: regressionResult?.rSquared ?? null,
        n_qualifying_30d: n30,
        n_qualifying_90d: n90,
      };
    });

    let trendRowsUpserted = 0;
    for (let i = 0; i < trendRows.length; i += BATCH_SIZE) {
      const chunk = trendRows.slice(i, i + BATCH_SIZE);
      const { error: trendUpsertErr } = await supabase
        .from('daily_ef_trend')
        .upsert(chunk, { onConflict: 'athlete_id,date' });
      if (trendUpsertErr) throw trendUpsertErr;
      trendRowsUpserted += chunk.length;
    }

    // ── Step 7: Alert check ──────────────────────────────────────────────────
    // Find the most recent trend row that has both rolling averages non-null
    let alertTriggered = false;
    for (let i = trendRows.length - 1; i >= 0; i--) {
      const row = trendRows[i];
      if (row.rolling_30d_ef !== null && row.rolling_90d_ef !== null) {
        alertTriggered = detectEFAlert(
          row.rolling_30d_ef,
          row.rolling_90d_ef,
          EF_ALERT_THRESHOLD,
        );
        if (alertTriggered) {
          const avg30 = row.rolling_30d_ef;
          const avg90 = row.rolling_90d_ef;
          await supabase.from('athlete_notifications').insert({
            athlete_id: SINGLE_ATHLETE_ID,
            sport: 'running',
            type: 'ef_alert',
            message: `EF has changed by more than 5%: 30-day avg ${avg30.toFixed(4)} vs 90-day avg ${avg90.toFixed(4)}`,
            is_read: false,
          });
        }
        break;
      }
    }

    return {
      ok: true,
      activitiesProcessed,
      activitiesSkipped,
      errors,
      trendRowsUpserted,
      alertTriggered,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── backfillEFWithTempAdjustment ─────────────────────────────────────────────

/**
 * Backfill EF temperature adjustment across all activity_ef rows.
 *
 * When Section 21 delivers the normalization model:
 *   1. Query all activity_ef rows where temp_adjusted = false AND temp_c IS NOT NULL
 *   2. Call normalizeTempEF(ef_value, temp_c) -- which will no longer be a stub
 *   3. Update ef_temp_adjusted and set temp_adjusted = true
 *
 * This function is a stub -- it is a no-op until Section 21 ships.
 * TODO (Section 21): implement body.
 */
export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  return { ok: true, count: 0 };
}
