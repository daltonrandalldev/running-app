# Section 5 Ticket Prompts — Aerobic Decoupling & Cardiac Drift

**Author:** Prompt Engineer
**Date:** 2026-03-07
**PRD Section:** 5 (Aerobic Decoupling & Cardiac Drift)

---

## Ticket 1 — DEC-001: Core Calculation Library

### Objective

Implement the pure TypeScript aerobic decoupling calculation library (`lib/decoupling.ts`). This file has zero I/O — it accepts typed input objects and returns typed output objects. It is the algorithmic heart of Section 5 and must be fully unit-testable without mocking any external dependencies.

### Files to Create / Modify

- **Create:** `lib/decoupling.ts` — pure calculation library
- **Create:** `__tests__/decoupling.test.ts` — unit tests

### Context

#### What Is Aerobic Decoupling?

Aerobic decoupling measures how much heart rate drifted upward relative to output (speed) during steady-state exercise. The primary metric uses Friel's Efficiency Factor (EF) method: compare the EF of the first half of an activity to the EF of the second half. A positive decoupling percentage means HR drifted up relative to pace (normal aerobic drift). Values >5% on an easy long run suggest insufficient aerobic base.

#### Efficiency Factor Formula

EF is **speed in meters per second divided by average HR in bpm**. This direction is critical: faster = higher numerator = higher EF. Using pace (sec/km) instead would invert the direction (a fatigued, slower run would paradoxically show higher EF).

```
lap_speed_mps = (lap_distance_km * 1000) / lap_moving_time_seconds
EF_segment = time_weighted_mean(speed_mps) / time_weighted_mean(avg_hr)
```

All means are time-weighted by `moving_time_seconds` (not simple arithmetic mean of laps).

Typical EF values range from 0.030 to 0.065 m/s/bpm for easy-to-threshold efforts.

#### Complete Type Definitions

Implement ALL of the following types exactly as specified:

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
  /** Is this a race (from PMC-002 race detection) */
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

export interface BaselineResult {
  n_qualifying_runs: number;
  mean_decoupling_pct: number;
  stdev_decoupling_pct: number;
  lower_bound: number;
  upper_bound: number;
  /** True when n_qualifying_runs >= 20 */
  is_established: boolean;
}

export interface TrendEntry {
  date: string;
  rolling_30d_mean: number;
  n_activities: number;
}
```

#### Exported Functions to Implement

**`classifyEffortTier(avgHR, thresholds): EffortTier`**

```typescript
/**
 * Classify an activity's effort tier based on its average HR and zone thresholds.
 *
 * Returns 'easy' if avg_hr < hrz_3_min,
 *         'moderate' if avg_hr >= hrz_3_min and < hrz_4_min,
 *         'hard' if avg_hr >= hrz_4_min.
 */
export function classifyEffortTier(
  avgHR: number,
  thresholds: HRZoneThresholds,
): EffortTier
```

**`computeDecoupling(input): DecouplingResult`**

```typescript
/**
 * Compute aerobic decoupling metrics for a single activity.
 * Pure function -- no I/O.
 *
 * Algorithm:
 *   1. Preprocess laps (exclude warmup, paused, invalid HR)
 *   2. Validate minimum duration and HR coverage
 *   3. Compute half-split EF and decoupling percentage
 *   4. If race or > 2h: compute quartile EF and decoupling
 *   5. Return full DecouplingResult
 */
export function computeDecoupling(input: DecouplingInput): DecouplingResult
```

**`computeBaseline(decouplingValues): BaselineResult`**

```typescript
/**
 * Compute personal baseline statistics from qualifying decoupling values.
 * Uses POPULATION standard deviation (divide by N, not N-1).
 */
export function computeBaseline(decouplingValues: number[]): BaselineResult
```

**`computeRollingTrend(entries, lookbackDays?): TrendEntry[]`**

```typescript
/**
 * Compute 30-day rolling average of decoupling_pct over the last lookbackDays.
 * Default lookbackDays = 90.
 * entries must be sorted by date ascending.
 */
export function computeRollingTrend(
  entries: Array<{ date: string; decoupling_pct: number }>,
  lookbackDays?: number,
): TrendEntry[]
```

#### Preprocessing Pipeline (implement as internal helper steps)

**Step 1: Warmup Lap Exclusion**

Exclude all laps whose cumulative elapsed time falls within the first 10 minutes (600 seconds). The "straddling lap" rule: a lap that begins before the 10-minute mark but ends after it is excluded in full (conservative — never split a lap).

```
cumulative_time = 0
for each lap (ordered by lap number ascending):
  cumulative_time += lap.moving_time_seconds
  if cumulative_time <= 600:
    exclude this lap (warmup)
  else if (cumulative_time - lap.moving_time_seconds) < 600:
    // This lap straddles the 10-minute mark -- exclude in full
    exclude this lap (warmup)
  else:
    keep this lap
```

Count excluded laps into `laps_excluded_warmup`.

**Step 2: Paused/Stopped Segment Exclusion**

A lap is paused/invalid if ANY of the following:
- `moving_time_seconds` is null or 0
- `distance` is null or 0 (would produce undefined speed)
- `moving_time_seconds < 0.5 * elapsed_time_seconds` (lap spent >50% of time paused)

These laps are silently removed. Do NOT count them in `laps_excluded_warmup` or `laps_excluded_hr`.

**Step 3: HR Validity Check and Coverage Threshold**

```
laps_with_valid_hr = laps where avg_hr is not null AND avg_hr > 0
laps_excluded_hr = total_remaining_laps - laps_with_valid_hr.length

if laps_with_valid_hr.length < 0.75 * total_remaining_laps:
  return result with hr_data_insufficient = true, skipped = true,
         skip_reason = 'hr_coverage_below_75pct'
```

**Step 4: Minimum Duration Check**

```
qualifying_duration_s = sum(laps_with_valid_hr.map(l => l.moving_time_seconds))
if qualifying_duration_s < 1800 (30 minutes):
  return result with skipped = true,
         skip_reason = 'qualifying_duration_below_30min'
```

#### Half-Split Decoupling Algorithm

After preprocessing yields `qualifiedLaps` (array of `QualifiedLap`):

```
total_time = sum(qualifiedLaps.map(l => l.moving_time_seconds))
half_time = total_time / 2

// Find the lap that straddles the midpoint
cumulative = 0
splitIndex = qualifiedLaps.length  // default: all laps in first half
straddle_lap = null
straddle_fraction_h1 = 1.0         // fraction of straddling lap belonging to H1

