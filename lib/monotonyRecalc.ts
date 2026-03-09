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

export interface AlertResult {
  ok: boolean;
  alertsEmitted?: number;
  error?: string;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function earliestAllowedDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - MAX_BACKFILL_DAYS);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── Alert message templates ───────────────────────────────────────────────────

const ALERT_MESSAGES = {
  High: (monotony: number, strain: number) =>
    `Training monotony is high (${monotony.toFixed(2)}) and strain (${Math.round(strain)}) exceeds your 90-day average by 50%. Consider adding an easy or rest day.`,
  Medium: (monotony: number) =>
    `Training monotony is approaching a high level (${monotony.toFixed(2)}). Varying session intensity can reduce overtraining risk.`,
};

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

/**
 * Check today's combined-series monotony/strain values and emit an alert to
 * athlete_notifications if thresholds are exceeded.
 *
 * Severity levels:
 *   - 'High':   monotony >= 2.0 AND strain > avg_90d_strain * 1.5
 *               AND >= 90 prior combined-series rows exist in daily_monotony_strain.
 *   - 'Medium': monotony >= 1.8 AND monotony < 2.0 (informational early warning;
 *               no strain threshold required).
 *   - No alert: monotony < 1.8 OR monotony IS NULL.
 *
 * @param asOfDate  ISO date (YYYY-MM-DD) to evaluate. Defaults to today.
 */
export async function checkAndEmitAlerts(
  asOfDate?: string,
): Promise<AlertResult> {
  // Per-sport (run/cycle) alerting is explicitly deferred — see docs/output/section-4-tech-design.md §10.5
  try {
    const targetDate = asOfDate ?? todayISO();

    // Step 1: Fetch today's combined-series row
    const { data: todayRow, error: fetchErr } = await supabase
      .from('daily_monotony_strain')
      .select('monotony, strain')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('date', targetDate)
      .eq('sport', 'combined')
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    // NULL monotony (stdev=0 or partial window) never triggers an alert
    if (!todayRow || todayRow.monotony === null) {
      return { ok: true, alertsEmitted: 0 };
    }

    const monotony: number = todayRow.monotony;
    const strain: number = todayRow.strain;

    // Step 2: Check monotony threshold — exit early if below minimum
    if (monotony < 1.8) {
      return { ok: true, alertsEmitted: 0 };
    }

    let severity: 'High' | 'Medium' | null = null;

    if (monotony >= 2.0) {
      // Step 3: High alert requires 90+ rows of prior combined strain history
      // "90 rows" = 90 rows in daily_monotony_strain where sport='combined'
      // NOT 90 calendar days. AVG() excludes NULLs automatically.
      const { data: historyRow, error: histErr } = await supabase
        .from('daily_monotony_strain')
        .select('strain')
        .eq('athlete_id', SINGLE_ATHLETE_ID)
        .eq('sport', 'combined')
        .gte('date', subtractDays(targetDate, 89))
        .lt('date', targetDate)
        .not('strain', 'is', null);

      if (histErr) throw histErr;

      const priorRows = historyRow ?? [];
      const dayCount = priorRows.length;

      if (dayCount >= 90) {
        const avgStrain90d =
          priorRows.reduce((sum: number, r: { strain: number }) => sum + r.strain, 0) / dayCount;
        const threshold = avgStrain90d * 1.5;

        if (strain > threshold) {
          severity = 'High';
        }
      }
      // If dayCount < 90: no High alert fires — insufficient history
    } else {
      // monotony in [1.8, 2.0): Medium warning, no strain threshold required
      severity = 'Medium';
    }

    if (severity === null) {
      return { ok: true, alertsEmitted: 0 };
    }

    // Step 4: Deduplication — skip if an alert of the same type was already
    // emitted for this athlete on this date
    const { data: existing, error: dedupErr } = await supabase
      .from('athlete_notifications')
      .select('id')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('type', 'high_monotony_strain')
      .eq('confidence_label', severity)
      .gte('created_at', targetDate + 'T00:00:00Z')
      .lt('created_at', targetDate + 'T23:59:59.999Z')
      .limit(1);

    if (dedupErr) throw dedupErr;
    if (existing && existing.length > 0) {
      return { ok: true, alertsEmitted: 0 }; // already emitted today
    }

    // Step 5: Insert notification
    const message =
      severity === 'High'
        ? ALERT_MESSAGES.High(monotony, strain)
        : ALERT_MESSAGES.Medium(monotony);

    const { error: insertErr } = await supabase
      .from('athlete_notifications')
      .insert({
        athlete_id: SINGLE_ATHLETE_ID,
        sport: 'combined',
        type: 'high_monotony_strain',
        message,
        confidence_label: severity,
        r_squared: null,
        ci_width: null,
      });

    if (insertErr) throw insertErr;

    return { ok: true, alertsEmitted: 1 };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
