/**
 * PMC-004: Adaptive Parameter Fitting — DB orchestration layer.
 *
 * Wraps the pure fitting engine (pmcFitting.ts) with Supabase I/O:
 *   - Fetches activity history and benchmark efforts from DB
 *   - Calls fitDecayConstants()
 *   - Upserts results to athlete_parameters
 *   - Logs parameter changes to parameter_change_log
 *   - Triggers PMC recalculation with new params (R7)
 *   - Provides on-app-open check for monthly refit cadence (Option B)
 *
 * Trigger points:
 *   1. After benchmark save  → triggerRefitAsync() (fire-and-forget)
 *   2. On app open           → maybeRefitOnAppOpen() (if > 28 days since last fit)
 */

import { supabase } from './supabase.ts';
import { fitDecayConstants, type BenchmarkForFit, type FitDecayResult, type ClampEvent } from './pmcFitting.ts';
import { recalculatePMC } from './pmcRecalc.ts';
import type { PMCInput } from './pmc.ts';
import {
  generatePlainEnglish,
  computeCiWidth,
  buildRefitNotifications,
} from './pmcAuditUtils.ts';

export { getConfidenceLabel } from './pmcAuditUtils.ts';

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Maximum days of activity history to fetch for the optimizer. */
const MAX_BACKFILL_DAYS = 365 * 4;

/** Days between automatic refits (on-app-open cadence). */
const REFIT_INTERVAL_DAYS = 28;


// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchActivities(): Promise<PMCInput[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - MAX_BACKFILL_DAYS);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('garmin_activities')
    .select('start_time, active_load, is_race, k_race_applied')
    .not('active_load', 'is', null)
    .gte('start_time', cutoffISO)
    .order('start_time', { ascending: true });

  if (error) throw error;

  return (data ?? []).map(
    (row: {
      start_time: string;
      active_load: number;
      is_race: boolean | null;
      k_race_applied: number | null;
    }) => {
      const rawTss = row.active_load;
      const atl_tss =
        row.is_race && row.k_race_applied != null
          ? rawTss * row.k_race_applied
          : undefined;
      return { date: row.start_time.slice(0, 10), tss: rawTss, atl_tss };
    },
  );
}

async function fetchBenchmarks(
  athleteId: string,
  sport: string,
): Promise<BenchmarkForFit[]> {
  let query = supabase
    .from('benchmark_efforts')
    .select('date, performance_score')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true });

  if (sport !== 'combined') {
    query = query.eq('sport', sport);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map(
    (row: { date: string; performance_score: number }) => ({
      date: row.date,
      performance_score: row.performance_score,
    }),
  );
}