for i = 0 to qualifiedLaps.length - 1:
  prevCumulative = cumulative
  cumulative += qualifiedLaps[i].moving_time_seconds
  if prevCumulative < half_time && cumulative >= half_time:
    straddle_lap = qualifiedLaps[i]
    straddle_fraction_h1 = (half_time - prevCumulative) / qualifiedLaps[i].moving_time_seconds
    splitIndex = i
    break

// Assign laps to halves
firstHalf  = qualifiedLaps.slice(0, splitIndex)     // laps fully in H1
secondHalf = qualifiedLaps.slice(splitIndex + 1)    // laps fully in H2
// straddle_lap contributes proportionally to both halves

// Time-weighted EF including proportional straddling lap contribution
function twMeanWithStraddle(fullHalfLaps, straddle, straddle_fraction):
  straddle_time_for_half = straddle ? straddle.moving_time_seconds * straddle_fraction : 0
  total_weight = sum(fullHalfLaps.map(l => l.moving_time_seconds)) + straddle_time_for_half
  weighted_speed = sum(fullHalfLaps.map(l => l.speed_mps * l.moving_time_seconds))
                   + (straddle ? straddle.speed_mps * straddle_time_for_half : 0)
  weighted_hr    = sum(fullHalfLaps.map(l => l.avg_hr * l.moving_time_seconds))
                   + (straddle ? straddle.avg_hr * straddle_time_for_half : 0)
  return { speed: weighted_speed / total_weight, hr: weighted_hr / total_weight }

h1_stats = twMeanWithStraddle(firstHalf, straddle_lap, straddle_fraction_h1)
h2_stats = twMeanWithStraddle(secondHalf, straddle_lap, 1 - straddle_fraction_h1)

ef_h1 = h1_stats.speed / h1_stats.hr
ef_h2 = h2_stats.speed / h2_stats.hr

decoupling_pct = ((ef_h1 - ef_h2) / ef_h1) * 100
```

Guard: if `ef_h1 === 0`, set `decoupling_pct = null` (division by zero protection).

#### Quartile Decoupling Algorithm

Compute when `activity.is_race === true` OR `qualifying_duration_s > 7200`:

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

Straddling lap handling for quartile boundaries: identical to the half-split approach. A lap that spans a quartile boundary (at the 25%, 50%, or 75% cumulative-time marks) is distributed proportionally between the adjacent quartiles based on the fraction of its duration in each.

If any quartile has zero laps, set all quartile fields to null.

#### GAP Flag Logic

GAP (Grade Adjusted Pace) is not implemented yet (requires a future section). Set `gap_used = false` on every result. Set `awaiting_gap = true` when `activity.ascent` (activity-level total ascent) is greater than 100 meters; otherwise `awaiting_gap = false`.

#### Baseline Computation Algorithm

Use POPULATION standard deviation (divide by N, not N-1). Rationale: the athlete's full history of qualifying runs IS the population, not a sample.

```typescript
function populationStdev(values: number[], mean: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sumSqDiff = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(sumSqDiff / n);
}
```

Bounds: `lower_bound = mean - 2 * stdev`, `upper_bound = mean + 2 * stdev`.

`is_established = n_qualifying_runs >= 20`.

#### Rolling Trend Algorithm

```
lookback_start = today - lookbackDays (default 90)
data = entries filtered to date >= lookback_start, sorted by date ascending

For each unique date in data:
  window_start = date - 30 days
  window_entries = data.filter(d => d.date > window_start && d.date <= date)
  rolling_30d_mean = mean(window_entries.map(e => e.decoupling_pct))
  n_activities = window_entries.length
  Emit TrendEntry { date, rolling_30d_mean, n_activities }
