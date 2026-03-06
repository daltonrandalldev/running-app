/**
 * PMC recalculation job.
 *
 * Reads activity load scores from garmin_activities, calls calculatePMC,
 * and upserts the results into daily_pmc_values.
 *
 * Trigger: call recalculatePMC(earliestAffectedDate) after any new/edited
 * activity. Pass no argument to backfill from the earliest activity on record
 * (capped at MAX_BACKFILL_DAYS).
 */

import { supabase } from './supabase';
import { calculatePMC, type PMCParams } from './pmc';

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Maximum days to backfill on first import (4 years). */
const MAX_BACKFILL_DAYS = 365 * 4;

export interface RecalcResult {
  ok: boolean;
  rowsUpserted?: number;
  error?: string;
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

    // Fetch activities with an active_load from the cutoff date onward
    let query = supabase
      .from('garmin_activities')
      .select('start_time, active_load')
      .not('active_load', 'is', null)
      .gte('start_time', cutoff)
      .order('start_time', { ascending: true });

    // Sport filtering: 'combined' includes all sports, otherwise filter by type
    if (sport !== 'combined') {
      query = query.ilike('sport', `%${sport}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Map activities to PMC input format
    const activities = (data ?? []).map((row: { start_time: string; active_load: number }) => ({
      date: row.start_time.slice(0, 10),
      tss: row.active_load,
    }));

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
