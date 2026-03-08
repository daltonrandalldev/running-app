# Section 5 -- Aerobic Decoupling & Cardiac Drift: Technical Design Document

**Author:** Staff Engineer Lead
**Date:** 2026-03-07
**PRD Section:** 5 (Aerobic Decoupling & Cardiac Drift)
**Status:** Approved -- pending Staff Engineer 2 review

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [`lib/decoupling.ts` -- Pure Calculation Library](#2-libdecouplingts----pure-calculation-library)
3. [`lib/decouplingRecalc.ts` -- Supabase I/O Layer](#3-libdecouplingrecalcts----supabase-io-layer)
4. [`sql/activity_decoupling.sql` -- Migration](#4-sqlactivity_decouplingsql----migration)
5. [Effort Tier Classification](#5-effort-tier-classification)
6. [Baseline & Trend Computation](#6-baseline--trend-computation)
7. [Integration Points](#7-integration-points)
8. [Testing Strategy](#8-testing-strategy)
9. [Ticket Breakdown](#9-ticket-breakdown)
10. [Sign-off](#sign-off)

---

## 1. Architecture Overview

### Where It Fits

Aerobic decoupling follows the same two-layer pattern established by PMC:

| Layer | PMC | Decoupling |
|---|---|---|
| Pure calculation | `lib/pmc.ts` | `lib/decoupling.ts` |
| Supabase I/O | `lib/pmcRecalc.ts` | `lib/decouplingRecalc.ts` |
| SQL migration | `sql/daily_pmc_values.sql` | `sql/activity_decoupling.sql` |
| Storage tables | `daily_pmc_values` | `activity_decoupling`, `decoupling_baseline`, `decoupling_trend` |

The pure library (`lib/decoupling.ts`) has **zero imports** from Supabase, AsyncStorage, or React Native. It accepts typed input objects and returns typed output objects. All I/O (fetching laps, loading HR zones, upserting results) lives in the recalc layer (`lib/decouplingRecalc.ts`).

**Execution environment:** `lib/decouplingRecalc.ts` runs client-side in the React Native/Expo runtime, consistent with `lib/pmcRecalc.ts`. It reads HR zone configuration from AsyncStorage and calls Supabase directly using the anon key. There is no server-side component — this is the established project pattern.

### Data Flow

```
Garmin Sync (sync_server.py)
  |
  v
garmin_activities + garmin_activity_laps  (populated by sync)
  |
  v
recalculateAllSports()                   (existing PMC pipeline)
  |
  v
computeActivityDecoupling(activityId)    (NEW -- per-activity)
  |  reads: garmin_activity_laps, garmin_activities, HR zones
  |  writes: activity_decoupling (upsert)
  |
  v
recalculateDecouplingBaseline()          (NEW -- per-tier aggregate)
  |  reads: activity_decoupling
  |  writes: decoupling_baseline (upsert), athlete_notifications (insert)
  |
  v
recalculateDecouplingTrend()             (NEW -- rolling averages)
     reads: activity_decoupling
     writes: decoupling_trend (upsert)
```

### Dependencies

- **Upstream:** `garmin_activities` (activity metadata, `is_race` flag), `garmin_activity_laps` (lap-level data)
- **Sibling:** `lib/hrZones.ts` (`loadHRZones()`), `lib/lthr.ts` (`loadLTHR()`) -- for effort tier classification
- **Downstream:** `athlete_notifications` table (for anomaly alerts)
- **Future:** GAP (Grade Adjusted Pace) integration -- the design includes a stub interface (`awaiting_gap` flag, `gap_used` boolean) so DEC calculations can be rerun once GAP backfill is available

---

## 2. `lib/decoupling.ts` -- Pure Calculation Library

### 2.1 Type Definitions

```typescript
// ── Input Types ───────────────────────────────────────────────────────────────

/**
 * One lap record from garmin_activity_laps.
 * All fields match the database column names exactly.
 */
export interface LapRecord {
  /** 0-indexed lap number */
  lap: number;
  /** Lap moving time in seconds (null/0 = paused lap) */
  moving_time_seconds: number | null;
  /** Total elapsed time in seconds (including pauses) */
  elapsed_time_seconds: number | null;
  /** Lap distance in kilometers */
  distance: number | null;
  /** Average heart rate in bpm (null = no HR data) */
  avg_hr: number | null;
  /** Elevation gain in meters */
  ascent: number | null;
  /** Elevation loss in meters */
  descent: number | null;
}

/**
 * Activity-level metadata needed for decoupling computation.
 */
export interface ActivityMetadata {
  /** Garmin activity ID */
  activity_id: string;
  /** Activity date as ISO string (YYYY-MM-DD) */
  date: string;
  /** Overall average HR (fallback if laps insufficient) */
  avg_hr: number | null;
  /** Total moving time in seconds */
  moving_time_seconds: number | null;
  /** Total distance in km */
  distance: number | null;
  /** Total ascent in meters */
  ascent: number | null;
  /** Is this a race (from PMC-002 detection) */
  is_race: boolean;
  /** Seconds per km -- fallback if laps unavailable */
  avg_pace_seconds: number | null;
}

/**
 * Full input to the decoupling computation.
 */
export interface DecouplingInput {
  activity: ActivityMetadata;
  laps: LapRecord[];
  /** Effort tier for this activity (resolved by caller from HR zones) */
  effort_tier: EffortTier;
}

/** Effort tier classification */
export type EffortTier = 'easy' | 'moderate' | 'hard';

/**
 * HR zone thresholds needed for effort tier classification.
 * hrz_3_min = lower bound of zone 3; hrz_4_min = lower bound of zone 4.
 */
export interface HRZoneThresholds {
  hrz_3_min: number;
  hrz_4_min: number;
}

// ── Output Types ──────────────────────────────────────────────────────────────

/**
 * Result of decoupling computation for a single activity.
 * Maps directly to the activity_decoupling table columns.
 */
export interface DecouplingResult {
  /** Efficiency Factor for the first half of laps */
  ef_h1: number | null;
  /** Efficiency Factor for the second half of laps */
  ef_h2: number | null;
  /** Half-split decoupling percentage: ((EF_H1 - EF_H2) / EF_H1) * 100 */
  decoupling_pct: number | null;

  /** Quartile EF values (populated for races or activities > 2h) */
  ef_q1: number | null;
  ef_q2: number | null;
  ef_q3: number | null;
  ef_q4: number | null;
  /** Q1-Q4 decoupling */
  decoupling_q1q4_pct: number | null;
  /** Q1-Q2 decoupling (early drift indicator) */
  decoupling_q1q2_pct: number | null;

  /** Effort tier classification */
  effort_tier: EffortTier;
  /** Whether GAP was used (false until GAP feature is implemented) */
  gap_used: boolean;
  /** Whether this result should be recomputed when GAP becomes available */
  awaiting_gap: boolean;
  /** True if < 75% of post-preprocessing laps had valid HR */
  hr_data_insufficient: boolean;

  /** Number of laps excluded by warmup filter */
  laps_excluded_warmup: number;
  /** Number of laps excluded by HR validity filter */
  laps_excluded_hr: number;
  /** Total qualifying duration in seconds after all preprocessing */
  qualifying_duration_s: number;

  /** True if computation was skipped (insufficient data) */
  skipped: boolean;
  /** Human-readable reason if skipped */
  skip_reason: string | null;
}

/**
 * Intermediate representation of a preprocessed lap ready for EF computation.
 */
export interface QualifiedLap {
  lap: number;
  moving_time_seconds: number;
  distance_km: number;
  speed_mps: number;
  avg_hr: number;
}
```

### 2.2 Exported Functions

#### `classifyEffortTier(avgHR, thresholds): EffortTier`

```typescript
/**
 * Classify an activity's effort tier based on its average HR and zone thresholds.
 *
 * @param avgHR       Activity-level average heart rate in bpm.
 * @param thresholds  HR zone boundaries: hrz_3_min (start of zone 3),
 *                    hrz_4_min (start of zone 4).
 * @returns           'easy' if avg_hr < hrz_3_min,
 *                    'moderate' if avg_hr >= hrz_3_min and < hrz_4_min,
 *                    'hard' if avg_hr >= hrz_4_min.
 */
export function classifyEffortTier(
  avgHR: number,
  thresholds: HRZoneThresholds,
): EffortTier {
  if (avgHR >= thresholds.hrz_4_min) return 'hard';
  if (avgHR >= thresholds.hrz_3_min) return 'moderate';
  return 'easy';
}
```

#### `computeDecoupling(input): DecouplingResult`

```typescript
/**
 * Compute aerobic decoupling metrics for a single activity.
 *
 * Pure function -- no I/O. All data must be pre-fetched and passed in.
 *
 * Algorithm:
 *   1. Preprocess laps (exclude warmup, paused, invalid HR)
 *   2. Validate minimum duration and HR coverage
 *   3. Compute half-split EF and decoupling percentage
 *   4. If race or > 2h: compute quartile EF and decoupling
 *   5. Return full DecouplingResult
 *
 * @param input  Laps, activity metadata, and pre-resolved effort tier.
 * @returns      DecouplingResult with all computed fields.
 */
export function computeDecoupling(input: DecouplingInput): DecouplingResult;
```

#### `computeBaseline(decouplingValues): BaselineResult`

```typescript
/**
 * Compute personal baseline statistics from qualifying decoupling values.
 *
 * @param decouplingValues  Array of decoupling_pct values for a single effort tier,
 *                          filtered to non-null, non-skipped activities.
 * @returns                 BaselineResult with mean, stdev, bounds, and is_established flag.
 */
export function computeBaseline(decouplingValues: number[]): BaselineResult;

export interface BaselineResult {
  n_qualifying_runs: number;
  mean_decoupling_pct: number;
  stdev_decoupling_pct: number;
  lower_bound: number;
  upper_bound: number;
  /** True when n_qualifying_runs >= 20 */
  is_established: boolean;
}
```

#### `computeRollingTrend(entries, lookbackDays): TrendEntry[]`

```typescript
/**
 * Compute 30-day rolling average of decoupling_pct over the last `lookbackDays`.
 *
 * @param entries       Array of { date: string, decoupling_pct: number } sorted by date ascending.
 * @param lookbackDays  How far back to generate trend data. Default: 90.
 * @returns             Array of TrendEntry, one per day in the lookback window that has data.
 */
export function computeRollingTrend(
  entries: Array<{ date: string; decoupling_pct: number }>,
  lookbackDays?: number,
): TrendEntry[];

export interface TrendEntry {
  date: string;
  rolling_30d_mean: number;
  n_activities: number;
}
```

### 2.3 Algorithm Walkthrough

#### Preprocessing Pipeline

Each step is a pure function that takes an array of `LapRecord` and returns a filtered array plus exclusion counts.

**Step 1: Exclude warmup laps**

```
cumulative_time = 0
for each lap (ordered by lap number):
  cumulative_time += lap.moving_time_seconds
  if cumulative_time <= 600 (10 minutes):
    exclude this lap
  else if (cumulative_time - lap.moving_time_seconds) < 600:
    // This lap straddles the 10-minute mark -- exclude in full
    exclude this lap
  else:
    keep this lap
```

The straddling-lap rule means we never split a lap across the warmup boundary. A lap whose start is before the 10-minute mark but whose end is after it is excluded entirely. This is conservative but avoids partial-lap EF distortion.

**Step 2: Exclude paused laps**

A lap is paused/invalid if:
- `moving_time_seconds` is null or 0
- `moving_time_seconds < 0.5 * elapsed_time_seconds` (lap spent >50% of time paused)

These laps are removed from the working set but are **not** counted in `laps_excluded_warmup` or `laps_excluded_hr` -- they are silently dropped as data quality noise.

**Step 3: Exclude HR-invalid laps and check coverage**

```
laps_with_valid_hr = laps where avg_hr is not null AND avg_hr > 0
laps_excluded_hr = total_remaining_laps - laps_with_valid_hr.length

if laps_with_valid_hr.length < 0.75 * total_remaining_laps:
  return result with hr_data_insufficient = true, skipped = true
```

**Step 4: Minimum duration check**

```
qualifying_duration_s = sum(laps_with_valid_hr.map(l => l.moving_time_seconds))
if qualifying_duration_s < 1800 (30 minutes):
  return result with skipped = true, skip_reason = 'qualifying_duration_below_30min'
```

#### Half-Split Decoupling

After preprocessing yields `qualifiedLaps`:

```
total_time = sum(qualifiedLaps.map(l => l.moving_time_seconds))
half_time = total_time / 2

// Find the lap that straddles the midpoint
cumulative = 0
splitIndex = qualifiedLaps.length  // default: all laps in first half
straddle_lap = null
straddle_fraction_h1 = 1.0  // fraction of straddling lap belonging to H1

for i = 0 to qualifiedLaps.length - 1:
  prevCumulative = cumulative
  cumulative += qualifiedLaps[i].moving_time_seconds
  if prevCumulative < half_time && cumulative >= half_time:
    straddle_lap = qualifiedLaps[i]
    straddle_fraction_h1 = (half_time - prevCumulative) / qualifiedLaps[i].moving_time_seconds
    splitIndex = i
    break

// Assign laps to halves
firstHalf  = qualifiedLaps.slice(0, splitIndex)      // laps fully in H1
secondHalf = qualifiedLaps.slice(splitIndex + 1)     // laps fully in H2
// straddle_lap contributes proportionally to both halves

// Time-weighted EF including proportional straddling lap contribution
function twMeanWithStraddle(fullHalfLaps, straddle, straddle_fraction):
  if straddle is null:
    return timeWeightedMean(fullHalfLaps, ...)
  straddle_time_for_half = straddle.moving_time_seconds * straddle_fraction
  total_weight = sum(fullHalfLaps.map(l => l.moving_time_seconds)) + straddle_time_for_half
  weighted_speed = sum(fullHalfLaps.map(l => l.speed_mps * l.moving_time_seconds))
                   + straddle.speed_mps * straddle_time_for_half
  weighted_hr    = sum(fullHalfLaps.map(l => l.avg_hr * l.moving_time_seconds))
                   + straddle.avg_hr * straddle_time_for_half
  return { speed: weighted_speed / total_weight, hr: weighted_hr / total_weight }

h1_stats = twMeanWithStraddle(firstHalf, straddle_lap, straddle_fraction_h1)
h2_stats = twMeanWithStraddle(secondHalf, straddle_lap, 1 - straddle_fraction_h1)

ef_h1 = h1_stats.speed / h1_stats.hr
ef_h2 = h2_stats.speed / h2_stats.hr

decoupling_pct = ((ef_h1 - ef_h2) / ef_h1) * 100
```

**Interpretation:** A positive `decoupling_pct` means cardiac drift occurred (HR rose relative to pace). Typical aerobically fit runners show <5% on easy runs. Values >10% suggest insufficient aerobic base for the effort level.

#### Quartile Decoupling

Computed when `activity.is_race === true` OR `qualifying_duration_s > 7200`:

```
quarter_time = total_time / 4

quartiles = [[], [], [], []]
cumulative = 0
currentQuartile = 0

for each lap in qualifiedLaps:
  cumulative += lap.moving_time_seconds
  quartiles[currentQuartile].push(lap)
  if cumulative >= (currentQuartile + 1) * quarter_time && currentQuartile < 3:
    currentQuartile++

ef_q1 = computeSegmentEF(quartiles[0])
ef_q2 = computeSegmentEF(quartiles[1])
ef_q3 = computeSegmentEF(quartiles[2])
ef_q4 = computeSegmentEF(quartiles[3])

decoupling_q1q4_pct = ((ef_q1 - ef_q4) / ef_q1) * 100
decoupling_q1q2_pct = ((ef_q1 - ef_q2) / ef_q1) * 100
```

If any quartile has zero laps, set all quartile fields to null.

**Straddling lap handling:** Identical to the half-split approach. A lap that spans a quartile boundary (at the 25%, 50%, or 75% cumulative-time marks) is distributed proportionally between the adjacent quartiles based on the fraction of its duration in each. This ensures each quartile represents exactly 25% of the qualifying activity duration and eliminates segment-length bias.

### 2.4 Edge Cases

| Case | Handling |
|---|---|
| No laps for activity | `skipped = true`, `skip_reason = 'no_laps'` |
| All laps have null HR | `hr_data_insufficient = true`, `skipped = true` |
| Single qualifying lap | `skipped = true`, `skip_reason = 'insufficient_laps_for_split'` (need at least 2 laps for a half split) |
| All laps are warmup | `skipped = true`, `skip_reason = 'all_laps_warmup'` |
| Qualifying time < 30 min | `skipped = true`, `skip_reason = 'qualifying_duration_below_30min'` |
| Zero distance on a lap | Exclude that lap (speed would be 0/undefined) |
| `ef_h1 === 0` | Avoid division by zero -- set `decoupling_pct = null` |
| Only 2-3 qualifying laps | Half-split works (2 laps = 1 per half), quartile skipped |
| Race with < 4 laps | Quartile fields set to null (cannot split into 4 groups) |

### 2.5 Rounding

All output values are rounded to 2 decimal places using `Math.round(v * 100) / 100`. This matches the precision needed for display (e.g., "3.45%") while avoiding floating-point noise.

```typescript
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
```

---

## 3. `lib/decouplingRecalc.ts` -- Supabase I/O Layer

### 3.1 Constants

```typescript
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
import { loadHRZones, type HRZones } from './hrZones';
import { loadLTHR } from './lthr';

/** Placeholder athlete ID (matches pmcRecalc.ts) */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Minimum qualifying runs per tier before baseline is established */
const BASELINE_MIN_RUNS = 20;

/** Number of days for the rolling trend window */
const TREND_LOOKBACK_DAYS = 90;

/** Number of days for the rolling average window */
const ROLLING_WINDOW_DAYS = 30;
```

### 3.2 Function Signatures

#### `resolveHRZoneThresholds(): Promise<HRZoneThresholds | null>`

```typescript
/**
 * Load HR zone thresholds from AsyncStorage, with LTHR fallback.
 *
 * Priority:
 *   1. loadHRZones() -> extract hrz_3_min from zones[2].min, hrz_4_min from zones[3].min
 *   2. loadLTHR() -> estimate zones: hrz_3_min ~= LTHR * 0.82, hrz_4_min ~= LTHR * 0.90
 *   3. null (no zones available -> cannot classify effort tier)
 *
 * @returns HRZoneThresholds or null if neither source is available.
 */
export async function resolveHRZoneThresholds(): Promise<HRZoneThresholds | null>;
```

The LTHR fallback percentages (82% and 90%) are derived from standard Karvonen-based zone models where zone 3 begins at approximately 82% of LTHR and zone 4 at approximately 90% of LTHR. These are conservative defaults.

#### `computeActivityDecoupling(activityId): Promise<DecouplingRecalcResult>`

```typescript
export interface DecouplingRecalcResult {
  ok: boolean;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

/**
 * Fetch laps and metadata for a single activity, compute decoupling, and upsert
 * the result into activity_decoupling.
 *
 * Steps:
 *   1. Fetch activity metadata from garmin_activities
 *   2. Fetch laps from garmin_activity_laps, ordered by lap number
 *   3. Resolve HR zone thresholds (AsyncStorage -> LTHR fallback)
 *   4. Classify effort tier
 *   5. Call computeDecoupling() (pure function)
 *   6. Upsert result into activity_decoupling
 *
 * @param activityId  Garmin activity ID (TEXT)
 */
export async function computeActivityDecoupling(
  activityId: string,
): Promise<DecouplingRecalcResult>;
```

**Supabase query pattern for fetching laps** (mirrors `pmcRecalc.ts` style):

```typescript
const { data: laps, error: lapErr } = await supabase
  .from('garmin_activity_laps')
  .select(
    'lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr, ascent, descent'
  )
  .eq('activity_id', activityId)
  .order('lap', { ascending: true });

if (lapErr) throw lapErr;
```

**Supabase query for activity metadata:**

```typescript
const { data: activity, error: actErr } = await supabase
  .from('garmin_activities')
  .select(
    'activity_id, start_time, avg_hr, moving_time_seconds, distance, ascent, is_race, avg_pace_seconds'
  )
  .eq('activity_id', activityId)
  .single();

if (actErr) throw actErr;
```

**Upsert pattern:**

```typescript
const row = {
  athlete_id: SINGLE_ATHLETE_ID,
  activity_id: activityId,
  date: activity.start_time.slice(0, 10),
  ef_h1: result.ef_h1,
  ef_h2: result.ef_h2,
  decoupling_pct: result.decoupling_pct,
  ef_q1: result.ef_q1,
  ef_q2: result.ef_q2,
  ef_q3: result.ef_q3,
  ef_q4: result.ef_q4,
  decoupling_q1q4_pct: result.decoupling_q1q4_pct,
  decoupling_q1q2_pct: result.decoupling_q1q2_pct,
  effort_tier: result.effort_tier,
  gap_used: result.gap_used,
  awaiting_gap: result.awaiting_gap,
  hr_data_insufficient: result.hr_data_insufficient,
  laps_excluded_warmup: result.laps_excluded_warmup,
  laps_excluded_hr: result.laps_excluded_hr,
  qualifying_duration_s: result.qualifying_duration_s,
};

const { error: upsertErr } = await supabase
  .from('activity_decoupling')
  .upsert(row, { onConflict: 'activity_id' });

if (upsertErr) throw upsertErr;
```

#### `computeActivityDecouplingBatch(activityIds): Promise<BatchDecouplingResult>`

```typescript
export interface BatchDecouplingResult {
  ok: boolean;
  processed: number;
  skipped: number;
  errors: number;
  affected_tiers: EffortTier[];
}

/**
 * Process multiple activities in sequence, then trigger baseline and trend
 * recalculation for any affected effort tiers.
 *
 * This is the top-level entry point called after a Garmin sync.
 *
 * @param activityIds  Array of Garmin activity IDs to process.
 */
export async function computeActivityDecouplingBatch(
  activityIds: string[],
): Promise<BatchDecouplingResult>;
```

#### `recalculateDecouplingBaseline(tiers?): Promise<BaselineRecalcResult>`

```typescript
export interface BaselineRecalcResult {
  ok: boolean;
  tiers_updated: number;
  anomalies_flagged: number;
  error?: string;
}

/**
 * Recalculate personal baselines for the specified effort tiers (or all tiers).
 *
 * Steps:
 *   1. For each tier: fetch all non-skipped decoupling_pct values from activity_decoupling
 *   2. Call computeBaseline() (pure function)
 *   3. Upsert into decoupling_baseline
 *   4. If is_established: check the most recent activity against bounds
 *   5. If outside bounds: insert anomaly notification into athlete_notifications
 *
 * @param tiers  Effort tiers to recalculate. Defaults to all three.
 */
export async function recalculateDecouplingBaseline(
  tiers?: EffortTier[],
): Promise<BaselineRecalcResult>;
```

**Baseline upsert pattern:**

```typescript
const { error } = await supabase
  .from('decoupling_baseline')
  .upsert({
    athlete_id: SINGLE_ATHLETE_ID,
    effort_tier: tier,
    n_qualifying_runs: baseline.n_qualifying_runs,
    mean_decoupling_pct: baseline.mean_decoupling_pct,
    stdev_decoupling_pct: baseline.stdev_decoupling_pct,
    lower_bound: baseline.lower_bound,
    upper_bound: baseline.upper_bound,
    is_established: baseline.is_established,
    last_recalculated: new Date().toISOString(),
  }, { onConflict: 'athlete_id,effort_tier' });
```

**Anomaly notification insert:**

```typescript
const { error: notifErr } = await supabase
  .from('athlete_notifications')
  .insert({
    athlete_id: SINGLE_ATHLETE_ID,
    sport: 'running',
    type: 'decoupling_anomaly',
    message: `Unusual decoupling on ${date}: ${decoupling_pct.toFixed(1)}% ` +
      `(${tier} tier baseline: ${mean.toFixed(1)}% +/- ${(2 * stdev).toFixed(1)}%)`,
    is_read: false,
  });
```

**Note:** The `athlete_notifications` table's CHECK constraint currently only allows `'personalization_available'`, `'model_updated'`, and `'more_data_needed'`. The migration in `sql/activity_decoupling.sql` must ALTER this constraint to add `'decoupling_anomaly'` (see Section 4).

#### `recalculateDecouplingTrend(tiers?): Promise<TrendRecalcResult>`

```typescript
export interface TrendRecalcResult {
  ok: boolean;
  rows_upserted: number;
  error?: string;
}

/**
 * Recalculate the 30-day rolling decoupling trend for the specified effort tiers.
 *
 * Steps:
 *   1. Fetch all non-skipped activity_decoupling rows from the last 90 days
 *   2. Group by effort_tier
 *   3. Call computeRollingTrend() (pure function) for each tier
 *   4. Upsert into decoupling_trend (delete-then-insert for the affected date range)
 *
 * @param tiers  Effort tiers to recalculate. Defaults to all three.
 */
export async function recalculateDecouplingTrend(
  tiers?: EffortTier[],
): Promise<TrendRecalcResult>;
```

**Trend upsert pattern** -- uses delete-then-insert rather than upsert because the 90-day lookback means old rows outside the window should be cleaned up:

```typescript
// Delete existing trend rows for this tier in the lookback window
await supabase
  .from('decoupling_trend')
  .delete()
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('effort_tier', tier)
  .gte('date', lookbackStart);

// Insert fresh trend data
const rows = trendEntries.map(e => ({
  athlete_id: SINGLE_ATHLETE_ID,
  effort_tier: tier,
  date: e.date,
  rolling_30d_mean: e.rolling_30d_mean,
  n_activities: e.n_activities,
}));

// Batch insert in chunks of 500
const BATCH = 500;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { error } = await supabase
    .from('decoupling_trend')
    .insert(chunk);
  if (error) throw error;
}
```

### 3.3 Error Handling

Follow the `pmcRecalc.ts` pattern: every public async function wraps its body in a try/catch and returns `{ ok: false, error: e?.message ?? 'Unknown error' }` on failure. No exceptions propagate to callers.

---

## 4. `sql/activity_decoupling.sql` -- Migration

```sql
-- Section 5: Aerobic Decoupling tables
--
-- Three tables for decoupling analysis:
--   activity_decoupling  -- one row per activity (per-activity EF and decoupling metrics)
--   decoupling_baseline  -- one row per (athlete, effort_tier) (statistical baseline)
--   decoupling_trend     -- one row per (athlete, effort_tier, date) (rolling averages)
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
--
-- Prerequisites:
--   - daily_pmc_values.sql (creates the athletes table)
--   - 001_garmin_tables.sql (creates garmin_activities)
--   - athlete_notifications.sql (creates athlete_notifications)


-- ── activity_decoupling ───────────────────────────────────────────────────────
-- One row per activity. Upsert key: activity_id (1:1 with garmin_activities).

CREATE TABLE IF NOT EXISTS activity_decoupling (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),
    activity_id            TEXT             NOT NULL UNIQUE,

    -- Date of the activity (denormalized for efficient date-range queries)
    date                   DATE             NOT NULL,

    -- Half-split EF values
    ef_h1                  DOUBLE PRECISION,
    ef_h2                  DOUBLE PRECISION,
    decoupling_pct         DOUBLE PRECISION,

    -- Quartile EF values (populated for races or activities > 2h)
    ef_q1                  DOUBLE PRECISION,
    ef_q2                  DOUBLE PRECISION,
    ef_q3                  DOUBLE PRECISION,
    ef_q4                  DOUBLE PRECISION,
    decoupling_q1q4_pct    DOUBLE PRECISION,
    decoupling_q1q2_pct    DOUBLE PRECISION,

    -- Classification and flags
    effort_tier            TEXT             NOT NULL
                                            CHECK (effort_tier IN ('easy', 'moderate', 'hard')),
    gap_used               BOOLEAN          NOT NULL DEFAULT false,
    awaiting_gap           BOOLEAN          NOT NULL DEFAULT true,
    hr_data_insufficient   BOOLEAN          NOT NULL DEFAULT false,

    -- Preprocessing metadata
    laps_excluded_warmup   INTEGER          NOT NULL DEFAULT 0,
    laps_excluded_hr       INTEGER          NOT NULL DEFAULT 0,
    qualifying_duration_s  INTEGER          NOT NULL DEFAULT 0,

    -- Timestamps
    computed_at            TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Primary access pattern: fetch decoupling for a single activity
-- (covered by UNIQUE constraint on activity_id)

-- Date-range queries per athlete and tier (trend charts, baseline recomputation)
CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_tier_date
    ON activity_decoupling (athlete_id, effort_tier, date);

-- Date-range queries per athlete (all tiers)
CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_date
    ON activity_decoupling (athlete_id, date);


-- ── decoupling_baseline ──────────────────────────────────────────────────────
-- One row per (athlete_id, effort_tier). Upsert key: (athlete_id, effort_tier).

CREATE TABLE IF NOT EXISTS decoupling_baseline (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),
    effort_tier            TEXT             NOT NULL
                                            CHECK (effort_tier IN ('easy', 'moderate', 'hard')),

    n_qualifying_runs      INTEGER          NOT NULL DEFAULT 0,
    mean_decoupling_pct    DOUBLE PRECISION NOT NULL DEFAULT 0,
    stdev_decoupling_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
    lower_bound            DOUBLE PRECISION NOT NULL DEFAULT 0,
    upper_bound            DOUBLE PRECISION NOT NULL DEFAULT 0,
    is_established         BOOLEAN          NOT NULL DEFAULT false,
    last_recalculated      TIMESTAMPTZ      NOT NULL DEFAULT now(),

    UNIQUE (athlete_id, effort_tier)
);


-- ── decoupling_trend ─────────────────────────────────────────────────────────
-- One row per (athlete_id, effort_tier, date). 30-day rolling average.

CREATE TABLE IF NOT EXISTS decoupling_trend (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),
    effort_tier            TEXT             NOT NULL
                                            CHECK (effort_tier IN ('easy', 'moderate', 'hard')),
    date                   DATE             NOT NULL,

    rolling_30d_mean       DOUBLE PRECISION NOT NULL,
    n_activities           INTEGER          NOT NULL DEFAULT 0,

    UNIQUE (athlete_id, effort_tier, date)
);

-- Index for time-range trend queries
CREATE INDEX IF NOT EXISTS idx_decoupling_trend_athlete_tier_date
    ON decoupling_trend (athlete_id, effort_tier, date);


-- ── Update athlete_notifications CHECK constraint ────────────────────────────
-- Add 'decoupling_anomaly' to the allowed notification types.

ALTER TABLE athlete_notifications
    DROP CONSTRAINT IF EXISTS athlete_notifications_type_check;

ALTER TABLE athlete_notifications
    ADD CONSTRAINT athlete_notifications_type_check
    CHECK (type IN (
        'personalization_available',
        'model_updated',
        'more_data_needed',
        'decoupling_anomaly'
    ));


-- ── Access control ───────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON activity_decoupling TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON decoupling_baseline TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON decoupling_trend TO anon, authenticated;

ALTER TABLE activity_decoupling DISABLE ROW LEVEL SECURITY;
ALTER TABLE decoupling_baseline DISABLE ROW LEVEL SECURITY;
ALTER TABLE decoupling_trend    DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

### Index Strategy Rationale

| Index | Purpose |
|---|---|
| `UNIQUE (activity_id)` on `activity_decoupling` | 1:1 upsert key; also serves as the primary lookup index |
| `(athlete_id, effort_tier, date)` on `activity_decoupling` | Baseline recomputation queries: "all easy-tier decoupling values for this athlete" |
| `(athlete_id, date)` on `activity_decoupling` | Activity detail screen: fetch decoupling for a date range |
| `UNIQUE (athlete_id, effort_tier)` on `decoupling_baseline` | Upsert key; at most 3 rows per athlete (one per tier) |
| `UNIQUE (athlete_id, effort_tier, date)` on `decoupling_trend` | Upsert key; also the primary query pattern for trend charts |
| `(athlete_id, effort_tier, date)` on `decoupling_trend` | Range scans for trend chart rendering |

`decoupling_trend` gets DELETE permission (unlike the other two) because the recalc strategy is delete-then-insert for the lookback window.

---

## 5. Effort Tier Classification

### HR Zone Loading

The effort tier for an activity depends on the athlete's HR zone configuration. In the React Native context, HR zones are stored in AsyncStorage.

**Resolution chain:**

```
1. loadHRZones() -> AsyncStorage key 'hr_zones_v1'
   Returns HRZones: [zone1, zone2, zone3, zone4, zone5]
   Each zone: { min: number, max: number }

   Extract: hrz_3_min = zones[2].min, hrz_4_min = zones[3].min

2. If loadHRZones() returns null -> loadLTHR()
   Returns LTHR in bpm (or null)

   Estimate zones from LTHR:
     hrz_3_min = Math.round(lthr * 0.82)
     hrz_4_min = Math.round(lthr * 0.90)

   These percentages assume a standard 5-zone model where:
     Zone 1-2: < 82% LTHR (recovery/endurance)
     Zone 3:   82-89% LTHR (tempo)
     Zone 4-5: >= 90% LTHR (threshold/VO2max)

3. If loadLTHR() returns null -> check garmin_activity_laps HR zone columns
   Fallback: read hrz_3_hr and hrz_4_hr from the first lap of any recent activity.
   These columns store the Garmin-configured zone thresholds.

   Query:
     SELECT hrz_3_hr, hrz_4_hr FROM garmin_activity_laps
     WHERE hrz_3_hr IS NOT NULL
     ORDER BY start_time DESC LIMIT 1

4. If no HR zones available at all -> default effort_tier = 'moderate'
   Log a warning. The user should configure zones for accurate classification.
```

### Zone-to-Tier Mapping

| Tier | HR Range | Typical Activities |
|---|---|---|
| `easy` | avg_hr < hrz_3_min | Recovery runs, easy long runs |
| `moderate` | hrz_3_min <= avg_hr < hrz_4_min | Tempo runs, moderate long runs |
| `hard` | avg_hr >= hrz_4_min | Intervals, races, threshold runs |

### Important Design Decision

Effort tier is resolved in the **recalc layer** (not the pure library) because it requires AsyncStorage I/O. The pure `computeDecoupling()` function receives the pre-resolved `effort_tier` as part of `DecouplingInput`. This keeps the calculation library testable without mocking AsyncStorage.

---

## 6. Baseline & Trend Computation

### 6.1 Personal Baseline

**Eligibility:** `n_qualifying_runs >= 20` per effort tier. "Qualifying" means the `activity_decoupling` row has `decoupling_pct IS NOT NULL` and the activity was not skipped.

**Statistics:**

```typescript
// Use POPULATION standard deviation (divide by N, not N-1).
//
// Rationale: We are computing the baseline for THIS athlete's full history
// of qualifying runs, not estimating a population parameter from a sample.
// The N runs ARE the population (all qualifying runs this athlete has done).
// Population stdev produces tighter bounds, which means anomaly detection
// is more sensitive -- appropriate for personal baselines where we want to
// catch true deviations from established patterns.

function populationStdev(values: number[], mean: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sumSqDiff = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(sumSqDiff / n);
}
```

**Bounds:**

```
lower_bound = mean - 2 * stdev
upper_bound = mean + 2 * stdev
```

Using 2 standard deviations captures approximately 95% of the distribution under normality. Decoupling values outside this range are flagged as anomalies.

**Deviation flagging:**

When `is_established === true` and a new activity's `decoupling_pct` falls outside `[lower_bound, upper_bound]`, insert a notification into `athlete_notifications` with `type = 'decoupling_anomaly'`.

Only flag the **most recent** activity after baseline recomputation -- do not retroactively flag historical activities.

### 6.2 Rolling Trend

**Algorithm:**

```
lookback_start = today - 90 days
data = all activity_decoupling rows where:
  - date >= lookback_start
  - decoupling_pct IS NOT NULL
  - effort_tier = <target tier>

Sort by date ascending.

For each unique date in data:
  window_start = date - 30 days
  window_entries = data.filter(d => d.date > window_start && d.date <= date)
  rolling_30d_mean = mean(window_entries.map(e => e.decoupling_pct))
  n_activities = window_entries.length

  Emit TrendEntry { date, rolling_30d_mean, n_activities }
```

**Design note:** The rolling window uses a **trailing** 30-day window (date - 30 to date, inclusive of date). This means the trend for today reflects the last 30 days of activity. The 90-day lookback limits how much historical trend data is stored.

**Storage:** `decoupling_trend` stores one row per (athlete, tier, date) for each date that had at least one qualifying activity in its 30-day window. Days with no activities in the window are not stored (sparse representation). The UI can interpolate between points if needed.

---

## 7. Integration Points

### 7.1 Sync Pipeline

The decoupling computation plugs into the existing post-sync pipeline. The calling code (wherever `recalculateAllSports()` is invoked after sync) should be extended:

```typescript
// After Garmin sync completes:

// Step 1: Existing PMC pipeline
await recalculateAllSports();

// Step 2: NEW -- Decoupling pipeline for new/updated activities
const newActivityIds = getNewOrUpdatedActivityIds(); // from sync response
const decResult = await computeActivityDecouplingBatch(newActivityIds);

// Steps 3 & 4 are handled inside computeActivityDecouplingBatch:
//   - recalculateDecouplingBaseline(affected_tiers)
//   - recalculateDecouplingTrend(affected_tiers)
```

### 7.2 GAP Backfill Stub

The `awaiting_gap` boolean flag on `activity_decoupling` defaults to `true`. When GAP (Grade Adjusted Pace) is implemented in a future section:

1. Backfill GAP-adjusted speeds into the laps or a separate column
2. Query all `activity_decoupling` rows where `awaiting_gap = true`
3. Re-run `computeActivityDecoupling()` for each, this time using GAP-adjusted speed
4. Set `gap_used = true`, `awaiting_gap = false` on the re-computed rows

The `computeDecoupling()` function itself does not need to change -- the caller simply provides GAP-adjusted `distance` values in the `LapRecord` objects. The pure function is agnostic to whether the speed is flat or grade-adjusted.

### 7.3 Activity Detail Screen

The `ActivityDetailScreen` should be extended to display decoupling metrics. Query pattern:

```typescript
const { data } = await supabase
  .from('activity_decoupling')
  .select('*')
  .eq('activity_id', activityId)
  .maybeSingle();
```

Display fields: `decoupling_pct` (primary), `ef_h1`/`ef_h2`, effort tier badge, and quartile breakdown for races.

---

## 8. Testing Strategy

### 8.1 Unit Tests for `lib/decoupling.ts`

File: `__tests__/decoupling.test.ts`

Follow the existing test pattern from `__tests__/pmc.test.ts`: plain Node test file using `assert()` helper, run with `node --experimental-strip-types`.

**Core function tests:**

| Test | Description |
|---|---|
| `computeDecoupling: basic 10-lap easy run` | 10 laps with decreasing speed and increasing HR -- verify decoupling_pct > 0 |
| `computeDecoupling: no drift` | 10 laps with constant speed/HR ratio -- verify decoupling_pct ~= 0 |
| `computeDecoupling: negative drift` | Speed increases relative to HR (negative split) -- verify decoupling_pct < 0 |
| `computeDecoupling: warmup exclusion` | First 3 laps total 12 min -- verify laps_excluded_warmup = 3 |
| `computeDecoupling: straddling warmup lap` | Lap crosses 10-min boundary -- verify it's excluded entirely |
| `computeDecoupling: paused lap exclusion` | Lap with moving_time = 0 -- verify it's excluded |
| `computeDecoupling: paused lap 50% rule` | Lap with moving_time < 50% elapsed -- verify excluded |
| `computeDecoupling: HR coverage threshold` | 70% valid HR laps -- verify hr_data_insufficient = true |
| `computeDecoupling: min duration check` | 25 min qualifying time -- verify skipped with reason |
| `computeDecoupling: quartile for race` | is_race = true -- verify ef_q1..q4 are populated |
| `computeDecoupling: quartile for >2h activity` | 2.5h activity -- verify quartile fields populated |
| `computeDecoupling: quartile skipped for short non-race` | 1h non-race -- verify quartile fields are null |
| `classifyEffortTier: easy` | avgHR = 130, hrz_3_min = 145 -- verify 'easy' |
| `classifyEffortTier: moderate` | avgHR = 155, hrz_3_min = 145, hrz_4_min = 165 -- verify 'moderate' |
| `classifyEffortTier: hard` | avgHR = 170, hrz_4_min = 165 -- verify 'hard' |

**Baseline tests:**

| Test | Description |
|---|---|
| `computeBaseline: 20+ values` | Verify is_established = true, bounds = mean +/- 2*stdev |
| `computeBaseline: < 20 values` | Verify is_established = false |
| `computeBaseline: single value` | Verify stdev = 0, bounds = mean |
| `computeBaseline: empty array` | Verify n_qualifying_runs = 0, defaults |

**Trend tests:**

| Test | Description |
|---|---|
| `computeRollingTrend: basic` | 10 entries over 60 days -- verify rolling mean is correct |
| `computeRollingTrend: sparse data` | 3 entries over 90 days -- verify output matches data points |
| `computeRollingTrend: empty` | Empty array -- verify returns [] |

**Edge case tests:**

| Test | Description |
|---|---|
| No laps | `skipped = true`, `skip_reason = 'no_laps'` |
| Single lap | `skipped = true`, `skip_reason = 'insufficient_laps_for_split'` |
| All null HR | `hr_data_insufficient = true` |
| Zero distance lap | Lap excluded, computation continues |
| ef_h1 = 0 | `decoupling_pct = null` (division by zero guard) |
| All laps are warmup | `skipped = true`, `skip_reason = 'all_laps_warmup'` |

### 8.2 Integration Tests

These would require Supabase mocking or a test database. Test in the recalc layer:

- `computeActivityDecoupling`: verify it fetches laps, computes, and upserts correctly
- `recalculateDecouplingBaseline`: verify anomaly notification is inserted when outside bounds
- `recalculateDecouplingTrend`: verify delete-then-insert pattern works correctly
- HR zone resolution fallback chain: loadHRZones -> loadLTHR -> Garmin laps -> default

### 8.3 Regression Fixture

Create a fixture with a known 20-lap activity where the expected EF and decoupling values are pre-computed by hand. This serves as the "golden file" regression test (same pattern as the 30-day PMC fixture in `pmc.test.ts`).

Fixture parameters:
- 20 laps, each 1 km, moving time varies from 270s to 310s
- HR increases from 145 to 165 bpm across laps (simulating drift)
- First 3 laps total 810s (> 600s warmup threshold) -- 3 laps excluded
- Expected decoupling ~5-8% (pre-compute exact value)

---

## 9. Ticket Breakdown

### DEC-001: Core Calculation Library
**File:** `lib/decoupling.ts`
**Scope:** All type definitions, `computeDecoupling()`, preprocessing pipeline, half-split and quartile algorithms, `classifyEffortTier()`, `round2()` helper.
**Tests:** `__tests__/decoupling.test.ts` -- all unit tests for the pure calculation library.
**Dependencies:** None (pure TypeScript, no external imports).
**Estimated complexity:** Medium-high (most algorithmic work lives here).

### DEC-002: SQL Migration
**File:** `sql/activity_decoupling.sql`
**Scope:** CREATE TABLE for all three tables, indexes, RLS disable, GRANT, ALTER athlete_notifications CHECK constraint, NOTIFY pgrst.
**Dependencies:** None (run independently in SQL editor).
**Estimated complexity:** Low.

### DEC-003: Supabase I/O Layer -- Per-Activity
**File:** `lib/decouplingRecalc.ts`
**Scope:** `resolveHRZoneThresholds()`, `computeActivityDecoupling()`, `computeActivityDecouplingBatch()`. Fetch laps, fetch activity metadata, resolve effort tier, call pure computation, upsert result.
**Dependencies:** DEC-001 (pure library), DEC-002 (tables must exist).
**Estimated complexity:** Medium.

### DEC-004: Baseline Computation
**File:** `lib/decoupling.ts` (pure `computeBaseline()`), `lib/decouplingRecalc.ts` (`recalculateDecouplingBaseline()`)
**Scope:** Statistical baseline computation, anomaly detection, notification insertion.
**Dependencies:** DEC-001 (types), DEC-002 (tables), DEC-003 (activity_decoupling must be populated).
**Estimated complexity:** Medium.

### DEC-005: Rolling Trend
**File:** `lib/decoupling.ts` (pure `computeRollingTrend()`), `lib/decouplingRecalc.ts` (`recalculateDecouplingTrend()`)
**Scope:** 30-day rolling average computation, 90-day lookback, delete-then-insert storage.
**Dependencies:** DEC-001 (types), DEC-002 (tables), DEC-003 (activity_decoupling must be populated).
**Estimated complexity:** Low-medium.

### DEC-006: Sync Pipeline Integration
**File:** Wherever the post-sync orchestration lives (likely near `triggerSync()` or the sync completion handler)
**Scope:** Wire `computeActivityDecouplingBatch()` into the post-sync pipeline after `recalculateAllSports()`. Ensure new/updated activity IDs are passed through.
**Dependencies:** DEC-003, DEC-004, DEC-005 (all recalc functions must be implemented).
**Estimated complexity:** Low.

### Implementation Order

```
DEC-001  (pure library, no dependencies)
  |
DEC-002  (SQL migration, no code dependencies -- can run in parallel with DEC-001)
  |
  +---> DEC-003  (requires DEC-001 + DEC-002)
          |
          +---> DEC-004  (requires DEC-003)
          |
          +---> DEC-005  (requires DEC-003, can run in parallel with DEC-004)
                  |
                  +---> DEC-006  (requires DEC-003, DEC-004, DEC-005)
```

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **HR zones not configured** | Medium | Fallback chain: AsyncStorage -> LTHR -> Garmin laps -> default 'moderate'. Document in onboarding. |
| **Laps not synced** | Medium | `computeActivityDecoupling` returns `skipped = true` with reason. Decoupling is silently unavailable for activities without laps. |
| **athlete_notifications CHECK constraint change** | Low | The ALTER DROP/ADD constraint in the migration is backward-compatible. Existing rows are unaffected. |
| **GAP not yet implemented** | Low | `awaiting_gap = true` flag allows future backfill without schema changes. |
| **Large batch after initial sync** | Medium | Process activities sequentially (not in parallel) to avoid overwhelming Supabase with concurrent upserts. Baseline and trend recalc run once after the full batch, not per-activity. |
| **AsyncStorage unavailable in test environment** | Low | HR zone resolution is in the recalc layer, not the pure library. Unit tests for `computeDecoupling` pass the effort tier directly. Integration tests mock AsyncStorage. |

---

## Sign-off

**Staff Engineer Lead:** Approved — Design follows established two-layer codebase patterns. C4 (straddling lap proportional distribution) incorporated to eliminate segment-length bias. C1/C2/C3 overrides upheld per project-documented decisions (RLS disabled project-wide, client-side execution model, no auth yet).
**Date:** 2026-03-07
**Staff Engineer 2:** Approved (Round 2) — All concerns resolved. C1/C2/C3 overrides accepted based on project architectural constraints. C4 incorporated.
**Status:** Final — ready for ticket prompt generation