```

The rolling window is a trailing 30-day window inclusive of the current date. Only dates with at least one qualifying activity in their 30-day window emit a `TrendEntry`.

#### Rounding

All `number` output values (ef_h1, ef_h2, decoupling_pct, ef_q1–q4, quartile percentages, baseline bounds, rolling means) are rounded to 2 decimal places:

```typescript
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
```

#### Edge Cases

| Case | Handling |
|---|---|
| No laps (`laps.length === 0`) | `skipped = true`, `skip_reason = 'no_laps'` |
| All laps are warmup | `skipped = true`, `skip_reason = 'all_laps_warmup'` |
| All laps have null HR | `hr_data_insufficient = true`, `skipped = true`, `skip_reason = 'hr_coverage_below_75pct'` |
| Single qualifying lap | `skipped = true`, `skip_reason = 'insufficient_laps_for_split'` (need at least 2) |
| Qualifying time < 30 min | `skipped = true`, `skip_reason = 'qualifying_duration_below_30min'` |
| Zero distance on a lap | Exclude that lap (paused/stopped, speed undefined) |
| `ef_h1 === 0` | Set `decoupling_pct = null` (guard against division by zero) |
| Only 2-3 qualifying laps | Half-split works (1 lap per half minimum); quartile fields set to null |
| Race with < 4 qualifying laps | Quartile fields set to null |
| `computeBaseline([])` | Return `n_qualifying_runs = 0`, `is_established = false`, all numeric fields = 0 |
| `computeRollingTrend([], ...)` | Return `[]` |

### Acceptance Criteria

1. `lib/decoupling.ts` has zero imports from Supabase, AsyncStorage, React Native, or any project-specific module that performs I/O.
2. `computeDecoupling` returns `skipped = true` with a `skip_reason` string for every edge case listed above.
3. `decoupling_pct` is positive when HR drifts up relative to speed, negative when speed improves relative to HR (negative split), and approximately zero when the HR:speed ratio is constant.
4. Quartile fields (`ef_q1`–`ef_q4`, `decoupling_q1q4_pct`, `decoupling_q1q2_pct`) are non-null only when `activity.is_race === true` OR `qualifying_duration_s > 7200`.
5. `laps_excluded_warmup` accurately reflects the count of laps dropped by the warmup filter (including any straddling lap).
6. `awaiting_gap = true` for any activity where `activity.ascent > 100`.
7. `gap_used = false` on every result.
8. `computeBaseline` returns `is_established = false` when `n_qualifying_runs < 20`.
9. `computeRollingTrend` returns one entry per date that has at least one qualifying activity in its 30-day trailing window.
10. All numeric outputs are rounded to 2 decimal places.
11. All unit tests in `__tests__/decoupling.test.ts` pass when run with `node --experimental-strip-types __tests__/decoupling.test.ts`.

### Unit Tests to Write (`__tests__/decoupling.test.ts`)

Follow the pattern from `__tests__/pmc.test.ts` exactly:
- Plain Node test file, no test framework
- Import with `../lib/decoupling.ts` (`.ts` extension required)
- Use a local `assert(condition, message)` function that sets `process.exitCode = 1` on failure
- Run with `node --experimental-strip-types __tests__/decoupling.test.ts`

**`computeDecoupling` tests:**

| Test | Setup | What to assert |
|---|---|---|
| Basic 10-lap easy run with drift | 10 laps, speed decreasing, HR increasing | `decoupling_pct > 0`, `skipped = false` |
| No drift | 10 laps, constant speed/HR ratio | `decoupling_pct` approximately 0 (within 0.1) |
| Negative drift (negative split) | 10 laps, speed increasing relative to HR | `decoupling_pct < 0` |
| Warmup exclusion | First 3 laps totaling 810s (> 600s) | `laps_excluded_warmup = 3` |
| Straddling warmup lap | Lap 3 spans the 600s boundary | That lap is excluded entirely |
| Paused lap exclusion | One lap with `moving_time_seconds = 0` | That lap excluded, rest computed |
| Paused lap 50% rule | One lap with `moving_time < 0.5 * elapsed_time` | That lap excluded |
| HR coverage below 75% | 7 of 10 laps have null HR | `hr_data_insufficient = true`, `skipped = true` |
| HR coverage exactly 75% | 75 of 100 laps have valid HR | `hr_data_insufficient = false` (boundary included) |
| Minimum duration check | 25 min qualifying time | `skipped = true`, `skip_reason = 'qualifying_duration_below_30min'` |
| Quartile for race | `is_race = true`, 4+ qualifying laps, >30 min | `ef_q1`–`ef_q4` all non-null |
| Quartile for >2h activity | `qualifying_duration_s = 7500`, `is_race = false` | Quartile fields non-null |
| Quartile skipped for short non-race | 60 min activity, `is_race = false` | All quartile fields null |
| No laps | `laps = []` | `skipped = true`, `skip_reason = 'no_laps'` |
| Single qualifying lap | 1 lap post-warmup/exclusion | `skipped = true`, `skip_reason = 'insufficient_laps_for_split'` |
| All laps are warmup | All laps within first 10 min | `skipped = true`, `skip_reason = 'all_laps_warmup'` |
| Zero distance lap | One lap with `distance = 0` | That lap excluded, computation continues on others |
| `awaiting_gap` flag | `activity.ascent = 150` | `awaiting_gap = true` |
| `awaiting_gap` false | `activity.ascent = 50` | `awaiting_gap = false` |

**`classifyEffortTier` tests:**

| Test | Input | Expected |
|---|---|---|
| Easy | `avgHR = 130`, `hrz_3_min = 145` | `'easy'` |
| Moderate | `avgHR = 155`, `hrz_3_min = 145`, `hrz_4_min = 165` | `'moderate'` |
| Hard | `avgHR = 170`, `hrz_4_min = 165` | `'hard'` |
| Boundary: exactly hrz_3_min | `avgHR = 145`, `hrz_3_min = 145` | `'moderate'` (>= threshold) |
| Boundary: exactly hrz_4_min | `avgHR = 165`, `hrz_4_min = 165` | `'hard'` (>= threshold) |

**`computeBaseline` tests:**

| Test | Input | What to assert |
|---|---|---|
| 20+ values | Array of 25 decoupling_pct values | `is_established = true`, bounds = `mean +/- 2*stdev` |
| < 20 values | Array of 15 values | `is_established = false` |
| Exactly 20 values | Array of 20 values | `is_established = true` |
| Single value | `[5.0]` | `stdev = 0`, `lower_bound = upper_bound = mean` |
| Empty array | `[]` | `n_qualifying_runs = 0`, `is_established = false` |

**`computeRollingTrend` tests:**

| Test | Setup | What to assert |
|---|---|---|
| Basic | 10 entries over 60 days | Rolling means computed, output length = 10 |
| Sparse data | 3 entries over 90 days | 3 trend entries returned |
| Empty | `[]` | Returns `[]` |
| Window exclusion | Entry exactly 31 days before another | The older entry is outside the 30-day window |

**Regression fixture:**

Create a 20-lap fixture with known parameters and pre-computed expected decoupling:
- 20 laps, each 1 km
- Laps 1-3: moving_time_seconds = 270s each (total 810s — all 3 excluded as warmup)
- Laps 4-20: moving_time_seconds varies from 280s to 310s (linearly increasing, simulating fatigue)
- HR for laps 4-20: increases from 145 bpm to 165 bpm (linearly)
- Pre-compute the expected `decoupling_pct` by hand and assert within ±0.1

### Dependencies

None. This is a pure TypeScript module with no project dependencies.

### Do Not Do

- Do NOT import `supabase`, `AsyncStorage`, or any React Native module
- Do NOT implement the Supabase I/O layer (that is DEC-003)
- Do NOT implement the database migration SQL (that is DEC-002)
- Do NOT implement the sync pipeline wiring (that is DEC-006)
- Do NOT apply GAP-adjusted speeds — set `gap_used = false` and `awaiting_gap` based on ascent > 100m
- Do NOT implement per-second cardiac drift (that feature requires per-second stream sync, which is explicitly deferred)

---

## Ticket 2 — DEC-002: Database Schema Migration

### Objective

Write the SQL migration that creates the three new database tables for Section 5 (`activity_decoupling`, `decoupling_baseline`, `decoupling_trend`), adds all indexes, configures access control, and extends the `athlete_notifications` table to accept the new `'decoupling_anomaly'` notification type. This migration is idempotent and can be run multiple times safely.

### Files to Create / Modify

- **Create:** `sql/activity_decoupling.sql`

### Context

#### Prerequisites

This migration depends on three existing migrations that must have already been run:
- `sql/daily_pmc_values.sql` — creates the `athletes` table with the placeholder row `('00000000-0000-0000-0000-000000000001')`
- `001_garmin_tables.sql` — creates `garmin_activities`
- `athlete_notifications.sql` — creates `athlete_notifications`

Do not re-create the `athletes` table or insert the placeholder row; those already exist.

#### Existing `athlete_notifications` Constraint

The `athlete_notifications` table has a CHECK constraint limiting the `type` column to: `'personalization_available'`, `'model_updated'`, `'more_data_needed'`. This migration must ALTER that constraint to add `'decoupling_anomaly'`. The approach is DROP CONSTRAINT IF EXISTS followed by ADD CONSTRAINT — backward-compatible (existing rows are unaffected).

#### Project Pattern

Follow the pattern in `sql/daily_pmc_values.sql`:
- Use `CREATE TABLE IF NOT EXISTS` (idempotent)
- Use `CREATE INDEX IF NOT EXISTS`
- Use `GRANT SELECT, INSERT, UPDATE` for `anon` and `authenticated` roles
- Use `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` (RLS is disabled project-wide)
- End with `NOTIFY pgrst, 'reload schema'`

#### `activity_decoupling` Table — Exact DDL

```sql
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
```

Note: `activity_id` has a `UNIQUE` constraint (not a composite unique with `athlete_id`) because the upsert conflict target in the recalc layer is `activity_id` alone. This also enforces the 1:1 relationship with `garmin_activities`.

#### `decoupling_baseline` Table — Exact DDL

```sql
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
```

#### `decoupling_trend` Table — Exact DDL

```sql
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
```

#### Indexes to Create

```sql
-- activity_decoupling: date-range queries per athlete and tier
-- (baseline recomputation, trend chart rendering)
CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_tier_date
    ON activity_decoupling (athlete_id, effort_tier, date);

