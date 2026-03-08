# Section 6 -- Grade Adjusted Pace (GAP): Technical Design Document

**Author:** Staff Engineer Lead
**Date:** 2026-03-07
**PRD Section:** 6 (Running: Grade Adjusted Pace)
**Status:** Draft -- pending Staff Engineer 2 review

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Database Schema](#3-database-schema)
4. [Calculation Logic (`lib/gap.ts`)](#4-calculation-logic-libgapts)
5. [Recalculation Pipeline (`lib/gapRecalc.ts`)](#5-recalculation-pipeline-libgaprecalcts)
6. [Section 5 Backfill Integration](#6-section-5-backfill-integration)
7. [Type Definitions](#7-type-definitions)
8. [Testing Strategy](#8-testing-strategy)
9. [Tickets](#9-tickets)

---

## 1. Overview

### What This Implements

Section 6 adds Grade Adjusted Pace (GAP) to the analytics pipeline. GAP normalizes running pace for elevation change so that a 6:00/mile effort up a 10% grade reads the same as roughly a 4:20/mile effort on flat ground. This enables fair cross-terrain comparisons and more accurate TSS/intensity calculations for hilly courses.

The implementation uses the Minetti et al. (2002) metabolic cost curve — the foundational biomechanical model for running energy cost at gradient. GAP is computed at lap granularity (the only data level available in Supabase) using `garmin_activity_laps`.

### How It Fits the Codebase

GAP follows the identical two-layer pattern established by PMC (Section 2) and Aerobic Decoupling (Section 5):

| Layer | PMC | Decoupling | GAP |
|---|---|---|---|
| Pure calculation | `lib/pmc.ts` | `lib/decoupling.ts` | `lib/gap.ts` |
| Supabase I/O | `lib/pmcRecalc.ts` | `lib/decouplingRecalc.ts` | `lib/gapRecalc.ts` |
| SQL migration | `sql/daily_pmc_values.sql` | `sql/activity_decoupling.sql` | `sql/activity_gap.sql` |
| Storage tables | `daily_pmc_values` | `activity_decoupling`, `decoupling_baseline`, `decoupling_trend` | `activity_gap`, `lap_gap` |

### Role in the Broader Pipeline

GAP is a prerequisite for Sections 5, 7, and 8. Specifically:

- **Section 5 (Decoupling):** When `gap_used = false` and `awaiting_gap = true`, the decoupling row should be recomputed with GAP-adjusted speed once GAP becomes available. The `backfillDecouplingWithGAP()` stub in `lib/decouplingRecalc.ts` is the integration point.
- **Sections 7 and 8:** Will consume `avg_gap_pace_seconds` from `activity_gap` for intensity factor and TSS calculations.

---

## 2. Architecture

### File Structure

```
lib/
  gap.ts          -- Pure calculation library (Minetti curve, per-lap GAP, activity aggregate)
  gapRecalc.ts    -- Supabase I/O layer (fetch laps, upsert results, trigger Section 5 backfill)

sql/
  activity_gap.sql -- Migration: activity_gap and lap_gap tables

__tests__/
  gap.test.ts     -- Unit tests for all pure functions in lib/gap.ts
```

No new screens or UI components are introduced in Section 6. GAP output is consumed downstream.

### Module Responsibilities

**`lib/gap.ts` (pure — zero I/O)**
- Implements the Minetti polynomial and grade clamping
- Computes per-lap grade from ascent/descent/distance
- Computes per-lap GAP pace from actual pace and grade
- Aggregates per-lap results into an activity-level summary
- Accepts and returns plain TypeScript objects; no imports from Supabase, AsyncStorage, or React Native

**`lib/gapRecalc.ts` (Supabase I/O layer)**
- Reads lap records from `garmin_activity_laps`
- Calls `computeGAP()` from `lib/gap.ts`
- Upserts results into `activity_gap` (one row per activity) and `lap_gap` (one row per lap)
- Updates `garmin_activities.gap_used` flag (or equivalent) to signal GAP availability
- Triggers `backfillDecouplingWithGAP()` for activities where `awaiting_gap = true`

### Data Flow

```
Garmin Sync
  |
  v
garmin_activity_laps  (lap: ascent, descent, distance, moving_time_seconds)
  |
  v
computeGAPForActivity(activityId)   [gapRecalc.ts]
  |  reads: garmin_activity_laps, garmin_activities
  |  writes: lap_gap (upsert per lap), activity_gap (upsert per activity)
  |
  v
backfillDecouplingWithGAP()         [decouplingRecalc.ts -- existing stub]
     reads: activity_decoupling WHERE awaiting_gap = true
     re-runs: computeActivityDecoupling() with GAP-adjusted lap speed
     writes: activity_decoupling (gap_used = true, awaiting_gap = false)
```

### Client-Side Execution

`lib/gapRecalc.ts` runs entirely client-side in the React Native/Expo runtime, using the existing `supabase` singleton from `lib/supabase.ts`. No Supabase Edge Functions are used. This is consistent with `lib/pmcRecalc.ts` and `lib/decouplingRecalc.ts`.

---

## 3. Database Schema

SQL file: `sql/activity_gap.sql`

```sql
-- GAP-006: Grade Adjusted Pace (GAP) Schema Migration
--
-- Creates two tables for Section 6 GAP analytics:
--   activity_gap  – one row per activity: activity-level GAP summary
--   lap_gap       – one row per (activity, lap): per-lap grade and GAP pace
--
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS, DROP CONSTRAINT IF EXISTS).
--
-- Prerequisites:
--   - athletes table must exist (created by daily_pmc_values.sql)
--   - activity_decoupling.sql must have run (adds 'decoupling_anomaly' to notifications)


-- ---------------------------------------------------------------------------
-- activity_gap
-- ---------------------------------------------------------------------------
-- One row per activity. Upsert key: activity_id.
-- Stores activity-level GAP summary computed from lap_gap rows.

CREATE TABLE IF NOT EXISTS activity_gap (
    id                         UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id                 UUID             NOT NULL REFERENCES athletes(id),

    -- Soft reference to garmin_activities (no FK enforced; consistent with activity_decoupling)
    activity_id                TEXT             NOT NULL UNIQUE,

    -- Date of the activity (denormalized for efficient date-range queries)
    date                       DATE             NOT NULL,

    -- Distance-weighted average GAP pace across all laps (sec/km)
    avg_gap_pace_seconds       DOUBLE PRECISION,

    -- Distance-weighted average raw (actual) pace across all laps (sec/km)
    avg_raw_pace_seconds       DOUBLE PRECISION,

    -- Total ascent in meters (sum of lap ascent; NULL if all laps have null ascent)
    total_ascent_m             DOUBLE PRECISION,

    -- Whether GAP was actually applied (false when all grades resolved to 0 due to null data)
    gap_applied                BOOLEAN          NOT NULL DEFAULT false,

    -- Total number of laps processed for this activity
    lap_count                  INTEGER          NOT NULL DEFAULT 0,

    -- Number of laps where grade was clamped to the [-0.40, +0.45] bounds
    laps_grade_clamped         INTEGER          NOT NULL DEFAULT 0,

    -- Audit timestamp
    computed_at                TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Date-range queries per athlete (activity list, downstream consumers)
CREATE INDEX IF NOT EXISTS idx_activity_gap_athlete_date
    ON activity_gap (athlete_id, date);


-- ---------------------------------------------------------------------------
-- lap_gap
-- ---------------------------------------------------------------------------
-- One row per (activity_id, lap). Stores the per-lap inputs and outputs
-- needed to verify and re-derive the activity-level aggregate.

CREATE TABLE IF NOT EXISTS lap_gap (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),

    -- Soft reference to garmin_activities
    activity_id            TEXT             NOT NULL,

    -- Lap number (matches garmin_activity_laps.lap)
    lap                    INTEGER          NOT NULL,

    -- Raw (actual) pace for this lap, seconds per km
    raw_pace_sec_per_km    DOUBLE PRECISION NOT NULL,

    -- GAP-adjusted pace for this lap, seconds per km
    gap_pace_sec_per_km    DOUBLE PRECISION NOT NULL,

    -- Fractional grade used in the Minetti calculation (after clamping)
    grade_fractional       DOUBLE PRECISION NOT NULL,

    -- True if the computed grade was clamped to [-0.40, +0.45]
    grade_clamped          BOOLEAN          NOT NULL DEFAULT false,

    -- Lap distance in km (used to weight the activity-level average)
    distance_km            DOUBLE PRECISION NOT NULL,

    UNIQUE (activity_id, lap)
);

-- Per-activity lookup (fetch all laps for a given activity)
CREATE INDEX IF NOT EXISTS idx_lap_gap_activity_id
    ON lap_gap (activity_id);

-- Per-athlete, per-date lookup (used when querying lap detail for a date range)
CREATE INDEX IF NOT EXISTS idx_lap_gap_athlete_id
    ON lap_gap (athlete_id);


-- ---------------------------------------------------------------------------
-- Access control (RLS disabled -- consistent with all other tables)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON activity_gap TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON lap_gap TO anon, authenticated;

ALTER TABLE activity_gap DISABLE ROW LEVEL SECURITY;
ALTER TABLE lap_gap      DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Extend athlete_notifications CHECK constraint to include 'gap_anomaly'
-- (reserved for future use -- not triggered in Section 6 implementation)
-- ---------------------------------------------------------------------------
-- The constraint was last modified in activity_decoupling.sql. We extend it again
-- here using the same drop-and-recreate pattern for idempotency.

ALTER TABLE athlete_notifications
    DROP CONSTRAINT IF EXISTS athlete_notifications_type_check;

ALTER TABLE athlete_notifications
    ADD CONSTRAINT athlete_notifications_type_check
    CHECK (type IN (
        'personalization_available',
        'model_updated',
        'more_data_needed',
        'decoupling_anomaly',
        'gap_anomaly'
    ));

NOTIFY pgrst, 'reload schema';
```

### Index Strategy Rationale

| Index | Purpose |
|---|---|
| `UNIQUE (activity_id)` on `activity_gap` | 1:1 upsert key; primary lookup by activity |
| `(athlete_id, date)` on `activity_gap` | Date-range queries for downstream sections (7, 8) |
| `UNIQUE (activity_id, lap)` on `lap_gap` | Upsert key; prevents duplicate rows per lap |
| `(activity_id)` on `lap_gap` | Fetch all laps for a given activity (O(laps)) |
| `(athlete_id)` on `lap_gap` | Fetch all lap-level GAP data for an athlete |

Neither table gets DELETE permission because GAP data is always fully overwritten via upsert when recomputed — no partial delete-then-insert pattern is needed (unlike `decoupling_trend`).

---

## 4. Calculation Logic (`lib/gap.ts`)

### 4.1 Constants

```typescript
/** Flat-ground metabolic cost from the Minetti curve: C(0) = 3.6 J/kg/m */
const C_FLAT = 3.6;

/** Minimum fractional grade (clamping lower bound). */
const GRADE_MIN = -0.40;

/** Maximum fractional grade (clamping upper bound). */
const GRADE_MAX = 0.45;
```

### 4.2 Pure Functions

#### `minettiCost(grade: number): number`

```typescript
/**
 * Compute the Minetti metabolic cost of running at a given fractional grade.
 *
 * Source: Minetti et al. (2002), J Appl Physiol 93(3):1039-1046.
 * C(g) = 155.4*g^5 - 30.4*g^4 - 43.3*g^3 + 46.3*g^2 + 19.5*g + 3.6
 *
 * @param grade  Fractional grade (e.g., 0.10 for 10% uphill). Must be pre-clamped
 *               to [-0.40, +0.45] by the caller before passing here.
 * @returns      Metabolic cost in J/kg/m. Always > 0 within the valid clamped range.
 */
export function minettiCost(grade: number): number {
  const g = grade;
  return (
    155.4 * g ** 5 -
    30.4  * g ** 4 -
    43.3  * g ** 3 +
    46.3  * g ** 2 +
    19.5  * g +
    3.6
  );
}
```

**Rationale for pre-clamping contract:** `minettiCost` is a mathematical implementation of the polynomial. It is intentionally kept free of business logic. The caller (`lapGapPace`) is responsible for clamping before calling. This makes each function independently testable and prevents accidental use of the unclamped version in places that bypass the clamping step.

**Verification at key values:**
- `minettiCost(0)` = 3.6 (flat-ground baseline, C_FLAT)
- `minettiCost(0.10)` ≈ 5.26 — a 10% uphill costs ~46% more than flat, so GAP pace is ~31% faster than actual pace (i.e., within the "30-40% faster" range stated in the PRD)
- `minettiCost(-0.10)` ≈ 2.48 — a 10% downhill costs ~31% less than flat, so GAP pace is ~31% slower than actual pace

---

#### `clampGrade(grade: number): { grade: number; clamped: boolean }`

```typescript
/**
 * Clamp a fractional grade to the valid Minetti curve range [-0.40, +0.45].
 *
 * Grades outside this range produce unreliable polynomial results. The clamped
 * boolean signals that the input exceeded the model's tested domain.
 *
 * @param grade  Raw fractional grade computed from lap ascent/descent/distance.
 * @returns      { grade: clamped value, clamped: true if input was out of range }
 */
export function clampGrade(grade: number): { grade: number; clamped: boolean } {
  if (grade < GRADE_MIN) return { grade: GRADE_MIN, clamped: true };
  if (grade > GRADE_MAX) return { grade: GRADE_MAX, clamped: true };
  return { grade, clamped: false };
}
```

---

#### `lapGrade(ascent: number | null, descent: number | null, distanceKm: number): number`

```typescript
/**
 * Compute the fractional grade for a single lap.
 *
 * grade = (ascent - descent) / (distance_km * 1000)
 *
 * NULL ascent or descent resolves to 0 for that term, which is equivalent
 * to assuming flat terrain (grade = 0, GAP = actual pace). This prevents
 * propagation of nulls when GPS elevation data is missing for a lap.
 *
 * @param ascent      Elevation gain in meters (may be null).
 * @param descent     Elevation loss in meters (may be null).
 * @param distanceKm  Lap distance in kilometers. Must be > 0.
 * @returns           Fractional grade (unclamped). Returns 0 if distanceKm <= 0.
 */
export function lapGrade(
  ascent: number | null,
  descent: number | null,
  distanceKm: number,
): number {
  if (distanceKm <= 0) return 0;
  const asc = ascent ?? 0;
  const desc = descent ?? 0;
  return (asc - desc) / (distanceKm * 1000);
}
```

**NULL handling rationale:** Per the PRD: "NULL ascent/descent → grade = 0, GAP = actual pace." Coercing null to 0 for each term individually (rather than returning 0 only when both are null) ensures that partial data (e.g., ascent recorded but descent missing) still produces a meaningful result rather than silently discarding available information.

---

#### `lapGapPace(actualPaceSecPerKm: number, grade: number): number`

```typescript
/**
 * Compute the Grade Adjusted Pace for a single lap.
 *
 * Formula: GAP_pace = actual_pace * (C(0) / C(grade))
 *
 * Where C is the Minetti cost curve and C(0) = 3.6 (flat-ground baseline).
 * Uphill (positive grade) → C(grade) > C(0) → GAP_pace < actual_pace (faster equivalent).
 * Downhill (negative grade) → C(grade) < C(0) → GAP_pace > actual_pace (slower equivalent).
 *
 * @param actualPaceSecPerKm  Actual lap pace in seconds per kilometer.
 * @param grade               Fractional grade. Must be pre-clamped via clampGrade().
 * @returns                   GAP pace in seconds per kilometer, rounded to 2 decimal places.
 */
export function lapGapPace(actualPaceSecPerKm: number, grade: number): number {
  const cost = minettiCost(grade);
  // Guard against degenerate cost values (should not occur within clamped range)
  if (cost <= 0) return actualPaceSecPerKm;
  return round2(actualPaceSecPerKm * (C_FLAT / cost));
}
```

---

#### `computeGAP(laps: GarminLap[]): GAPResult`

```typescript
/**
 * Compute GAP for all laps of an activity and derive the activity-level aggregate.
 *
 * Algorithm for each lap:
 *   1. Compute raw pace: raw_pace_sec_per_km = moving_time_seconds / distance_km
 *   2. Compute fractional grade: lapGrade(ascent, descent, distance_km)
 *   3. Clamp grade: clampGrade(grade)
 *   4. Compute GAP pace: lapGapPace(raw_pace, clamped_grade)
 *   5. Record LapGapResult
 *
 * Activity-level aggregate:
 *   avg_gap_pace_seconds = Σ(gap_pace * distance_km) / Σ(distance_km)
 *   avg_raw_pace_seconds = Σ(raw_pace * distance_km) / Σ(distance_km)
 *   total_ascent_m = Σ(lap.ascent ?? 0)
 *   gap_applied = true if any lap has ascent OR descent that is non-null and non-zero
 *
 * Laps with moving_time_seconds <= 0 or distance_km <= 0 are skipped (no pace defined).
 *
 * @param laps  Array of lap records from garmin_activity_laps. May be empty.
 * @returns     GAPResult containing lapGapResults array and activityGap summary.
 *              Returns null activityGap fields when no valid laps exist.
 */
export function computeGAP(laps: GarminLap[]): GAPResult {
  const lapGapResults: LapGapResult[] = [];
  let totalWeightedGapPace = 0;
  let totalWeightedRawPace = 0;
  let totalDistance = 0;
  let totalAscent = 0;
  let hasElevationData = false;
  let lapsGradeClamped = 0;

  for (const lap of laps) {
    const distanceKm = (lap.distance ?? 0) / 1000;
    const movingTime = lap.moving_time_seconds ?? 0;

    // Skip laps with no valid pace (no distance or no time)
    if (distanceKm <= 0 || movingTime <= 0) continue;

    const rawPace = movingTime / distanceKm;

    const rawGrade = lapGrade(lap.ascent, lap.descent, distanceKm);
    const { grade: clampedGrade, clamped } = clampGrade(rawGrade);
    const gapPace = lapGapPace(rawPace, clampedGrade);

    if (clamped) lapsGradeClamped++;

    // Track whether any lap had real elevation data
    if ((lap.ascent != null && lap.ascent !== 0) || (lap.descent != null && lap.descent !== 0)) {
      hasElevationData = true;
    }

    totalAscent += lap.ascent ?? 0;

    totalWeightedGapPace += gapPace * distanceKm;
    totalWeightedRawPace += rawPace * distanceKm;
    totalDistance += distanceKm;

    lapGapResults.push({
      lap: lap.lap,
      raw_pace_sec_per_km: round2(rawPace),
      gap_pace_sec_per_km: gapPace,
      grade_fractional: round2(clampedGrade),
      grade_clamped: clamped,
      distance_km: round2(distanceKm),
    });
  }

  const activityGap: ActivityGapResult = {
    avg_gap_pace_seconds: totalDistance > 0 ? round2(totalWeightedGapPace / totalDistance) : null,
    avg_raw_pace_seconds: totalDistance > 0 ? round2(totalWeightedRawPace / totalDistance) : null,
    total_ascent_m: round2(totalAscent),
    gap_applied: hasElevationData,
    lap_count: lapGapResults.length,
    laps_grade_clamped: lapsGradeClamped,
  };

  return { lapGapResults, activityGap };
}
```

### 4.3 Algorithm Notes

#### Grade Sign Convention

The formula `(ascent - descent) / distance_m` produces:
- Positive grade for net uphill (ascent > descent)
- Negative grade for net downhill (descent > ascent)
- Zero for flat or loops that return to the same elevation

This matches Minetti's convention where g > 0 is uphill and g < 0 is downhill.

#### Clamping Bounds

The bounds `[-0.40, +0.45]` are asymmetric because:
- Uphill cap at +0.45: above this, runners typically walk (no longer a running-specific model)
- Downhill cap at -0.40: below this, the cost curve starts to rise again (very steep downhills require braking effort). The PRD specifies these bounds explicitly.

#### Activity-Level GAP Decision Rule

Per the PRD: "Default: use GAP when ascent > 100m." This threshold is applied in the **recalc layer** (`gapRecalc.ts`), not in the pure library. The pure `computeGAP()` always returns both raw and GAP-adjusted paces; the decision of which to use downstream is made by the recalc layer when writing the `gap_used` flag to `activity_decoupling`.

#### Rounding

All output pace values are rounded to 2 decimal places using `round2()` (same helper as `lib/decoupling.ts`). Grade is stored rounded to 2 decimal places (sufficient precision for the 0.001 fractional grade resolution of typical GPS data).

---

## 5. Recalculation Pipeline (`lib/gapRecalc.ts`)

### 5.1 Constants

```typescript
import { supabase } from './supabase';
import {
  computeGAP,
  type GarminLap,
  type GAPResult,
  type LapGapResult,
  type ActivityGapResult,
} from './gap';

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Minimum total ascent (meters) for GAP to be considered meaningful. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Batch size for upsert operations (matches pmcRecalc.ts pattern). */
const BATCH_SIZE = 500;
```

### 5.2 Return Type Interfaces

```typescript
export interface GAPRecalcResult {
  ok: boolean;
  activityId?: string;
  gap_applied?: boolean;
  lap_count?: number;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

export interface BatchGAPResult {
  ok: boolean;
  processed: number;
  skipped: number;
  errors: number;
  backfill_triggered: number;
  error?: string;
}
```

### 5.3 Exported Functions

#### `computeGAPForActivity(activityId): Promise<GAPRecalcResult>`

```typescript
/**
 * Fetch lap data for a single activity, compute GAP, and upsert results.
 *
 * Steps:
 *   1. Fetch activity metadata from garmin_activities
 *      (activity_id, start_time, ascent)
 *   2. Fetch lap records from garmin_activity_laps
 *      (lap, moving_time_seconds, distance, ascent, descent)
 *   3. Call computeGAP() (pure function)
 *   4. Upsert all lap results into lap_gap (batch by BATCH_SIZE)
 *   5. Upsert activity summary into activity_gap
 *   6. Return GAPRecalcResult
 *
 * @param activityId  Garmin activity ID (TEXT).
 */
export async function computeGAPForActivity(
  activityId: string,
): Promise<GAPRecalcResult>;
```

**Supabase query for activity metadata:**

```typescript
const { data: actRow, error: actErr } = await supabase
  .from('garmin_activities')
  .select('activity_id, start_time, ascent')
  .eq('activity_id', activityId)
  .maybeSingle();

if (actErr) throw actErr;
if (!actRow) return { ok: false, error: `Activity ${activityId} not found` };
```

**Supabase query for laps:**

```typescript
const { data: lapRows, error: lapErr } = await supabase
  .from('garmin_activity_laps')
  .select('lap, moving_time_seconds, distance, ascent, descent')
  .eq('activity_id', activityId)
  .order('lap', { ascending: true });

if (lapErr) throw lapErr;
```

**Upsert pattern for `lap_gap` (batched):**

```typescript
const lapRows = result.lapGapResults.map((l) => ({
  athlete_id: SINGLE_ATHLETE_ID,
  activity_id: String(actRow.activity_id),
  lap: l.lap,
  raw_pace_sec_per_km: l.raw_pace_sec_per_km,
  gap_pace_sec_per_km: l.gap_pace_sec_per_km,
  grade_fractional: l.grade_fractional,
  grade_clamped: l.grade_clamped,
  distance_km: l.distance_km,
}));

for (let i = 0; i < lapRows.length; i += BATCH_SIZE) {
  const chunk = lapRows.slice(i, i + BATCH_SIZE);
  const { error } = await supabase
    .from('lap_gap')
    .upsert(chunk, { onConflict: 'activity_id,lap' });
  if (error) throw error;
}
```

**Upsert pattern for `activity_gap`:**

```typescript
const { error: actUpsertErr } = await supabase
  .from('activity_gap')
  .upsert({
    athlete_id: SINGLE_ATHLETE_ID,
    activity_id: String(actRow.activity_id),
    date: String(actRow.start_time).slice(0, 10),
    avg_gap_pace_seconds: result.activityGap.avg_gap_pace_seconds,
    avg_raw_pace_seconds: result.activityGap.avg_raw_pace_seconds,
    total_ascent_m: result.activityGap.total_ascent_m,
    gap_applied: result.activityGap.gap_applied,
    lap_count: result.activityGap.lap_count,
    laps_grade_clamped: result.activityGap.laps_grade_clamped,
  }, { onConflict: 'activity_id' });

if (actUpsertErr) throw actUpsertErr;
```

---

#### `computeGAPBatch(activityIds): Promise<BatchGAPResult>`

```typescript
/**
 * Compute and persist GAP for a list of activities, then trigger Section 5 backfill.
 *
 * This is the primary entry point called after a Garmin sync. Processes
 * activities sequentially to avoid overwhelming Supabase with concurrent upserts.
 *
 * After all activities are processed, calls triggerDecouplingBackfill() to
 * recompute decoupling for any activities that were awaiting GAP data.
 *
 * @param activityIds  Array of Garmin activity IDs (TEXT) to process.
 */
export async function computeGAPBatch(
  activityIds: string[],
): Promise<BatchGAPResult>;
```

**Implementation pattern:**

```typescript
export async function computeGAPBatch(
  activityIds: string[],
): Promise<BatchGAPResult> {
  if (activityIds.length === 0) {
    return { ok: true, processed: 0, skipped: 0, errors: 0, backfill_triggered: 0 };
  }

  try {
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const id of activityIds) {
      const result = await computeGAPForActivity(id);
      if (!result.ok) {
        errors++;
      } else if (result.skipped) {
        skipped++;
      } else {
        processed++;
      }
    }

    // Trigger Section 5 backfill after all GAP rows are persisted
    const backfillResult = await triggerDecouplingBackfill();
    const backfill_triggered = backfillResult.ok ? (backfillResult.count ?? 0) : 0;

    return { ok: true, processed, skipped, errors, backfill_triggered };
  } catch (e: any) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: 0,
      backfill_triggered: 0,
      error: e?.message ?? 'Unknown error',
    };
  }
}
```

---

#### `triggerDecouplingBackfill(): Promise<{ ok: boolean; count?: number; error?: string }>`

```typescript
/**
 * Find all activities with awaiting_gap = true in activity_decoupling and
 * re-run decoupling computation with GAP-adjusted speed.
 *
 * Delegates to backfillDecouplingWithGAP() from lib/decouplingRecalc.ts.
 * That function is responsible for fetching the awaiting_gap rows, pulling
 * GAP-adjusted speeds from lap_gap, and re-running computeActivityDecoupling().
 *
 * @returns ok: true with count of activities backfilled on success.
 */
export async function triggerDecouplingBackfill(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}>;
```

See Section 6 for the full backfill contract.

### 5.4 Error Handling

Follows the `pmcRecalc.ts` pattern exactly: every exported async function wraps its entire body in a `try/catch` and returns `{ ok: false, error: e?.message ?? 'Unknown error' }` on failure. No exceptions propagate to callers.

---

## 6. Section 5 Backfill Integration

### Context

The `backfillDecouplingWithGAP()` function in `lib/decouplingRecalc.ts` is currently a stub (throws `NotImplementedError`). Section 6 must implement it.

The contract defined in `docs/output/section-5-tech-design.md` (§7.2) is:

> 1. Backfill GAP-adjusted speeds into the laps or a separate column
> 2. Query all `activity_decoupling` rows where `awaiting_gap = true`
> 3. Re-run `computeActivityDecoupling()` for each, this time using GAP-adjusted speed
> 4. Set `gap_used = true`, `awaiting_gap = false` on the re-computed rows

### Implementation Approach

The pure `computeDecoupling()` function in `lib/decoupling.ts` is agnostic to whether speed is flat or grade-adjusted — it accepts `LapRecord` objects and computes EF from speed. To inject GAP-adjusted speed:

1. Fetch `activity_decoupling` rows where `awaiting_gap = true`
2. For each activity ID, check whether `activity_gap` row exists with `gap_applied = true` AND `total_ascent_m > GAP_ASCENT_THRESHOLD_M` (100m). Only these activities should use GAP.
3. Fetch `lap_gap` rows for the activity to get `gap_pace_sec_per_km` per lap
4. Construct synthetic `LapRecord` objects where `distance` is recalculated to represent the GAP-equivalent distance:
   - GAP-equivalent distance: `distance_km * (raw_pace / gap_pace)` — this scales distance such that EF (speed/HR) reflects GAP speed
   - Alternatively, directly replace the speed in the EF calculation by setting `distance` to the value that produces the correct GAP speed: `distance_m = gap_pace_sec_per_km == 0 ? 0 : (moving_time_seconds / gap_pace_sec_per_km) * 1000`
5. Re-run `computeActivityDecoupling()` with the synthetic laps
6. Update `activity_decoupling`: set `gap_used = true`, `awaiting_gap = false`

**Implementation note on synthetic laps:** The cleanest approach is to transform the existing `LapRecord` objects so that `distance` (in meters) reflects GAP-adjusted distance. Since speed = distance / time, replacing distance with `(moving_time_seconds / gap_pace_sec_per_km) * 1000` produces the correct GAP speed for EF computation without changing the time dimension. This is equivalent to asking: "what flat-ground distance would an athlete have covered in the same time at the GAP-equivalent effort?"

### Backfill Function Signature

```typescript
// In lib/decouplingRecalc.ts (replaces the existing stub)

/**
 * Backfill decoupling calculations using Grade Adjusted Pace.
 *
 * Queries all activity_decoupling rows where awaiting_gap = true.
 * For each, fetches GAP data from lap_gap, constructs GAP-adjusted LapRecords,
 * and re-runs computeDecoupling(). Only applies GAP when the activity has
 * gap_applied = true in activity_gap (i.e., real elevation data was available).
 *
 * Sets gap_used = true, awaiting_gap = false on completion.
 *
 * @returns ok: true with count of activities reprocessed.
 */
export async function backfillDecouplingWithGAP(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}>;
```

### Threshold Rule for GAP Application

Per the PRD: "Default: use GAP when ascent > 100m."

Checked in `backfillDecouplingWithGAP()`:

```typescript
// Only apply GAP if total ascent exceeds the threshold
const useGap = (gapRow?.total_ascent_m ?? 0) > GAP_ASCENT_THRESHOLD_M
            && gapRow?.gap_applied === true;
```

When `useGap = false`:
- Re-run `computeDecoupling()` with the **original unmodified** laps (raw speed)
- Set `gap_used = false`, `awaiting_gap = false` (GAP was evaluated but not needed)

When `useGap = true`:
- Re-run `computeDecoupling()` with **GAP-adjusted** synthetic laps
- Set `gap_used = true`, `awaiting_gap = false`

In both cases, `awaiting_gap` is cleared to `false` so the activity is not reprocessed on subsequent backfill runs.

---

## 7. Type Definitions

All types live in `lib/gap.ts`.

```typescript
/**
 * A lap record from garmin_activity_laps.
 * Field names match the database column names exactly.
 */
export interface GarminLap {
  /** Lap number (0-indexed, matches garmin_activity_laps.lap) */
  lap: number;
  /** Lap moving time in seconds (null = paused/invalid lap) */
  moving_time_seconds: number | null;
  /** Lap distance in meters (null = no distance data) */
  distance: number | null;
  /** Elevation gain in meters for this lap (null = no GPS elevation) */
  ascent: number | null;
  /** Elevation loss in meters for this lap (null = no GPS elevation) */
  descent: number | null;
}

/**
 * Per-lap GAP computation result.
 * Maps directly to the lap_gap table columns.
 */
export interface LapGapResult {
  /** Lap number */
  lap: number;
  /** Actual (raw) pace for this lap, seconds per km */
  raw_pace_sec_per_km: number;
  /** Grade Adjusted Pace for this lap, seconds per km */
  gap_pace_sec_per_km: number;
  /** Fractional grade used in the Minetti calculation (after clamping) */
  grade_fractional: number;
  /** True if the computed grade exceeded [-0.40, +0.45] and was clamped */
  grade_clamped: boolean;
  /** Lap distance in km (used for activity-level weighted average) */
  distance_km: number;
}

/**
 * Activity-level GAP summary.
 * Maps directly to the activity_gap table columns.
 */
export interface ActivityGapResult {
  /** Distance-weighted average GAP pace across all valid laps (sec/km). Null if no valid laps. */
  avg_gap_pace_seconds: number | null;
  /** Distance-weighted average raw pace across all valid laps (sec/km). Null if no valid laps. */
  avg_raw_pace_seconds: number | null;
  /** Total ascent in meters across all laps (0 if all null) */
  total_ascent_m: number;
  /**
   * True if at least one lap had non-null, non-zero elevation data.
   * When false, all grades resolved to 0 and GAP equals raw pace for every lap.
   */
  gap_applied: boolean;
  /** Number of valid laps processed (laps with distance > 0 and moving_time > 0) */
  lap_count: number;
  /** Number of laps where the computed grade was clamped to [-0.40, +0.45] */
  laps_grade_clamped: number;
}

/**
 * Return type of computeGAP().
 */
export interface GAPResult {
  /** Per-lap GAP results (one entry per valid lap) */
  lapGapResults: LapGapResult[];
  /** Activity-level aggregate */
  activityGap: ActivityGapResult;
}
```

---

## 8. Testing Strategy

### 8.1 Unit Tests for `lib/gap.ts`

File: `__tests__/gap.test.ts`

Follow the existing pattern from `__tests__/pmc.test.ts`: plain Node test file using a local `assert()` helper, run with `node --experimental-strip-types`. No test framework required.

**Minetti curve tests:**

| Test | Description | Expected |
|---|---|---|
| `minettiCost(0)` | Flat-ground baseline | 3.6 (exactly) |
| `minettiCost(0.10)` | 10% uphill | ~5.26 (verify GAP pace is 30-40% faster) |
| `minettiCost(-0.10)` | 10% downhill | ~2.48 (verify GAP pace is ~30% slower) |
| `minettiCost(0.45)` | Maximum uphill (clamped boundary) | Positive, > 3.6 |
| `minettiCost(-0.40)` | Maximum downhill (clamped boundary) | Positive (curve rises again at steep downhills) |
| `minettiCost(0.20)` | 20% uphill | Higher cost than 10%; verify polynomial monotonicity in range |

**`clampGrade` tests:**

| Test | Input | Expected output |
|---|---|---|
| In-range grade | 0.10 | `{ grade: 0.10, clamped: false }` |
| Exactly at upper bound | 0.45 | `{ grade: 0.45, clamped: false }` |
| Exceeds upper bound | 0.60 | `{ grade: 0.45, clamped: true }` |
| Exactly at lower bound | -0.40 | `{ grade: -0.40, clamped: false }` |
| Below lower bound | -0.55 | `{ grade: -0.40, clamped: true }` |
| Zero grade | 0.0 | `{ grade: 0.0, clamped: false }` |

**`lapGrade` tests:**

| Test | Inputs | Expected |
|---|---|---|
| Flat lap | ascent=10, descent=10, dist=1km | 0.0 |
| Uphill lap | ascent=100, descent=0, dist=1km | 0.10 |
| Downhill lap | ascent=0, descent=100, dist=1km | -0.10 |
| Null ascent | ascent=null, descent=50, dist=1km | -0.05 (treats null as 0) |
| Null descent | ascent=50, descent=null, dist=1km | 0.05 |
| Both null | ascent=null, descent=null, dist=1km | 0.0 |
| Zero distance | ascent=50, descent=0, dist=0km | 0.0 (guard) |

**`lapGapPace` tests:**

| Test | Inputs | Expected |
|---|---|---|
| Flat grade | pace=360 sec/km (4:00/km), grade=0 | 360 (GAP = actual on flat) |
| 10% uphill | pace=360 sec/km, grade=0.10 | ~245 sec/km (~30-40% faster) |
| 10% downhill | pace=360 sec/km, grade=-0.10 | ~524 sec/km (~45% slower) |
| Steep uphill (max clamped) | pace=360, grade=0.45 | GAP < 360 |
| Cost = 0 guard | (should not occur within clamped range) | Returns actual pace |

**`computeGAP` tests:**

| Test | Description | Expected |
|---|---|---|
| Single flat lap | 1 lap, grade=0 | GAP = raw pace, gap_applied = false |
| Single uphill lap | 1 lap with ascent=100, dist=1km | GAP < raw pace, gap_applied = true |
| Multiple mixed laps | 5 laps with varying grades | Weighted avg verified by hand |
| Paused lap excluded | 1 lap with moving_time=0 | lap_count = 0, all nulls |
| Zero-distance lap excluded | 1 lap with distance=0 | lap_count = 0 |
| All null elevation | 5 laps with null ascent/descent | gap_applied = false, GAP = raw pace |
| Grade clamping count | 2 laps with grade > 0.45 | laps_grade_clamped = 2 |
| Empty laps array | [] | lap_count = 0, avg values null |

**Regression fixture:**

A 10-lap activity with known inputs computed by hand:
- Laps: 1 km each, moving_time varies 240-300s, ascent varies 0-80m, descent varies 0-60m
- Pre-compute expected `gap_pace_sec_per_km` for each lap and the activity-level `avg_gap_pace_seconds`
- This serves as the "golden" regression test

### 8.2 Edge Case Tests

| Case | Handling |
|---|---|
| `minettiCost(0)` = 3.6 | GAP pace equals actual pace on flat (no adjustment) |
| Grade exactly at bounds | No clamping flag set (`clamped = false`) |
| Grade one epsilon past bounds | Clamping flag set |
| All laps have null elevation | `gap_applied = false`; `avg_gap_pace_seconds` equals `avg_raw_pace_seconds` |
| Single lap activity | `avg_gap_pace_seconds` = that lap's GAP pace |
| Activity with no laps | `lapGapResults = []`, all `activityGap` values null or 0 |

### 8.3 Integration Tests (`lib/gapRecalc.ts`)

These require a Supabase test database or mock. Test:
- `computeGAPForActivity`: verify it fetches laps, calls `computeGAP`, and upserts correctly
- `computeGAPBatch`: verify sequential processing and backfill trigger
- `triggerDecouplingBackfill`: verify it identifies `awaiting_gap = true` activities and re-runs decoupling with GAP-adjusted speed
- Upsert idempotency: run `computeGAPForActivity` twice on the same activity; verify no duplicate rows

---

## 9. Tickets

### GAP-001: Core Calculation Library

**ID:** GAP-001
**Title:** Implement `lib/gap.ts` pure calculation library

**Scope:**
- Create `lib/gap.ts`
- All type definitions: `GarminLap`, `LapGapResult`, `ActivityGapResult`, `GAPResult`
- `minettiCost(grade)` — Minetti polynomial
- `clampGrade(grade)` — clamp to [-0.40, +0.45] with boolean flag
- `lapGrade(ascent, descent, distanceKm)` — fractional grade with null handling
- `lapGapPace(actualPaceSecPerKm, grade)` — applies Minetti ratio
- `computeGAP(laps)` — main pure function aggregating per-lap and activity-level results
- `round2()` private helper
- Create `__tests__/gap.test.ts` with all unit tests from Section 8.1 and 8.2

**Acceptance Criteria:**
1. `minettiCost(0)` returns exactly 3.6
2. `minettiCost(0.10)` produces a GAP pace approximately 30-40% faster than actual pace (verified in unit tests)
3. `clampGrade(0.60)` returns `{ grade: 0.45, clamped: true }`; `clampGrade(0.30)` returns `{ grade: 0.30, clamped: false }`
4. `lapGrade(null, null, 1)` returns 0; `lapGrade(100, 0, 1)` returns 0.10
5. `computeGAP([])` returns `{ lapGapResults: [], activityGap: { lap_count: 0, gap_applied: false, ... }}`
6. `computeGAP` skips laps with `moving_time_seconds <= 0` or `distance <= 0`
7. Activity-level `avg_gap_pace_seconds` is distance-weighted (verified by regression fixture)
8. All unit tests pass with `npm test`

**Dependencies:** None (pure TypeScript, no external imports)

---

### GAP-002: SQL Migration

**ID:** GAP-002
**Title:** Create `sql/activity_gap.sql` schema migration

**Scope:**
- Create `sql/activity_gap.sql`
- `activity_gap` table (columns per Section 3 schema)
- `lap_gap` table (columns per Section 3 schema)
- All indexes from Section 3
- GRANT and RLS DISABLE for both tables
- Extend `athlete_notifications` CHECK constraint to add `'gap_anomaly'`
- NOTIFY pgrst

**Acceptance Criteria:**
1. Migration runs successfully in Supabase SQL editor with no errors
2. Re-running the migration produces no errors (idempotent via IF NOT EXISTS)
3. `activity_gap` has a UNIQUE constraint on `activity_id`
4. `lap_gap` has a UNIQUE constraint on `(activity_id, lap)`
5. RLS is disabled on both tables
6. `GRANT SELECT, INSERT, UPDATE` is applied to both tables for `anon, authenticated`
7. `athlete_notifications_type_check` constraint includes all five notification types

**Dependencies:** GAP-001 is not required to run the migration, but GAP-001 must be complete before the migration is used by code

---

### GAP-003: Supabase I/O Pipeline

**ID:** GAP-003
**Title:** Implement `lib/gapRecalc.ts` recalculation pipeline

**Scope:**
- Create `lib/gapRecalc.ts`
- `computeGAPForActivity(activityId)` — fetch laps, call `computeGAP`, upsert `lap_gap` (batched) and `activity_gap`
- `computeGAPBatch(activityIds)` — sequential processing loop; calls `triggerDecouplingBackfill()` after all activities processed
- `triggerDecouplingBackfill()` — delegates to `backfillDecouplingWithGAP()` from `lib/decouplingRecalc.ts`
- All return-type interfaces from Section 5.2
- Full try/catch error handling on every exported function

**Acceptance Criteria:**
1. `computeGAPForActivity` fetches laps from `garmin_activity_laps` ordered by `lap` ascending
2. `computeGAPForActivity` upserts `lap_gap` rows with `onConflict: 'activity_id,lap'`
3. `computeGAPForActivity` upserts `activity_gap` row with `onConflict: 'activity_id'`
4. `computeGAPBatch` processes activities sequentially (not in parallel)
5. `computeGAPBatch` calls `triggerDecouplingBackfill()` after processing all activities
6. All exported functions return `{ ok: false, error: <message> }` on Supabase errors — no exceptions propagate
7. Activity with no laps upserts an `activity_gap` row with `lap_count = 0` and null pace fields

**Dependencies:** GAP-001 (pure library), GAP-002 (tables must exist)

---

### GAP-004: Section 5 Backfill Implementation

**ID:** GAP-004
**Title:** Implement `backfillDecouplingWithGAP()` in `lib/decouplingRecalc.ts`

**Scope:**
- Replace the existing `backfillDecouplingWithGAP()` stub in `lib/decouplingRecalc.ts` with a full implementation
- Query `activity_decoupling` for rows where `awaiting_gap = true`
- For each: fetch `activity_gap` (check `gap_applied` and `total_ascent_m`) and `lap_gap` rows
- Apply threshold rule: use GAP speed only when `total_ascent_m > 100` and `gap_applied = true`
- Construct synthetic `LapRecord` objects with GAP-adjusted distance (see Section 6 for formula)
- Re-run `computeActivityDecoupling()` with the synthetic laps
- Update `activity_decoupling`: set `gap_used`, `awaiting_gap = false`

**Acceptance Criteria:**
1. Activities with `awaiting_gap = true` and `total_ascent_m > 100` are re-run with GAP-adjusted speed; their `gap_used` becomes `true`
2. Activities with `awaiting_gap = true` but `total_ascent_m <= 100` (or no `activity_gap` row) are re-run with raw speed; their `gap_used` remains `false`, `awaiting_gap` becomes `false`
3. After backfill, no `activity_decoupling` rows have `awaiting_gap = true` (all cleared)
4. `backfillDecouplingWithGAP()` returns `{ ok: true, count: N }` where N is the number of activities reprocessed
5. Existing decoupling fields (effort_tier, laps_excluded_*, etc.) are re-computed correctly on re-run
6. Function returns `{ ok: false, error: <message> }` on any Supabase error

**Dependencies:** GAP-001, GAP-002, GAP-003 (lap_gap and activity_gap must be populated before backfill runs meaningfully)

---

### Implementation Order

```
GAP-001  (pure library — no dependencies)
    |
GAP-002  (SQL migration — no code dependencies; can run in parallel with GAP-001)
    |
GAP-003  (requires GAP-001 + GAP-002)
    |
GAP-004  (requires GAP-003; backfill reads lap_gap data written by GAP-003)
```

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Elevation data absent for many laps** | Medium | `lapGrade()` returns 0 for null elevation; `gap_applied = false` signals this clearly. Section 5 backfill applies the threshold check before using GAP. |
| **Grade clamping on extreme terrain** | Low | `grade_clamped` boolean stored per lap; visible in `laps_grade_clamped` aggregate. Clamping produces conservative (never zero) GAP adjustments. |
| **Minetti cost near-zero at steep downhills** | Low | The Minetti curve has a minimum around g=-0.15 to -0.20, then rises again. Within the [-0.40, +0.45] clamped range the cost is always > 0. The `if (cost <= 0) return actualPaceSecPerKm` guard in `lapGapPace` is a safety net only. |
| **Large batch on initial backfill** | Medium | Sequential processing in `computeGAPBatch` (not parallel). Decoupling backfill runs once after the full batch, not per-activity. |
| **Section 5 backfill clearing awaiting_gap for non-hilly activities** | Low | The threshold check (`total_ascent_m > 100`) ensures non-hilly activities are still marked `awaiting_gap = false` (removing them from future backfill runs), with `gap_used = false`. |
| **Synthetic LapRecord distance precision** | Low | GAP-adjusted distance uses floating-point arithmetic. Round to 2 decimal places before passing to `computeDecoupling()`. The decoupling result rounds EF values to 2 decimal places, absorbing any minor precision drift. |

---

## Sign-off

**Staff Engineer Lead:** Draft — ready for Staff Engineer 2 review.
**Date:** 2026-03-07
**Status:** Pending review