async function fetchCurrentParams(
  athleteId: string,
  sport: string,
): Promise<{ tc_fitness: number | null; tc_fatigue: number | null; fitted_at: string | null } | null> {
  const { data } = await supabase
    .from('athlete_parameters')
    .select('tc_fitness, tc_fatigue, fitted_at')
    .eq('athlete_id', athleteId)
    .eq('sport', sport)
    .maybeSingle();
  return data ?? null;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function upsertAthleteParameters(
  athleteId: string,
  sport: string,
  result: Extract<FitDecayResult, { tc_fitness: number }>,
  fittedAt: string,
): Promise<void> {
  const { error } = await supabase.from('athlete_parameters').upsert(
    {
      athlete_id: athleteId,
      sport,
      tc_fitness: result.tc_fitness,
      tc_fatigue: result.tc_fatigue,
      k1: result.k1,
      k2: result.k2,
      intercept: result.intercept,
      is_personalized: true,
      r_squared: result.r2,
      n_benchmarks: result.n_benchmarks,
      ci_tc_fitness_low: result.ci.tc_fitness_low,
      ci_tc_fitness_high: result.ci.tc_fitness_high,
      ci_tc_fatigue_low: result.ci.tc_fatigue_low,
      ci_tc_fatigue_high: result.ci.tc_fatigue_high,
      fitted_at: fittedAt,
    },
    { onConflict: 'athlete_id,sport' },
  );
  if (error) throw error;
}

async function logParameterChange(
  athleteId: string,
  sport: string,
  paramName: string,
  oldValue: number | null,
  newValue: number,
  changeSource: 'auto_fit' | 'clamped',
  result: Extract<FitDecayResult, { tc_fitness: number }>,
  clampEvent?: ClampEvent,
): Promise<string> {
  const wasClamped = changeSource === 'clamped';
  const rawValue = clampEvent?.raw_value;

  // ci_low/ci_high for this specific parameter
  const ciLow =
    paramName === 'tc_fitness'
      ? result.ci.tc_fitness_low
      : paramName === 'tc_fatigue'
        ? result.ci.tc_fatigue_low
        : null;
  const ciHigh =
    paramName === 'tc_fitness'
      ? result.ci.tc_fitness_high
      : paramName === 'tc_fatigue'
        ? result.ci.tc_fatigue_high
        : null;

  const plainEnglish = generatePlainEnglish(
    paramName,
    oldValue,
    newValue,
    wasClamped,
    rawValue,
  );

  const { error } = await supabase.from('parameter_change_log').insert({
    athlete_id: athleteId,
    sport,
    parameter_name: paramName,
    old_value: oldValue,
    new_value: newValue,
    change_source: changeSource,
    r_squared: result.r2,
    n_data_points: result.n_benchmarks,
    ci_low: ciLow,
    ci_high: ciHigh,
    plain_english: plainEnglish,
    was_clamped: wasClamped,
  });
  if (error) throw error;
  return plainEnglish;
}

// ── Notification writes (PMC-006 R2–R4) ──────────────────────────────────────

/**
 * Fire the 'personalization_available' notification the first time an athlete
 * becomes eligible for fitting. Checks the DB to ensure it fires only once.
 */
async function maybeWritePersonalizationNotification(
  athleteId: string,
  sport: string,
): Promise<void> {
  const { data } = await supabase
    .from('athlete_notifications')
    .select('id')
    .eq('athlete_id', athleteId)
    .eq('sport', sport)
    .eq('type', 'personalization_available')
    .limit(1);

  if (data && data.length > 0) return; // already sent

  const { error } = await supabase.from('athlete_notifications').insert({
    athlete_id: athleteId,
    sport,
    type: 'personalization_available',
    message:
      'You now have enough data to personalize your training model. Tap to enable.',
  });
  if (error) throw error;
}

/**
 * Write 'model_updated' (R3) and, when R² < 0.6, 'more_data_needed' (R4)
 * notifications after a successful refit.
 *
 * ci_width (tc_fitness_high − tc_fitness_low) is stored as raw data alongside
 * the derived confidence_label so thresholds can be tightened later without a
 * schema change.
 */
async function writeRefitNotifications(
  athleteId: string,
  sport: string,
  result: Extract<FitDecayResult, { tc_fitness: number }>,
  changedParamMessages: string[],
): Promise<void> {
  const ciWidth = result.ci.tc_fitness_high - result.ci.tc_fitness_low;
  const notifications = buildRefitNotifications(result.r2, ciWidth, changedParamMessages);

  for (const n of notifications) {
    const { error } = await supabase.from('athlete_notifications').insert({
      athlete_id: athleteId,
      sport,
      type: n.type,
      message: n.message,
      r_squared: result.r2,
      confidence_label: n.confidence_label,
      ci_width: n.ci_width,
    });
    if (error) throw error;
  }
}

// ── Notification queries (PMC-006 R2–R3) ─────────────────────────────────────

export interface AthleteNotification {
  id: string;
  sport: string;
  type: string;
  message: string;
  r_squared: number | null;
  confidence_label: string | null;
  /** Raw tc_fitness CI width (days). Use this to re-derive the label if thresholds change. */
  ci_width: number | null;
  is_read: boolean;
  created_at: string;
}

/** Return all unread notifications for an athlete, newest first. */
export async function getUnreadNotifications(
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<AthleteNotification[]> {
  const { data, error } = await supabase
    .from('athlete_notifications')
    .select('id, sport, type, message, r_squared, confidence_label, ci_width, is_read, created_at')
    .eq('athlete_id', athleteId)
    .eq('is_read', false)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as AthleteNotification[];
}

// ── Parameter history query (PMC-006 R5) ─────────────────────────────────────

export interface ParameterHistoryRow {
  id: string;
  sport: string;
  parameter_name: string;
  old_value: number | null;
  new_value: number;
  change_source: string | null;
  r_squared: number | null;
  n_data_points: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** Computed from ci_high − ci_low. Null when either bound is absent. */
  ci_width: number | null;
  plain_english: string;
  was_clamped: boolean;
  created_at: string;
}

/**
 * Return the full parameter change history for an athlete, newest first (R5).
 * Equivalent to: GET /athletes/:id/parameter-history
 */
export async function getParameterHistory(
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<ParameterHistoryRow[]> {
  const { data, error } = await supabase
    .from('parameter_change_log')
    .select(
      'id, sport, parameter_name, old_value, new_value, change_source, ' +
      'r_squared, n_data_points, ci_low, ci_high, plain_english, was_clamped, created_at',
    )
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    ...row,
    ci_width: computeCiWidth(row.ci_low, row.ci_high),
  })) as ParameterHistoryRow[];
}