-- activity_decoupling: date-range queries per athlete (all tiers)
CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_date
    ON activity_decoupling (athlete_id, date);

-- decoupling_trend: time-range trend queries
CREATE INDEX IF NOT EXISTS idx_decoupling_trend_athlete_tier_date
    ON decoupling_trend (athlete_id, effort_tier, date);
```

Note: `decoupling_baseline` does not need an additional index — the `UNIQUE (athlete_id, effort_tier)` constraint serves as the primary access index.

#### Access Control

```sql
GRANT SELECT, INSERT, UPDATE ON activity_decoupling TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON decoupling_baseline TO anon, authenticated;
-- decoupling_trend gets DELETE because recalc uses delete-then-insert strategy
GRANT SELECT, INSERT, UPDATE, DELETE ON decoupling_trend TO anon, authenticated;

ALTER TABLE activity_decoupling DISABLE ROW LEVEL SECURITY;
ALTER TABLE decoupling_baseline DISABLE ROW LEVEL SECURITY;
ALTER TABLE decoupling_trend    DISABLE ROW LEVEL SECURITY;
```

#### `athlete_notifications` Constraint Update

```sql
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
```

### Acceptance Criteria

1. Running the migration against a clean Supabase project creates all three tables without errors.
2. Running the migration a second time (idempotent check) produces no errors.
3. `activity_decoupling` has a `UNIQUE` constraint on `activity_id`.
4. `decoupling_baseline` has a `UNIQUE` constraint on `(athlete_id, effort_tier)`.
5. `decoupling_trend` has a `UNIQUE` constraint on `(athlete_id, effort_tier, date)`.
6. All three tables have `DISABLE ROW LEVEL SECURITY`.
7. `anon` and `authenticated` roles have the correct grants (including `DELETE` on `decoupling_trend`).
8. Inserting a row into `athlete_notifications` with `type = 'decoupling_anomaly'` succeeds.
9. Inserting a row into `athlete_notifications` with an invalid type fails with a CHECK constraint error.
10. The file ends with `NOTIFY pgrst, 'reload schema';`

### Dependencies

The following must exist before running this migration:
- `athletes` table (from `sql/daily_pmc_values.sql`)
- `garmin_activities` table (from `001_garmin_tables.sql`)
- `athlete_notifications` table (from `athlete_notifications.sql`)

This ticket has no code dependencies and can run in parallel with DEC-001.

### Do Not Do

- Do NOT create the `athletes` table (already exists)
- Do NOT insert the placeholder athlete row (already inserted by `daily_pmc_values.sql`)
- Do NOT add any foreign key from `activity_decoupling` to `garmin_activities` — the `activity_id TEXT` column is a soft reference, consistent with how the rest of the codebase handles this relationship
- Do NOT add any columns beyond what is specified above
- Do NOT implement any triggers, stored procedures, or RLS policies

---

## Ticket 3 — DEC-003: Supabase I/O Layer

### Objective

Implement `lib/decouplingRecalc.ts`: the Supabase I/O layer that fetches laps and activity metadata, resolves HR zone thresholds, calls the pure `computeDecoupling()` function from DEC-001, and upserts results into `activity_decoupling`. Also implement `computeActivityDecouplingBatch()` as the top-level entry point for post-sync processing.

### Files to Create / Modify

- **Create:** `lib/decouplingRecalc.ts`

### Context

#### Architecture

This file follows the exact same two-layer pattern as `lib/pmcRecalc.ts`:
- All Supabase calls live here; none in the pure library
- Error handling: every public async function wraps its body in try/catch and returns `{ ok: false, error: e?.message ?? 'Unknown error' }` on failure — no exceptions propagate to callers
- The placeholder athlete ID `'00000000-0000-0000-0000-000000000001'` matches what `pmcRecalc.ts` uses

This file runs client-side in the React Native/Expo runtime. It reads HR zone configuration from `AsyncStorage` and calls Supabase directly using the anon key. There is no server-side component.

#### Required Imports

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
```

Note: `lib/hrZones.ts` and `lib/lthr.ts` already exist in the codebase. Do not modify them.

#### Module-Level Constants

```typescript
/** Placeholder athlete ID (matches pmcRecalc.ts) */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Minimum qualifying runs per tier before baseline is established */
const BASELINE_MIN_RUNS = 20;

/** Number of days for the rolling trend lookback */
const TREND_LOOKBACK_DAYS = 90;

/** Number of days for the rolling average window */
const ROLLING_WINDOW_DAYS = 30;
```

#### Function: `resolveHRZoneThresholds(): Promise<HRZoneThresholds | null>`

This function loads HR zone thresholds from available sources in priority order. The result is used to classify each activity's effort tier.

```typescript
export async function resolveHRZoneThresholds(): Promise<HRZoneThresholds | null>
```

Resolution priority chain:

**Priority 1: `loadHRZones()` from AsyncStorage (key `hr_zones_v1`)**
- Returns `HRZones`: an array of zone objects with `{ min, max }` fields
- Extract: `hrz_3_min = zones[2].min` (zone 3 lower bound), `hrz_4_min = zones[3].min` (zone 4 lower bound)
- Return `{ hrz_3_min, hrz_4_min }` if successful

**Priority 2: `loadLTHR()` fallback**
- Call `loadLTHR()` — returns LTHR in bpm or null
- If LTHR available, estimate zone thresholds using standard percentages:
  - `hrz_3_min = Math.round(lthr * 0.82)` (zone 3 starts at ~82% LTHR)
  - `hrz_4_min = Math.round(lthr * 0.90)` (zone 4 starts at ~90% LTHR)
