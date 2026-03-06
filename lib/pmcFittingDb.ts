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

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Maximum days of activity history to fetch for the optimizer. */
const MAX_BACKFILL_DAYS = 365 * 4;

/** Days between automatic refits (on-app-open cadence). */
const REFIT_INTERVAL_DAYS = 28;

// ── Plain-English interpretation templates ────────────────────────────────────

/**
 * Generate a human-readable explanation for a parameter change.
 * Used to populate parameter_change_log.plain_english (PMC-006 R1).
 */
function generatePlainEnglish(
  paramName: string,
  oldValue: number | null,
  newValue: number,
  wasClamped: boolean,
  rawValue?: number,
): string {
  const prev = oldValue != null ? ` (previously ${Math.round(oldValue)} days)` : '';

  if (wasClamped && rawValue != null) {
    const bound = rawValue < newValue ? 'minimum' : 'maximum';
    return (
      `Your fitted ${paramName === 'tc_fitness' ? 'fitness decay' : 'fatigue decay'} ` +
      `(${rawValue.toFixed(1)} days) was outside the physiological ${bound}. ` +
      `Using ${newValue.toFixed(1)} days as the ${bound} bound.`
    );
  }

  if (paramName === 'tc_fitness') {
    const rel =
      newValue > 42
        ? 'more slowly than average'
        : newValue < 42
          ? 'faster than average'
          : 'at the typical rate';
    return (
      `Your aerobic fitness builds over approximately ${Math.round(newValue)} days${prev}. ` +
      `This means your body adapts ${rel} to training stimulus.`
    );
  }

  if (paramName === 'tc_fatigue') {
    const rel =
      newValue < 7
        ? 'faster-than-average acute fatigue recovery'
        : newValue > 7
          ? 'slower-than-average acute fatigue recovery'
          : 'typical acute fatigue recovery';
    return (
      `You recover from hard training in about ${Math.round(newValue)} days${prev}. ` +
      `This suggests you have ${rel}.`
    );
  }

  return `${paramName} updated to ${newValue.toFixed(2)}${prev}.`;
}

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
): Promise<void> {
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

    // Log tc_fitness change if it differs from previous value
    const prevTcf = prevParams?.tc_fitness ?? null;
    const prevTca = prevParams?.tc_fatigue ?? null;

    // Determine which params were clamped (for accurate change_source)
    const clampedParams = new Set(
      result.clamp_events.map((e) => e.parameter),
    );

    const tcfChanged = prevTcf === null || Math.abs(result.tc_fitness - prevTcf) > 0.05;
    if (tcfChanged) {
      const clampEvent = result.clamp_events.find(
        (e) => e.parameter === 'tc_fitness',
      );
      await logParameterChange(
        athleteId,
        sport,
        'tc_fitness',
        prevTcf,
        result.tc_fitness,
        clampedParams.has('tc_fitness') ? 'clamped' : 'auto_fit',
        result,
        clampEvent,
      );
    }

    const tcaChanged = prevTca === null || Math.abs(result.tc_fatigue - prevTca) > 0.05;
    if (tcaChanged) {
      const clampEvent = result.clamp_events.find(
        (e) => e.parameter === 'tc_fatigue',
      );
      await logParameterChange(
        athleteId,
        sport,
        'tc_fatigue',
        prevTca,
        result.tc_fatigue,
        clampedParams.has('tc_fatigue') ? 'clamped' : 'auto_fit',
        result,
        clampEvent,
      );
    }

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