// ── Current param_version for benchmark tagging ───────────────────────────────

/**
 * Returns a string representing the current parameter version.
 * Stored in benchmark_efforts.param_version when a benchmark is saved.
 * 'default' until the athlete has been personalized; thereafter the fitted_at
 * timestamp, which lets you join against parameter_change_log for full history.
 */
export async function getCurrentParamVersion(
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<string> {
  const { data } = await supabase
    .from('athlete_parameters')
    .select('fitted_at, is_personalized')
    .eq('athlete_id', athleteId)
    .eq('sport', 'combined')
    .maybeSingle();

  if (data?.is_personalized && data?.fitted_at) {
    return data.fitted_at as string;
  }
  return 'default';
}

// ── Core fitting orchestration ────────────────────────────────────────────────

export interface RunFittingResult {
  ok: boolean;
  result?: FitDecayResult;
  error?: string;
}

/**
 * Full fitting pipeline for one athlete/sport:
 *   1. Fetch activity history and benchmarks from DB
 *   2. Run fitDecayConstants (pure)
 *   3. Upsert athlete_parameters
 *   4. Log changed parameters to parameter_change_log
 *   5. Trigger PMC recalculation from earliest benchmark date (R7)
 */
export async function runFitting(
  athleteId: string = SINGLE_ATHLETE_ID,
  sport: string = 'combined',
): Promise<RunFittingResult> {
  try {
    const [activities, benchmarks, prevParams] = await Promise.all([
      fetchActivities(),
      fetchBenchmarks(athleteId, sport),
      fetchCurrentParams(athleteId, sport),
    ]);

    const result = fitDecayConstants(activities, benchmarks);

    if (!result.eligible) {
      return { ok: true, result };
    }

    const fittedAt = new Date().toISOString();
    await upsertAthleteParameters(athleteId, sport, result, fittedAt);

    // Log tc_fitness / tc_fatigue changes; collect plain-English strings for notifications
    const prevTcf = prevParams?.tc_fitness ?? null;
    const prevTca = prevParams?.tc_fatigue ?? null;

    // Determine which params were clamped (for accurate change_source)
    const clampedParams = new Set(
      result.clamp_events.map((e) => e.parameter),
    );

    const changedParamMessages: string[] = [];

    const tcfChanged = prevTcf === null || Math.abs(result.tc_fitness - prevTcf) > 0.05;
    if (tcfChanged) {
      const clampEvent = result.clamp_events.find(
        (e) => e.parameter === 'tc_fitness',
      );
      const msg = await logParameterChange(
        athleteId,
        sport,
        'tc_fitness',
        prevTcf,
        result.tc_fitness,
        clampedParams.has('tc_fitness') ? 'clamped' : 'auto_fit',
        result,
        clampEvent,
      );
      changedParamMessages.push(msg);
    }

    const tcaChanged = prevTca === null || Math.abs(result.tc_fatigue - prevTca) > 0.05;
    if (tcaChanged) {
      const clampEvent = result.clamp_events.find(
        (e) => e.parameter === 'tc_fatigue',
      );
      const msg = await logParameterChange(
        athleteId,
        sport,
        'tc_fatigue',
        prevTca,
        result.tc_fatigue,
        clampedParams.has('tc_fatigue') ? 'clamped' : 'auto_fit',
        result,
        clampEvent,
      );
      changedParamMessages.push(msg);
    }

    // PMC-006: notifications — R2 (show-once eligibility) then R3/R4 (post-refit)
    await maybeWritePersonalizationNotification(athleteId, sport);
    await writeRefitNotifications(athleteId, sport, result, changedParamMessages);

    // R7: Recalculate PMC from earliest benchmark date using new params
    if (benchmarks.length > 0) {
      const sortedDates = benchmarks.map((b) => b.date).sort();
      const earliestDate = sortedDates[0];
      await recalculatePMC(earliestDate, sport, {
        tc_fitness: result.tc_fitness,
        tc_fatigue: result.tc_fatigue,
      });
    }

    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

// ── PMC-007: Chart data types ─────────────────────────────────────────────────

export interface PMCDataRow {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
  tc_fitness_used: number;
  tc_fatigue_used: number;
}

export interface AthleteParams {
  tc_fitness: number;
  tc_fatigue: number;
  r_squared: number | null;
  is_personalized: boolean;
  n_benchmarks: number | null;
  ci_tc_fitness_low: number | null;
  ci_tc_fitness_high: number | null;
  ci_tc_fatigue_low: number | null;
  ci_tc_fatigue_high: number | null;
  fitted_at: string | null;
}

export interface BenchmarkMarker {
  date: string;
  performance_score: number;
  sport: string;
}

export interface RaceMarker {
  date: string;
  k_race_applied: number;
  moving_time_seconds: number | null;
}

// ── PMC-007: Chart data queries ───────────────────────────────────────────────

/**
 * Fetch the most recent `days` days of PMC data for a sport from daily_pmc_values.
 */
export async function fetchPMCData(
  sport: string = 'combined',
  days: number = 120,
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<PMCDataRow[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('daily_pmc_values')
    .select('date, ctl, atl, tsb, tc_fitness_used, tc_fatigue_used')
    .eq('athlete_id', athleteId)
    .eq('sport', sport)
    .gte('date', cutoffDate)
    .order('date', { ascending: true });

  if (error) throw error;
  return (data ?? []) as PMCDataRow[];
}

/**
 * Fetch athlete model parameters for a sport.
 * Returns 42/7 defaults when no personalized row exists yet.
 */
export async function fetchAthleteParams(
  sport: string = 'combined',
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<AthleteParams> {
  const { data } = await supabase
    .from('athlete_parameters')
    .select(
      'tc_fitness, tc_fatigue, r_squared, is_personalized, n_benchmarks, ' +
        'ci_tc_fitness_low, ci_tc_fitness_high, ci_tc_fatigue_low, ci_tc_fatigue_high, fitted_at',
    )
    .eq('athlete_id', athleteId)
    .eq('sport', sport)
    .maybeSingle();

  if (!data) {
    return {
      tc_fitness: 42,
      tc_fatigue: 7,
      r_squared: null,
      is_personalized: false,
      n_benchmarks: null,
      ci_tc_fitness_low: null,
      ci_tc_fitness_high: null,
      ci_tc_fatigue_low: null,
      ci_tc_fatigue_high: null,
      fitted_at: null,
    };
  }
  return data as unknown as AthleteParams;
}

/**
 * Fetch benchmark effort dates/scores for chart overlay markers.
 * When sport = 'combined', returns benchmarks for all sports.
 */
export async function fetchBenchmarkMarkers(
  sport: string = 'combined',
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<BenchmarkMarker[]> {
  let query = supabase
    .from('benchmark_efforts')
    .select('date, performance_score, sport')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true });

  if (sport !== 'combined') {
    query = query.eq('sport', sport);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as BenchmarkMarker[];
}

/** Fetch race activities for chart overlay markers (is_race = true). */
export async function fetchRaceMarkers(): Promise<RaceMarker[]> {
  const { data, error } = await supabase
    .from('garmin_activities')
    .select('start_time, k_race_applied, moving_time_seconds')
    .eq('is_race', true)
    .not('k_race_applied', 'is', null)
    .order('start_time', { ascending: true });

  if (error) throw error;

  return (data ?? []).map(
    (row: {
      start_time: string;
      k_race_applied: number;
      moving_time_seconds: number | null;
    }) => ({
      date: row.start_time.slice(0, 10),
      k_race_applied: row.k_race_applied,
      moving_time_seconds: row.moving_time_seconds,
    }),
  );
}

/**
 * Fetch raw activity TSS for CI confidence band computation.
 * Returns up to MAX_BACKFILL_DAYS of activity history.
 */
export async function fetchRawActivitiesForCI(): Promise<PMCInput[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - MAX_BACKFILL_DAYS);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('garmin_activities')
    .select('start_time, active_load, is_race, k_race_applied')
    .not('active_load', 'is', null)
    .gte('start_time', cutoffISO)
    .order('start_time', { ascending: true });

  if (error) throw error;

  return (data ?? []).map(
    (row: {
      start_time: string;
      active_load: number;
      is_race: boolean | null;
      k_race_applied: number | null;
    }) => {
      const rawTss = row.active_load;
      const atl_tss =
        row.is_race && row.k_race_applied != null
          ? rawTss * row.k_race_applied
          : undefined;
      return { date: row.start_time.slice(0, 10), tss: rawTss, atl_tss };
    },
  );
}

/**
 * Apply a manual parameter override to athlete_parameters and log it.
 * Marks change_source = 'user_override' in the audit log.
 * Triggers PMC recalculation with the new time constants.
 */
export async function upsertManualParams(
  tcFitness: number,
  tcFatigue: number,
  sport: string = 'combined',
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const prev = await fetchCurrentParams(athleteId, sport);
    const fittedAt = new Date().toISOString();

    const { error: upsertErr } = await supabase.from('athlete_parameters').upsert(
      {
        athlete_id: athleteId,
        sport,
        tc_fitness: tcFitness,
        tc_fatigue: tcFatigue,
        is_personalized: true,
        fitted_at: fittedAt,
      },
      { onConflict: 'athlete_id,sport' },
    );
    if (upsertErr) throw upsertErr;

    // Audit log entries for changed params
    const pairs: Array<['tc_fitness' | 'tc_fatigue', number, number | null]> = [
      ['tc_fitness', tcFitness, prev?.tc_fitness ?? null],
      ['tc_fatigue', tcFatigue, prev?.tc_fatigue ?? null],
    ];
    for (const [param, newVal, oldVal] of pairs) {
      if (oldVal === null || Math.abs(newVal - oldVal) > 0.001) {
        const plainEnglish = generatePlainEnglish(param, oldVal, newVal, false);
        await supabase.from('parameter_change_log').insert({
          athlete_id: athleteId,
          sport,
          parameter_name: param,
          old_value: oldVal,
          new_value: newVal,
          change_source: 'user_override',
          plain_english: plainEnglish,
          was_clamped: false,
        });
      }
    }

    // Recalculate PMC with new params
    await recalculatePMC(undefined, sport, { tc_fitness: tcFitness, tc_fatigue: tcFatigue });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

/** Mark a single notification as read. */
export async function markNotificationRead(notificationId: string): Promise<void> {
  await supabase
    .from('athlete_notifications')
    .update({ is_read: true })
    .eq('id', notificationId);
}

/**
 * Fire-and-forget refit trigger.
 * Called after saveBenchmarkEffort — never throws, never blocks the caller.
 * Shows "Updating your model..." state in UI while in flight (PMC-007).
 */
export function triggerRefitAsync(
  athleteId: string = SINGLE_ATHLETE_ID,
  sport: string = 'combined',
): void {
  runFitting(athleteId, sport).catch((e) => {
    console.warn('[PMC-004] Background refit failed:', e?.message ?? e);
  });
}

/**
 * On-app-open monthly refit check (Gap 1 — Option B).
 *
 * Checks all three sport series ('run', 'cycle', 'combined') independently.
 * Triggers a refit for any sport that has never been fitted or whose last fit
 * was more than REFIT_INTERVAL_DAYS ago. Each sport's staleness is evaluated
 * in parallel — a stale 'run' refit never blocks or skips 'cycle'.
 *
 * Does not block the UI — await this in a useEffect with no loading state.
 */
export async function maybeRefitOnAppOpen(
  athleteId: string = SINGLE_ATHLETE_ID,
): Promise<void> {
  try {
    const [runParams, cycleParams, combinedParams] = await Promise.all([
      fetchCurrentParams(athleteId, 'run'),
      fetchCurrentParams(athleteId, 'cycle'),
      fetchCurrentParams(athleteId, 'combined'),
    ]);

    const checks = [
      { sport: 'run', params: runParams },
      { sport: 'cycle', params: cycleParams },
      { sport: 'combined', params: combinedParams },
    ] as const;

    for (const { sport, params } of checks) {
      if (!params?.fitted_at) {
        // Never been fitted — try now (will no-op if not yet eligible)
        triggerRefitAsync(athleteId, sport);
        continue;
      }

      const lastFit = new Date(params.fitted_at);
      const daysSince =
        (Date.now() - lastFit.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince >= REFIT_INTERVAL_DAYS) {
        triggerRefitAsync(athleteId, sport);
      }
    }
  } catch {
    // Best-effort — silently skip if DB unavailable
  }
}