- Return `{ hrz_3_min, hrz_4_min }`

**Priority 3: Garmin laps HR zone columns**
- Query the `garmin_activity_laps` table for `hrz_3_hr` and `hrz_4_hr` from the most recent lap that has these values:
  ```typescript
  const { data } = await supabase
    .from('garmin_activity_laps')
    .select('hrz_3_hr, hrz_4_hr')
    .not('hrz_3_hr', 'is', null)
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();
  ```
- If found: return `{ hrz_3_min: data.hrz_3_hr, hrz_4_min: data.hrz_4_hr }`

**Priority 4: Default to 'moderate' — return null**
- If none of the above succeed, return `null`
- The caller (`computeActivityDecoupling`) will default to `effort_tier = 'moderate'` and log a warning

#### Function: `computeActivityDecoupling(activityId): Promise<DecouplingRecalcResult>`

```typescript
export interface DecouplingRecalcResult {
  ok: boolean;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

export async function computeActivityDecoupling(
  activityId: string,
): Promise<DecouplingRecalcResult>
```

**Steps:**

1. Fetch activity metadata from `garmin_activities`:
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

2. Fetch laps from `garmin_activity_laps`, ordered by lap number:
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

3. Resolve HR zone thresholds via `resolveHRZoneThresholds()`.

4. Classify effort tier:
   - If `thresholds === null` OR `activity.avg_hr === null`: use `'moderate'` as default
   - Otherwise: call `classifyEffortTier(activity.avg_hr, thresholds)`

5. Build `DecouplingInput` and call `computeDecoupling(input)`.

6. Map `activity.start_time.slice(0, 10)` to get the `date` string.

7. Upsert result into `activity_decoupling`:
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

8. Return `{ ok: true, skipped: result.skipped, skip_reason: result.skip_reason ?? undefined }`.

**Important:** Upsert even for skipped activities. The skipped row with null decoupling fields and `hr_data_insufficient` flags provides important audit information.

#### Function: `computeActivityDecouplingBatch(activityIds): Promise<BatchDecouplingResult>`

```typescript
export interface BatchDecouplingResult {
  ok: boolean;
  processed: number;
  skipped: number;
  errors: number;
  affected_tiers: EffortTier[];
}

export async function computeActivityDecouplingBatch(
  activityIds: string[],
): Promise<BatchDecouplingResult>
```

**Steps:**

1. Process activities **sequentially** (not in parallel) to avoid overwhelming Supabase.
2. Track `processed` (ok=true), `skipped` (ok=true but skipped=true), `errors` (ok=false), and the set of `affected_tiers` from successful (non-skipped) results.
3. After processing all activities, call `recalculateDecouplingBaseline(affected_tiers)`.
4. After baseline recalculation, call `recalculateDecouplingTrend(affected_tiers)`.
5. Return the batch summary.

If `activityIds` is empty, return `{ ok: true, processed: 0, skipped: 0, errors: 0, affected_tiers: [] }` immediately.

### Acceptance Criteria

1. `computeActivityDecoupling` reads from `garmin_activities` and `garmin_activity_laps` using the exact Supabase query patterns shown above.
2. Upsert uses `onConflict: 'activity_id'` — re-running on the same activity overwrites the existing row.
3. `computeActivityDecouplingBatch` processes activities sequentially.
4. `computeActivityDecouplingBatch` calls `recalculateDecouplingBaseline` and `recalculateDecouplingTrend` after the batch (not per-activity).
5. Every exported async function returns `{ ok: false, error: ... }` on exception — no unhandled rejections.
6. `resolveHRZoneThresholds` follows the four-priority chain in order: AsyncStorage -> LTHR -> Garmin laps -> null.
7. When `resolveHRZoneThresholds` returns null, `computeActivityDecoupling` defaults effort tier to `'moderate'`.

### Dependencies

- **DEC-001** must be complete: `lib/decoupling.ts` must export `computeDecoupling`, `classifyEffortTier`, `computeBaseline`, `computeRollingTrend`, and all types used in the imports block.
- **DEC-002** must be complete: the `activity_decoupling`, `decoupling_baseline`, and `decoupling_trend` tables must exist in the database before this code can upsert to them.

### Do Not Do

- Do NOT implement `recalculateDecouplingBaseline` or `recalculateDecouplingTrend` in this ticket (those are DEC-004 and DEC-005 respectively) — but DO call them from `computeActivityDecouplingBatch`. Stub them as empty async functions returning `{ ok: true }` if DEC-004/DEC-005 are not yet complete.
- Do NOT implement `backfillDecouplingWithGAP` (that is DEC-006)
- Do NOT modify `lib/hrZones.ts` or `lib/lthr.ts`
- Do NOT run baseline or trend recalculation per-activity — only once after the full batch

---

## Ticket 4 — DEC-004: Personal Baseline & Deviation Flagging

### Objective

Implement `recalculateDecouplingBaseline()` in `lib/decouplingRecalc.ts`: fetch all qualifying decoupling values per effort tier, compute statistical baselines using `computeBaseline()` from `lib/decoupling.ts`, upsert the results into `decoupling_baseline`, and insert anomaly notifications into `athlete_notifications` when a newly computed activity falls outside the 2-standard-deviation range.

### Files to Create / Modify

- **Modify:** `lib/decouplingRecalc.ts` — implement `recalculateDecouplingBaseline()`; also add `computeBaseline` to the import from `./decoupling` if not already present

### Context

#### What This Function Does

After each batch of activities is processed, the baseline job:
1. For each effort tier, fetches all historical decoupling values for the athlete
2. Computes mean, standard deviation, and 2-sigma bounds
3. Upserts into `decoupling_baseline`
4. Checks the most recent activity against the bounds, and inserts a notification if it falls outside

This job runs ONCE after the full batch (not per-activity). It is called by `computeActivityDecouplingBatch()` in DEC-003.

#### Function Signature

```typescript
export interface BaselineRecalcResult {
  ok: boolean;
  tiers_updated: number;
  anomalies_flagged: number;
  error?: string;
}

export async function recalculateDecouplingBaseline(
  tiers?: EffortTier[],
): Promise<BaselineRecalcResult>
```

- `tiers` defaults to `['easy', 'moderate', 'hard']` if not specified
- Process each tier independently

#### Step-by-Step Implementation

**Step 1: Fetch qualifying decoupling values for this tier**

```typescript
const { data: rows, error } = await supabase
  .from('activity_decoupling')
  .select('decoupling_pct, date, activity_id')
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('effort_tier', tier)
  .not('decoupling_pct', 'is', null)
  .order('date', { ascending: true });
```

