/**
 * Monotony/Strain recalculation job.
 *
 * Reads activity load scores from garmin_activities, calls calculateMonotonyStrain,
 * and upserts the results into daily_monotony_strain.
 *
 * Trigger: call recalculateMonotony(earliestAffectedDate, sport) after any new/edited
 * activity. Pass no argument to backfill from the earliest activity on record
 * (capped at MAX_BACKFILL_DAYS).
 *
 * Pipeline pattern mirrors lib/pmcRecalc.ts exactly:
 *   - Same SINGLE_ATHLETE_ID placeholder
 *   - Same MAX_BACKFILL_DAYS cap
 *   - Same 500-row batch upsert
 *   - Same Promise.all parallel orchestration for multi-sport runs
 *
 * Only rows with non-null strain are upserted. Days 1–6 from the earliest
 * activity date produce strain: null and are filtered before upsert.
 */

import { supabase } from './supabase';
import {
  calculateMonotonyStrain,
  type MonotonyStrainDay,
} from './monotony';

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Maximum days to backfill on first import (4 years). */
const MAX_BACKFILL_DAYS = 365 * 4;

/** Batch size for upsert operations to avoid Supabase payload limits. */
const BATCH = 500;

// ── Exported interfaces ───────────────────────────────────────────────────────

export interface RecalcResult {
  ok: boolean;
  rowsUpserted?: number;
  error?: string;
}

export interface RecalcAllResult {
  run: RecalcResult;
  cycle: RecalcResult;
  combined: RecalcResult;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function earliestAllowedDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - MAX_BACKFILL_DAYS);
  return d.toISOString().slice(0, 10);
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Recalculate monotony and strain values and persist them to daily_monotony_strain.
 *
 * @param fromDate  ISO date (YYYY-MM-DD). Recalculate from this date onward.
 *                  Omit to recalculate from the earliest activity (capped at
 *                  MAX_BACKFILL_DAYS ago).
 * @param sport     Sport series to compute. If omitted, delegates to
 *                  recalculateAllMonotonySports(fromDate) and returns the
 *                  combined result.
 */
export async function recalculateMonotony(
  fromDate?: string,
  sport?: 'run' | 'cycle' | 'combined',
): Promise<RecalcResult> {
  // If no sport specified, run all three series and return the combined result
  if (sport === undefined) {
    const allResult = await recalculateAllMonotonySports(fromDate);
    return allResult.combined;
  }

  try {
    // 1. Determine cutoff date
    const cutoff = fromDate ?? earliestAllowedDate();

    // 2. Fetch activities from Supabase
    let query = supabase
      .from('garmin_activities')
      .select('start_time, active_load, sport')
      .not('active_load', 'is', null)
      .gte('start_time', cutoff)
      .order('start_time', { ascending: true });

    // Add sport filter for run and cycle; combined fetches all activities
    if (sport === 'run') {
      query = query.ilike('sport', '%run%');
    } else if (sport === 'cycle') {
      query = query.ilike('sport', '%cycl%');
    }

    const { data, error: fetchError } = await query;
    if (fetchError) throw fetchError;

    // 3. Map rows to the activity array
    const activities = (data ?? []).map((row) => ({
      date: row.start_time.slice(0, 10),
      tss: row.active_load as number,
      sport: row.sport ?? '',
    }));

    // 4. Call the pure library
    const days = calculateMonotonyStrain(activities, sport);

    // 5. Filter to non-null strain rows only (days 1–6 have strain: null)
    const rows = days.filter((d): d is MonotonyStrainDay & { strain: number } =>
      d.strain !== null,
    );

    // 6. Return early if no rows to upsert
    if (rows.length === 0) return { ok: true, rowsUpserted: 0 };

    // 7. Batch upsert in chunks of 500
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map((d) => ({
        athlete_id: SINGLE_ATHLETE_ID,
        date: d.date,
        sport,
        monotony: d.monotony,
        strain: d.strain,
      }));
      const { error } = await supabase
        .from('daily_monotony_strain')
        .upsert(chunk, { onConflict: 'athlete_id,date,sport' });
      if (error) throw error;
    }

    // 8. Return success
    return { ok: true, rowsUpserted: rows.length };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}

/**
 * Recalculate all three monotony/strain sport series ('run', 'cycle', 'combined')
 * in parallel.
 *
 * Results are written to daily_monotony_strain with the respective sport label.
 * Mirrors recalculateAllSports() in lib/pmcRecalc.ts.
 *
 * @param fromDate  ISO date from which to recalculate. Omit for full backfill.
 */
export async function recalculateAllMonotonySports(
  fromDate?: string,
): Promise<RecalcAllResult> {
  const [run, cycle, combined] = await Promise.all([
    recalculateMonotony(fromDate, 'run'),
    recalculateMonotony(fromDate, 'cycle'),
    recalculateMonotony(fromDate, 'combined'),
  ]);
  return { run, cycle, combined };
}
