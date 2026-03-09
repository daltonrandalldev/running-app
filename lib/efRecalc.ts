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
  type EFLapRecord,
} from './ef';
import { normalizeTempEF } from './envAdjust';
import { resolveHRZones, type HRZones } from './hrZones';

// ── Module constants ────────────────────────────────────────────────────────

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Batch size for upsert operations (matches gapRecalc.ts pattern). */
const BATCH_SIZE = 500;

/** Minimum total ascent (meters) for GAP to be considered applicable to EF. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Relative change threshold for the EF alert (5%). */
const EF_ALERT_THRESHOLD = 0.05;

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

    // Read personal heat sensitivity coefficient (default 0.02 if not yet fitted)
    const { data: paramsRow } = await supabase
      .from('athlete_parameters')
      .select('heat_sensitivity_k')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('sport', 'run')
      .maybeSingle();
    const heatK: number = paramsRow?.heat_sensitivity_k ?? 0.02;

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

        // 3f. Fetch weather data for this activity (if available)
        const { data: weatherRow } = await supabase
          .from('activity_weather')
          .select('temperature_celsius, humidity_pct, elevation_m')
          .eq('activity_id', String(actRow.activity_id))
          .maybeSingle();

        // 3g. Apply environmental normalization
        // Open-Meteo temperature takes precedence; device temp is fallback only.
        const tempForNorm = weatherRow?.temperature_celsius ?? actRow.avg_temperature ?? null;
        let tempAdjusted = false;
        let efTempAdjusted: number | null = null;

        if (tempForNorm !== null && efResult.efValue > 0) {
          const normResult = normalizeTempEF(
            efResult.efValue,
            tempForNorm,
            weatherRow?.humidity_pct ?? null,
            weatherRow?.elevation_m ?? null,
            heatK,
          );
          // Store efAltAdj: the fully-normalized EF (temperature + humidity + altitude combined).
          // ef_temp_adjusted is the column name inherited from the Section 7 stub, but semantically
          // it holds the complete environmental normalization. Always use efAltAdj here, not efTempAdj.
          efTempAdjusted = normResult.efAltAdj;
          tempAdjusted = true;
        }

        // 3h. Upsert to activity_ef
        const { error: upsertErr } = await supabase
          .from('activity_ef')
          .upsert(
            {
              athlete_id: SINGLE_ATHLETE_ID,
              activity_id: String(actRow.activity_id),
              date: String(actRow.start_time).slice(0, 10),
              sport: 'run',
              ef_value: efResult.efValue,
              gap_used: useGAP,
              qualifying: qualifyingResult.qualifying,
              disqualification_reason: qualifyingResult.reason ?? null,
              temp_c: actRow.avg_temperature ?? null,
              temp_adjusted: tempAdjusted,
              ef_temp_adjusted: efTempAdjusted,
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
 * Queries all activity_ef rows where temp_adjusted = false AND temp_c IS NOT NULL,
 * applies environmental normalization using normalizeTempEF() from envAdjust.ts,
 * and upserts ef_temp_adjusted and temp_adjusted = true.
 */
export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  try {
    // Read personal heat coefficient (default 0.02 if not yet fitted)
    const { data: paramsRow } = await supabase
      .from('athlete_parameters')
      .select('heat_sensitivity_k')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('sport', 'run')
      .maybeSingle();

    const heatK: number = paramsRow?.heat_sensitivity_k ?? 0.02;

    // Query activity_ef rows that need backfilling:
    // temp_adjusted = false AND temp_c IS NOT NULL
    const { data: efRows, error: efErr } = await supabase
      .from('activity_ef')
      .select('activity_id, ef_value, temp_c')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('temp_adjusted', false)
      .not('temp_c', 'is', null);

    if (efErr) throw efErr;

    const rows = efRows ?? [];
    if (rows.length === 0) return { ok: true, count: 0 };

    // Fetch all matching activity_weather rows in one query
    const activityIds = rows.map((r: any) => r.activity_id);
    const { data: weatherRows, error: weatherErr } = await supabase
      .from('activity_weather')
      .select('activity_id, temperature_celsius, humidity_pct, elevation_m')
      .in('activity_id', activityIds);

    if (weatherErr) throw weatherErr;

    // Build weather lookup map
    const weatherMap = new Map<string, {
      temperature_celsius: number | null;
      humidity_pct: number | null;
      elevation_m: number | null;
    }>();
    for (const w of weatherRows ?? []) {
      weatherMap.set(w.activity_id, w);
    }

    // Build update rows
    const updateRows: Array<{
      activity_id: string;
      ef_temp_adjusted: number;
      temp_adjusted: boolean;
    }> = [];

    for (const efRow of rows) {
      // Skip rows with null or zero ef_value (defensive guard)
      if (!efRow.ef_value || efRow.ef_value <= 0) continue;

      const weather = weatherMap.get(efRow.activity_id);
      const tempForNorm = weather?.temperature_celsius ?? efRow.temp_c;

      // tempForNorm cannot be null here (temp_c IS NOT NULL in query)
      if (tempForNorm === null) continue;

      const normResult = normalizeTempEF(
        efRow.ef_value,
        tempForNorm,
        weather?.humidity_pct ?? null,
        weather?.elevation_m ?? null,
        heatK,
      );

      // Use efAltAdj: the fully-normalized EF (temperature + humidity + altitude).
      // Consistent with recalculateEF step 3g — both paths must assign efAltAdj to ef_temp_adjusted.
      updateRows.push({
        activity_id: efRow.activity_id,
        ef_temp_adjusted: normResult.efAltAdj,
        temp_adjusted: true,
      });
    }

    // Upsert in batches of 500
    let count = 0;
    for (let i = 0; i < updateRows.length; i += BATCH_SIZE) {
      const chunk = updateRows.slice(i, i + BATCH_SIZE);
      const { error: upsertErr } = await supabase
        .from('activity_ef')
        .upsert(
          chunk.map((r) => ({
            athlete_id: SINGLE_ATHLETE_ID,
            activity_id: r.activity_id,
            ef_temp_adjusted: r.ef_temp_adjusted,
            temp_adjusted: r.temp_adjusted,
          })),
          { onConflict: 'athlete_id,activity_id' },
        );
      if (upsertErr) throw upsertErr;
      count += chunk.length;
    }

    return { ok: true, count };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