"Qualifying" means: `decoupling_pct IS NOT NULL`. The `hr_data_insufficient` flag does not need separate filtering here because those rows already have `decoupling_pct = null` (set to null by the computation when skipped).

**Step 2: Extract decoupling values and call `computeBaseline()`**

```typescript
const values = rows.map(r => r.decoupling_pct as number);
const baseline = computeBaseline(values);
```

`computeBaseline` is the pure function from `lib/decoupling.ts`. It returns `BaselineResult` with: `n_qualifying_runs`, `mean_decoupling_pct`, `stdev_decoupling_pct`, `lower_bound`, `upper_bound`, `is_established`.

**Step 3: Upsert into `decoupling_baseline`**

```typescript
const { error: upsertErr } = await supabase
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

**Step 4: Anomaly detection (only when baseline is established)**

If `baseline.is_established === false`, skip this step.

Get the most recent activity's decoupling value:
```typescript
const mostRecent = rows[rows.length - 1]; // rows are sorted by date ascending
```

Check if it falls outside the 2-sigma bounds:
```typescript
const isAnomaly =
  mostRecent.decoupling_pct > baseline.upper_bound ||
  mostRecent.decoupling_pct < baseline.lower_bound;
```

If `isAnomaly === true`, insert a notification:
```typescript
const { error: notifErr } = await supabase
  .from('athlete_notifications')
  .insert({
    athlete_id: SINGLE_ATHLETE_ID,
    sport: 'running',
    type: 'decoupling_anomaly',
    message: `Unusual decoupling on ${mostRecent.date}: ${mostRecent.decoupling_pct.toFixed(1)}% ` +
      `(${tier} tier baseline: ${baseline.mean_decoupling_pct.toFixed(1)}% ` +
      `+/- ${(2 * baseline.stdev_decoupling_pct).toFixed(1)}%)`,
    is_read: false,
  });
```

**Important:** Only flag the MOST RECENT activity after baseline recomputation — do NOT retroactively flag historical activities. The rationale is that old anomalies are historical record; only new anomalies require user attention.

#### Statistical Background

The `computeBaseline` pure function (implemented in DEC-001) uses POPULATION standard deviation:

```typescript
function populationStdev(values: number[], mean: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sumSqDiff = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(sumSqDiff / n);
}
```

This is divide-by-N (not N-1). Rationale: the athlete's entire history of qualifying runs for that tier IS the population (not a sample). Population stdev produces tighter bounds, which makes anomaly detection more sensitive — appropriate for personal baselines where we want to catch true deviations from established patterns.

Bounds: `lower_bound = mean - 2 * stdev`, `upper_bound = mean + 2 * stdev`. Using 2 standard deviations captures approximately 95% of the distribution under normality; values outside this range are flagged as anomalies.

#### `is_established` Threshold

`is_established = true` only when `n_qualifying_runs >= 20`. The number 20 is stored as `BASELINE_MIN_RUNS` constant in `decouplingRecalc.ts`. Do not hard-code it; use the constant.

#### Error Handling Pattern

Follow the `pmcRecalc.ts` pattern — wrap the full function body in try/catch:

```typescript
export async function recalculateDecouplingBaseline(
  tiers: EffortTier[] = ['easy', 'moderate', 'hard'],
): Promise<BaselineRecalcResult> {
  try {
    let tiers_updated = 0;
    let anomalies_flagged = 0;

    for (const tier of tiers) {
      // ... per-tier logic ...
    }

    return { ok: true, tiers_updated, anomalies_flagged };
  } catch (e: any) {
    return { ok: false, tiers_updated: 0, anomalies_flagged: 0, error: e?.message ?? 'Unknown error' };
  }
}
```

### Acceptance Criteria

1. `recalculateDecouplingBaseline()` processes each of the three tiers: `'easy'`, `'moderate'`, `'hard'`.
2. When called with a specific `tiers` argument, only those tiers are processed.
3. When `n_qualifying_runs < 20`, upserts `is_established = false` and skips anomaly detection.
4. When `n_qualifying_runs >= 20`, upserts `is_established = true` and performs anomaly detection.
5. Only the most recent activity (by date) is checked for anomaly flagging — historical activities are not re-evaluated.
6. An anomaly notification is inserted into `athlete_notifications` with `type = 'decoupling_anomaly'` when the most recent `decoupling_pct` falls outside `[lower_bound, upper_bound]`.
7. No notification is inserted when the most recent value is within bounds.
8. No notification is inserted when `is_established = false`.
9. `tiers_updated` in the return value equals the number of tiers for which a baseline row was upserted.
10. `anomalies_flagged` equals the number of tiers for which an anomaly notification was inserted.
11. On any error, returns `{ ok: false, error: <message> }` without throwing.

### Dependencies

- **DEC-001** must be complete: `computeBaseline()` must be exported from `lib/decoupling.ts`
- **DEC-002** must be complete: `decoupling_baseline` and `athlete_notifications` tables must exist
- **DEC-003** must be complete: `lib/decouplingRecalc.ts` must exist with the module constants and `SINGLE_ATHLETE_ID`; `recalculateDecouplingBaseline` is called by `computeActivityDecouplingBatch` from DEC-003

### Do Not Do

- Do NOT implement `recalculateDecouplingTrend` (that is DEC-005)
- Do NOT retroactively flag historical activities — only check the most recent row
- Do NOT compute the baseline statistics yourself — call `computeBaseline()` from `lib/decoupling.ts`
- Do NOT create new notification infrastructure — insert directly into the existing `athlete_notifications` table
- Do NOT add the `'decoupling_anomaly'` type to the CHECK constraint — that is done in DEC-002

---

## Ticket 5 — DEC-005: Rolling Trend Computation

### Objective

Implement `recalculateDecouplingTrend()` in `lib/decouplingRecalc.ts`: fetch qualifying decoupling values from the last 90 days, compute 30-day rolling averages for each effort tier, and write the results to `decoupling_trend` using a delete-then-insert strategy. This function is called after baseline recalculation in `computeActivityDecouplingBatch`.

### Files to Create / Modify

- **Modify:** `lib/decouplingRecalc.ts` — implement `recalculateDecouplingTrend()`; also add `computeRollingTrend` to the import from `./decoupling` if not already present

### Context

#### What This Function Does

The rolling trend tracks how an athlete's aerobic decoupling is changing over time. A falling trend on easy runs means the aerobic system is improving (HR drifts less for the same pace). The 30-day rolling average smooths out day-to-day variation.

The job:
1. Fetches all qualifying activity decoupling rows from the last 90 days
2. For each effort tier, calls `computeRollingTrend()` (pure function from DEC-001)
3. Deletes existing trend rows for that tier in the lookback window (fresh recalc)
4. Inserts the new trend data in batches of 500

This runs ONCE after the full batch (called by `computeActivityDecouplingBatch` in DEC-003).

#### Function Signature

```typescript
export interface TrendRecalcResult {
  ok: boolean;
  rows_upserted: number;
  error?: string;
}

