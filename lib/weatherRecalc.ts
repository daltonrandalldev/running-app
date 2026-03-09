/**
 * ENV-002: Weather recalculation pipeline
 *
 * Supabase I/O layer for fetching weather data, upserting to activity_weather,
 * and fitting the personal heat sensitivity coefficient.
 *
 * Pattern follows gapRecalc.ts and efRecalc.ts: singleton Supabase client,
 * try/catch on every exported async function, sequential (no Promise.all)
 * batch processing.
 */

import { supabase } from './supabase';
import { fetchActivityWeather } from './weatherApi';
import { fitHeatSensitivityK } from './envAdjust';
import { backfillEFWithTempAdjustment } from './efRecalc';

// ── Module constants ──────────────────────────────────────────────────────────

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Batch size for upsert operations (matches gapRecalc.ts / efRecalc.ts pattern). */
const BATCH_SIZE = 500;

// ── Return-type interfaces ────────────────────────────────────────────────────

export interface WeatherRecalcResult {
  ok: boolean;
  activitiesProcessed?: number;   // Activities with weather successfully fetched
  activitiesSkipped?: number;     // Indoor activities (null start_lat) or API failures
  errors?: number;
  error?: string;
}

// ── recalculateWeather ────────────────────────────────────────────────────────

/**
 * Fetch and persist weather conditions for all outdoor run activities.
 *
 * Skips activities where start_lat IS NULL (indoor activities).
 * On Open-Meteo API failure for any activity, stores null for all weather
 * fields (never falls back to device temperature). Continues processing
 * remaining activities.
 *
 * After all activities are processed, calls backfillEFWithTempAdjustment()
 * to apply normalization to all activity_ef rows with newly available weather
 * data.
 *
 * @param fromDate  ISO date (YYYY-MM-DD). Process activities on or after this
 *                  date. Omit to process all activities on record.
 */
export async function recalculateWeather(fromDate?: string): Promise<WeatherRecalcResult> {
  try {
    // ── Step 1: Fetch outdoor activities ─────────────────────────────────────
    let query = supabase
      .from('garmin_activities')
      .select('activity_id, start_lat, start_lng, start_time, moving_time_seconds')
      .not('start_lat', 'is', null)
      .not('start_lng', 'is', null)
      .ilike('sport', '%run%');

    if (fromDate) {
      query = query.gte('start_time', fromDate);
    }

    const { data: activities, error: activitiesErr } = await query;
    if (activitiesErr) throw activitiesErr;

    const actRows = activities ?? [];

    // ── Step 2: Per-activity weather fetch (sequential) ───────────────────────
    let activitiesProcessed = 0;
    let activitiesSkipped = 0;

    interface UpsertRow {
      activity_id: string;
      athlete_id: string;
      temperature_celsius: number | null;
      humidity_pct: number | null;
      wind_speed_kmh: number | null;
      wind_direction_deg: number | null;
      elevation_m: number | null;
      mid_run_temp_delta: number | null;
      used_segment_adjustment: boolean;
    }

    const upsertRows: UpsertRow[] = [];

    for (const actRow of actRows) {
      const weatherResult = await fetchActivityWeather(
        actRow.start_lat as number,
        actRow.start_lng as number,
        actRow.start_time as string,
        (actRow.moving_time_seconds as number) ?? 0,
      );

      if (weatherResult === null) {
        activitiesSkipped++;
      } else {
        activitiesProcessed++;
      }

      upsertRows.push({
        activity_id:             String(actRow.activity_id),
        athlete_id:              SINGLE_ATHLETE_ID,
        temperature_celsius:     weatherResult?.temperatureCelsius ?? null,
        humidity_pct:            weatherResult?.humidityPct ?? null,
        wind_speed_kmh:          weatherResult?.windSpeedKmh ?? null,
        wind_direction_deg:      weatherResult?.windDirectionDeg ?? null,
        elevation_m:             weatherResult?.elevationM ?? null,
        mid_run_temp_delta:      weatherResult?.midRunTempDelta ?? null,
        used_segment_adjustment: weatherResult?.usedSegmentAdjustment ?? false,
      });
    }

    // ── Step 3: Batch upsert to activity_weather ──────────────────────────────
    for (let i = 0; i < upsertRows.length; i += BATCH_SIZE) {
      const chunk = upsertRows.slice(i, i + BATCH_SIZE);
      const { error: upsertErr } = await supabase
        .from('activity_weather')
        .upsert(chunk, { onConflict: 'activity_id' });
      if (upsertErr) throw upsertErr;
    }

    // ── Step 4: Trigger EF backfill ───────────────────────────────────────────
    // backfillEFWithTempAdjustment is currently a stub (ENV-003 replaces it).
    await backfillEFWithTempAdjustment();

    return {
      ok: true,
      activitiesProcessed,
      activitiesSkipped,
      errors: 0,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── fitAndStoreHeatSensitivityK ───────────────────────────────────────────────

/**
 * Fit a personal heat sensitivity coefficient and store it in athlete_parameters.
 *
 * Reads all qualifying activity_ef rows that have a valid ef_value and temp_c,
 * calls fitHeatSensitivityK() from lib/envAdjust.ts, and upserts the result
 * to athlete_parameters with key 'heat_sensitivity_k'.
 *
 * Returns { ok: true, k: undefined } when insufficient data (< 30 outdoor runs
 * or < 15°C temperature range). Does not upsert in this case.
 *
 * Intended to be called quarterly (not on every sync). The caller is responsible
 * for determining the schedule.
 */
export async function fitAndStoreHeatSensitivityK(): Promise<{
  ok: boolean;
  k?: number;
  error?: string;
}> {
  try {
    // ── Step 1: Fetch qualifying EF rows with temperature ─────────────────────
    // No temp_c > 15 filter — cool-weather runs anchor the OLS regression.
    // fitHeatSensitivityK() enforces its own data-quality gate (n >= 30, range >= 15°C).
    const { data: rows, error } = await supabase
      .from('activity_ef')
      .select('ef_value, temp_c')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('qualifying', true)
      .not('ef_value', 'is', null)
      .not('temp_c', 'is', null);

    if (error) throw error;

    // ── Step 2: Fit coefficient ───────────────────────────────────────────────
    const k = fitHeatSensitivityK(
      (rows ?? []).map((r: any) => ({ efValue: r.ef_value, tempC: r.temp_c })),
    );

    if (k === null) return { ok: true, k: undefined };

    // ── Step 3: Upsert to athlete_parameters ─────────────────────────────────
    const { error: upsertErr } = await supabase
      .from('athlete_parameters')
      .upsert(
        { athlete_id: SINGLE_ATHLETE_ID, sport: 'run', heat_sensitivity_k: k },
        { onConflict: 'athlete_id,sport' },
      );

    if (upsertErr) throw upsertErr;

    return { ok: true, k };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