export async function recalculateDecouplingTrend(
  tiers?: EffortTier[],
): Promise<TrendRecalcResult>
```

- `tiers` defaults to `['easy', 'moderate', 'hard']` if not specified

#### Step-by-Step Implementation

**Step 1: Compute lookback start date**

```typescript
const lookbackStart = new Date();
lookbackStart.setUTCDate(lookbackStart.getUTCDate() - TREND_LOOKBACK_DAYS);
const lookbackStartStr = lookbackStart.toISOString().slice(0, 10);
```

`TREND_LOOKBACK_DAYS = 90` (module constant from DEC-003).

**Step 2: Fetch all qualifying decoupling rows in the lookback window**

```typescript
const { data: rows, error } = await supabase
  .from('activity_decoupling')
  .select('date, decoupling_pct, effort_tier')
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .gte('date', lookbackStartStr)
  .not('decoupling_pct', 'is', null)
  .order('date', { ascending: true });

if (error) throw error;
```

Fetch all three tiers in a single query (do not make one query per tier).

**Step 3: Process each tier**

For each tier in the `tiers` argument:

3a. Filter the rows for this tier:
```typescript
const tierRows = (rows ?? [])
  .filter(r => r.effort_tier === tier)
  .map(r => ({ date: r.date as string, decoupling_pct: r.decoupling_pct as number }));
```

3b. Call `computeRollingTrend()` from `lib/decoupling.ts`:
```typescript
const trendEntries = computeRollingTrend(tierRows, TREND_LOOKBACK_DAYS);
```

3c. Delete existing trend rows for this tier in the lookback window:
```typescript
await supabase
  .from('decoupling_trend')
  .delete()
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('effort_tier', tier)
  .gte('date', lookbackStartStr);
```

3d. Insert the new trend data in batches of 500:
```typescript
const insertRows = trendEntries.map(e => ({
  athlete_id: SINGLE_ATHLETE_ID,
  effort_tier: tier,
  date: e.date,
  rolling_30d_mean: e.rolling_30d_mean,
  n_activities: e.n_activities,
}));

const BATCH = 500;
for (let i = 0; i < insertRows.length; i += BATCH) {
  const chunk = insertRows.slice(i, i + BATCH);
  const { error: insertErr } = await supabase
    .from('decoupling_trend')
    .insert(chunk);
  if (insertErr) throw insertErr;
}
```

**Step 4: Track total rows inserted and return**

Sum `insertRows.length` across all tiers to produce `rows_upserted`.

#### Why Delete-Then-Insert (Not Upsert)?

The `decoupling_trend` table stores one row per (athlete, tier, date). The recalc strategy is delete-then-insert because:
- The 90-day lookback means we only want rows in that window
- Old rows outside the window (e.g., 120 days ago) would never be touched by an upsert and would accumulate indefinitely
- Delete-then-insert is safe because the pure function always recomputes the full 90-day window

This is why `decoupling_trend` has DELETE permission granted to `anon`/`authenticated` (set in DEC-002), while `activity_decoupling` and `decoupling_baseline` do not.

#### Rolling Trend Algorithm (what `computeRollingTrend` does)

For reference, this is the algorithm implemented in DEC-001 that you are calling here:

```
For each unique date in entries (that falls within lookback_start to today):
  window_start = date - 30 days
  window_entries = entries where date > window_start AND date <= current_date
  rolling_30d_mean = mean(window_entries.decoupling_pct)
  n_activities = window_entries.length
  Emit TrendEntry { date, rolling_30d_mean, n_activities }
```

Only dates with at least one qualifying activity in their 30-day trailing window emit a row. Days with no activities in the window are not stored (sparse representation — the UI interpolates).

#### Error Handling Pattern

Wrap the full function body in try/catch (same as all other functions in `decouplingRecalc.ts`):

```typescript
export async function recalculateDecouplingTrend(
  tiers: EffortTier[] = ['easy', 'moderate', 'hard'],
): Promise<TrendRecalcResult> {
  try {
    // ... implementation ...
    return { ok: true, rows_upserted: totalRowsInserted };
  } catch (e: any) {
    return { ok: false, rows_upserted: 0, error: e?.message ?? 'Unknown error' };
  }
}
```

### Acceptance Criteria

1. `recalculateDecouplingTrend()` fetches all qualifying decoupling rows from the last 90 days in a single Supabase query.
2. For each tier, it deletes existing trend rows in the lookback window BEFORE inserting new ones.
3. Insert is performed in batches of 500 rows (batch size must match the constant, not hard-coded).
4. If `computeRollingTrend()` returns an empty array for a tier (no qualifying activities in the window), the delete step runs but no rows are inserted for that tier.
5. When called with `tiers = ['easy']`, only the easy tier's rows are deleted and reinserted — the moderate and hard tiers are untouched.
6. `rows_upserted` in the return value equals the total number of rows inserted across all tiers.
7. On any error (including Supabase errors during delete or insert), returns `{ ok: false, error: <message> }` without throwing.
8. The lookback start date is computed using UTC (not local time) to avoid DST-related off-by-one errors. Use `setUTCDate` and `toISOString().slice(0, 10)`.

### Dependencies

- **DEC-001** must be complete: `computeRollingTrend()` must be exported from `lib/decoupling.ts`
- **DEC-002** must be complete: `decoupling_trend` table must exist with DELETE permission granted
- **DEC-003** must be complete: `lib/decouplingRecalc.ts` must exist with `SINGLE_ATHLETE_ID`, `TREND_LOOKBACK_DAYS` constants, and the Supabase import

DEC-004 and DEC-005 can be implemented in parallel — they are independent of each other.

### Do Not Do

- Do NOT use upsert for `decoupling_trend` — use delete-then-insert
- Do NOT make one Supabase fetch query per tier — fetch all tiers in a single query and split in TypeScript
- Do NOT compute the rolling averages yourself — call `computeRollingTrend()` from `lib/decoupling.ts`
- Do NOT process all 90 days (most will have no data) — `computeRollingTrend` only emits rows for dates with qualifying data, which is what gets inserted
- Do NOT delete rows outside the lookback window — the `.gte('date', lookbackStartStr)` clause in the delete ensures only the window is affected

---

## Ticket 6 — DEC-006: Sync Pipeline Integration & GAP Backfill Stub

### Objective

Wire `computeActivityDecouplingBatch()` into the post-sync pipeline immediately after `recalculateAllSports()`, and implement the GAP backfill stub `backfillDecouplingWithGAP()` so that the Section 6 (Grade Adjusted Pace) integration point exists and is documented — but throws a `NotImplementedError` until Section 6 ships.

### Files to Create / Modify

- **Modify:** The file that currently calls `recalculateAllSports()` after a Garmin sync — find this file and add the decoupling call after it. (Locate by searching for `recalculateAllSports` in the codebase.)
- **Modify:** `lib/decouplingRecalc.ts` — add `backfillDecouplingWithGAP()` stub

### Context

#### Finding the Sync Trigger

The post-sync orchestration lives wherever `recalculateAllSports()` is called. The implementation there currently looks like:

```typescript
// Step 1: Existing PMC pipeline
await recalculateAllSports();
```

You need to extend it to:

```typescript
// Step 1: Existing PMC pipeline
await recalculateAllSports();

// Step 2: NEW -- Decoupling pipeline for new/updated activities
const decResult = await computeActivityDecouplingBatch(newActivityIds);
if (!decResult.ok) {
  console.warn('[Sync] Decoupling batch failed:', decResult);
}
```

`newActivityIds` comes from the sync response — the IDs of activities that were newly synced or updated. How these IDs are obtained depends on the sync implementation at that call site. Adapt to the existing pattern: if the sync returns a list of new activity IDs, pass them; if not, query `garmin_activities` for activities updated in the last 24 hours as a fallback.

**Fallback query for new activity IDs (if sync response does not provide them):**

```typescript
const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const { data: recentActivities } = await supabase
  .from('garmin_activities')
  .select('activity_id')
  .gte('start_time', yesterday.toISOString().slice(0, 10));

const newActivityIds = (recentActivities ?? []).map(a => a.activity_id);
```

#### Required Import Addition

In the file that calls `recalculateAllSports()`, add the import for `computeActivityDecouplingBatch`:

```typescript
import { computeActivityDecouplingBatch } from './lib/decouplingRecalc';
// or, if using a relative path from the sync file's location, adjust accordingly
```

#### GAP Backfill Stub

Add this function to `lib/decouplingRecalc.ts`:

```typescript
/**
 * Backfill aerobic decoupling using GAP (Grade Adjusted Pace) once Section 6 ships.
 *
 * Design:
 *   1. Query all activity_decoupling rows where awaiting_gap = true
 *   2. For each, fetch GAP-adjusted speeds from the Section 6 output
 *      (exact table/column TBD by Section 6 implementation)
 *   3. Re-run computeDecoupling() using GAP-adjusted speed values in LapRecord
 *      (the pure function is agnostic to whether speed is flat or grade-adjusted)
 *   4. Upsert updated row with gap_used = true, awaiting_gap = false
 *
 * The computeDecoupling() function does NOT need to change for GAP support.
 * The caller simply provides GAP-adjusted distance values in LapRecord objects,
 * and the function computes speed_mps = distance_km * 1000 / moving_time_seconds
 * as usual — the GAP adjustment is transparent.
 *
 * @throws NotImplementedError — stub only; fill in body when Section 6 is complete.
 */
export async function backfillDecouplingWithGAP(): Promise<{ ok: boolean; error?: string }> {
  throw new Error(
    'NotImplementedError: backfillDecouplingWithGAP() is a stub. ' +
    'Implement when Section 6 (Grade Adjusted Pace) is complete. ' +
    'See docs/output/section-5-tech-design.md §7.2 for the integration contract.'
  );
}
```

**Why this stub matters:** Section 6 will implement GAP. When it does, the engineer implementing Section 6 integration can fill in `backfillDecouplingWithGAP()` without needing to modify any other part of `lib/decouplingRecalc.ts`. The `awaiting_gap = true` rows in `activity_decoupling` are the work queue; the stub is the entry point for that work.

#### Expected Sync Call Order After This Ticket

After DEC-006 is complete, the full post-sync sequence is:

```typescript
// Step 1: PMC (existing)
await recalculateAllSports();

// Step 2: Decoupling per-activity + baseline + trend (new)
const decResult = await computeActivityDecouplingBatch(newActivityIds);

// Steps 3 and 4 happen inside computeActivityDecouplingBatch:
//   - recalculateDecouplingBaseline(affected_tiers)
//   - recalculateDecouplingTrend(affected_tiers)
```

#### Idempotency

The decoupling pipeline is idempotent. Re-running `computeActivityDecouplingBatch` with the same activity IDs will upsert the same values (no side effects beyond overwriting the existing row). The baseline and trend recalculations are also safe to re-run.

### Acceptance Criteria

1. After a Garmin sync, `computeActivityDecouplingBatch` is called with the new/updated activity IDs.
2. The decoupling batch call occurs AFTER `recalculateAllSports()` completes.
3. Errors from `computeActivityDecouplingBatch` are logged as warnings but do NOT crash the sync pipeline — the sync must complete even if decoupling computation fails.
4. `backfillDecouplingWithGAP()` exists in `lib/decouplingRecalc.ts` and is exported.
5. Calling `backfillDecouplingWithGAP()` throws an error with the message `'NotImplementedError: ...'`.
6. The JSDoc comment on `backfillDecouplingWithGAP()` accurately describes the integration contract for the Section 6 implementer.
7. No existing sync functionality is broken — the only change to the sync pipeline is the addition of the decoupling batch call after `recalculateAllSports()`.

### Dependencies

- **DEC-003** must be complete: `computeActivityDecouplingBatch` must be exported from `lib/decouplingRecalc.ts`
- **DEC-004** must be complete: `recalculateDecouplingBaseline` must be implemented in `lib/decouplingRecalc.ts`
- **DEC-005** must be complete: `recalculateDecouplingTrend` must be implemented in `lib/decouplingRecalc.ts`

### Do Not Do

- Do NOT implement the GAP calculation itself — that is Section 6's responsibility
- Do NOT fill in the body of `backfillDecouplingWithGAP()` — it must remain a throwing stub
- Do NOT call `recalculateDecouplingBaseline` or `recalculateDecouplingTrend` directly from the sync pipeline — they are called internally by `computeActivityDecouplingBatch`
- Do NOT change the call order: PMC recalculation must still run before decoupling
- Do NOT remove or modify `recalculateAllSports()` — only add after it
