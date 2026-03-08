# Section 7 -- Running Efficiency Factor (EF): Technical Design Document

**Author:** Staff Engineer Lead
**Date:** 2026-03-08
**PRD Section:** 7 (Running: Efficiency Factor)
**Status:** Draft -- pending Staff Engineer 2 review

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Database Schema (`sql/activity_ef.sql`)](#3-database-schema-sqlactivity_efsql)
4. [HR Zone Resolution (`lib/hrZones.ts` refactor)](#4-hr-zone-resolution-libhrzonests-refactor)
5. [Core Calculation Library (`lib/ef.ts`)](#5-core-calculation-library-libefts)
6. [Supabase I/O Pipeline (`lib/efRecalc.ts`)](#6-supabase-io-pipeline-libefrecalcts)
7. [Integration Points](#7-integration-points)
8. [Testing Strategy](#8-testing-strategy)
9. [Ticket Breakdown](#9-ticket-breakdown)
10. [Key Risks and Mitigations](#10-key-risks-and-mitigations)
11. [Design Decisions](#11-design-decisions)

---

## 1. Overview

### What This Implements

Section 7 adds Running Efficiency Factor (EF) to the analytics pipeline. EF captures how much running output (pace/speed) an athlete generates per heartbeat, providing a primary indicator of aerobic fitness development that is largely independent of external conditions (pace targets, route terrain, weather — with appropriate filtering).

The formula is:

```
EF_run = avg_GAP_speed (m/s) / avg_HR (bpm)
```

Higher EF = more efficient. Using speed in m/s (not pace in sec/km) means higher values always represent better fitness, consistent with the EF convention established in Section 5 (`lib/decoupling.ts`).

EF_cycle (normalized power / avg_HR) is **deferred to Section 12** when normalized power data enters the schema.

### How It Fits the Codebase

Section 7 follows the identical two-layer pattern established by PMC (Section 2), Decoupling (Section 5), and GAP (Section 6):

| Layer | PMC | Decoupling | GAP | EF (Section 7) |
|---|---|---|---|---|
| Pure calculation | `lib/pmc.ts` | `lib/decoupling.ts` | `lib/gap.ts` | `lib/ef.ts` |
| Supabase I/O | `lib/pmcRecalc.ts` | `lib/decouplingRecalc.ts` | `lib/gapRecalc.ts` | `lib/efRecalc.ts` |
| SQL migration | `sql/daily_pmc_values.sql` | `sql/activity_decoupling.sql` | `sql/activity_gap.sql` | `sql/activity_ef.sql` |
| Storage tables | `daily_pmc_values` | `activity_decoupling`, `decoupling_baseline`, `decoupling_trend` | `activity_gap`, `lap_gap` | `activity_ef`, `daily_ef_trend` |

Additionally, Section 7 extracts the HR zone resolution chain from `decouplingRecalc.ts` into a shared `resolveHRZones()` function in the existing `lib/hrZones.ts` file. Both `decouplingRecalc.ts` and the new `efRecalc.ts` import from this shared utility.

### Role in the Broader Pipeline

- **Depends on Section 6 (GAP):** EF uses `avg_gap_pace_seconds` from `activity_gap` as the preferred numerator. Falls back to raw pace when GAP is unavailable.
- **Depends on `lib/hrZones.ts`:** Z1–Z2 qualifying filter requires personalized HR zone bounds.
- **Feeds Section 21 (Temperature Normalization):** A stub function `normalizeTempEF()` is shipped in `lib/ef.ts` now so Section 21 can drop in the real implementation without touching `efRecalc.ts`.
- **No UI in Section 7:** EF data is stored for chart consumption downstream.

---

## 2. Architecture

### File Structure

```
lib/
  ef.ts           -- Pure calculation library (EF formula, warmup exclusion, regression, alerts)
  efRecalc.ts     -- Supabase I/O layer (fetch laps + GAP, upsert activity_ef, compute daily_ef_trend)
  hrZones.ts      -- EXTENDED: add resolveHRZones() shared utility (EF-004 refactor)

sql/
  activity_ef.sql -- Migration: activity_ef and daily_ef_trend tables; extend athlete_notifications

__tests__/
  ef.test.ts      -- Unit tests for all pure functions in lib/ef.ts
```

No new screens or UI components are introduced in Section 7.

### Module Responsibilities

**`lib/ef.ts` (pure — zero I/O)**
- Implements the core EF formula (GAP speed / avg HR)
- Applies warmup exclusion via lap-drop (cumulative elapsed < 10 min)
- Determines qualifying run status (duration, HR zone, temperature)
- Computes rolling 30-day and 90-day EF averages
- Runs linear regression of EF vs. date and returns slope + R²
- Detects 5% alert condition
- Exposes `normalizeTempEF()` stub for Section 21
- Accepts and returns plain TypeScript objects; no imports from Supabase, AsyncStorage, or React Native

**`lib/efRecalc.ts` (Supabase I/O layer)**
- Resolves HR zones via `resolveHRZones()` from `lib/hrZones.ts`
- Queries `garmin_activities` for run activities since `fromDate`
- For each activity: fetches `garmin_activity_laps`, applies warmup exclusion, sources GAP from `activity_gap` / `lap_gap`, computes EF, applies qualifying filter
- Upserts per-activity results to `activity_ef`
- Aggregates qualifying activities into `daily_ef_trend` (rolling averages + regression)
- Checks 5% alert condition and inserts into `athlete_notifications` when triggered

**`lib/hrZones.ts` (extended — EF-004)**
- Existing: `loadHRZones()`, `saveHRZones()`, `getZoneForHR()`
- Added: `resolveHRZones()` — async function implementing the four-priority resolution chain, returning a fully resolved `HRZones` array (not just zone 3/4 thresholds). Used by both `efRecalc.ts` and the refactored `decouplingRecalc.ts`.

**`sql/activity_ef.sql`**
- Creates `activity_ef` and `daily_ef_trend` tables
- Extends `athlete_notifications` CHECK constraint to include `'ef_alert'`
- Follows the same RLS-disabled, anon-granted pattern as all other tables in the codebase

### Data Flow

```
sync trigger
    │
    ▼
recalculateAllSports()   [pmcRecalc.ts]
    │
    ▼
computeGAPBatch()        [gapRecalc.ts]
    │
    ├──► backfillDecouplingWithGAP()   [decouplingRecalc.ts]
    │
    └──► recalculateEF()              [efRecalc.ts]  ← NEW (EF-005)
              │
              ├── resolveHRZones()          [hrZones.ts]
              ├── garmin_activities         [Supabase]
              ├── garmin_activity_laps      [Supabase]
              ├── activity_gap / lap_gap    [Supabase — GAP source]
              ├── activity_ef               [Supabase — upsert per activity]
              └── daily_ef_trend            [Supabase — upsert rolling stats]
```

---

## 3. Database Schema (`sql/activity_ef.sql`)

The migration is idempotent (uses `IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`). It follows the exact pattern of `sql/activity_gap.sql`.

### 3.1 `activity_ef` Table

One row per activity. Upsert key: `(athlete_id, activity_id)`.

```sql
CREATE TABLE IF NOT EXISTS activity_ef (
    id                       SERIAL           PRIMARY KEY,
    athlete_id               UUID             NOT NULL REFERENCES athletes(id),

    -- Soft reference to garmin_activities (no FK enforced; consistent with activity_decoupling, activity_gap)
    activity_id              TEXT             NOT NULL,

    -- Date of the activity (denormalized for efficient date-range queries)
    date                     DATE             NOT NULL,

    -- Sport tag: 'run' now; 'cycle' when Section 12 ships
    sport                    TEXT             NOT NULL DEFAULT 'run'
                                              CHECK (sport IN ('run', 'cycle')),

    -- The computed EF value (m/s / bpm)
    ef_value                 DOUBLE PRECISION NOT NULL,

    -- Whether GAP speed was used as the numerator (true) or raw speed (false)
    gap_used                 BOOLEAN          NOT NULL DEFAULT false,

    -- Whether this activity qualifies for the EF trendline
    qualifying               BOOLEAN          NOT NULL DEFAULT false,

    -- Reason the activity was excluded from the trendline (NULL when qualifying = true)
    disqualification_reason  TEXT             CHECK (disqualification_reason IN (
                                                 'duration_too_short',
                                                 'temp_out_of_range',
                                                 'hr_outside_z2',
                                                 'insufficient_laps'
                                             )),

    -- Average temperature at time of computation (from garmin_activities.avg_temperature)
    temp_c                   DOUBLE PRECISION,

    -- Section 21 stub: always false until temperature normalization ships
    temp_adjusted            BOOLEAN          NOT NULL DEFAULT false,

    -- Section 21 stub: NULL until temperature normalization ships
    ef_temp_adjusted         DOUBLE PRECISION,

    -- Audit timestamp
    computed_at              TIMESTAMPTZ      NOT NULL DEFAULT now(),

    UNIQUE (athlete_id, activity_id)
);

-- Date-range queries per athlete (downstream consumers, trend window queries)
CREATE INDEX IF NOT EXISTS idx_activity_ef_athlete_date
    ON activity_ef (athlete_id, date);

-- Qualifying-only queries (used when building trendline input)
CREATE INDEX IF NOT EXISTS idx_activity_ef_qualifying
    ON activity_ef (athlete_id, qualifying, date)
    WHERE qualifying = true;
```

### 3.2 `daily_ef_trend` Table

One row per `(athlete_id, date)`. Covers every calendar day within the computed window, regardless of whether that day had a qualifying activity.

```sql
CREATE TABLE IF NOT EXISTS daily_ef_trend (
    id                   SERIAL           PRIMARY KEY,
    athlete_id           UUID             NOT NULL REFERENCES athletes(id),

    -- Calendar date for this trend snapshot
    date                 DATE             NOT NULL,

    -- 30-day rolling average EF across qualifying activities ending on this date
    -- NULL when fewer than 1 qualifying activity in window
    rolling_30d_ef       DOUBLE PRECISION,

    -- 90-day rolling average EF across qualifying activities ending on this date
    -- NULL when fewer than 1 qualifying activity in window
    rolling_90d_ef       DOUBLE PRECISION,

    -- Slope from linear regression of EF vs. date (units: EF per day)
    -- NULL when fewer than 3 qualifying activities available
    ef_slope             DOUBLE PRECISION,

    -- R-squared of the linear regression fit
    -- NULL when ef_slope is NULL
    ef_slope_r2          DOUBLE PRECISION,

    -- Count of qualifying activities contributing to the 30-day window
    n_qualifying_30d     INTEGER          NOT NULL DEFAULT 0,

    -- Count of qualifying activities contributing to the 90-day window
    n_qualifying_90d     INTEGER          NOT NULL DEFAULT 0,

    -- Audit timestamp
    computed_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),

    UNIQUE (athlete_id, date)
);

-- Date-range queries per athlete
CREATE INDEX IF NOT EXISTS idx_daily_ef_trend_athlete_date
    ON daily_ef_trend (athlete_id, date);
```

### 3.3 `athlete_notifications` Extension

Extend the existing CHECK constraint to include `'ef_alert'`, following the pattern from `activity_gap.sql`:

```sql
ALTER TABLE athlete_notifications
    DROP CONSTRAINT IF EXISTS athlete_notifications_type_check;

ALTER TABLE athlete_notifications
    ADD CONSTRAINT athlete_notifications_type_check
    CHECK (type IN (
        'personalization_available',
        'model_updated',
        'more_data_needed',
        'decoupling_anomaly',
        'gap_anomaly',
        'ef_alert'
    ));
```

### 3.4 Access Control

```sql
GRANT SELECT, INSERT, UPDATE ON activity_ef      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON daily_ef_trend   TO anon, authenticated;

ALTER TABLE activity_ef     DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_ef_trend  DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

RLS is disabled and anon/authenticated are granted access, consistent with all other tables in this codebase (see CLAUDE.md: "RLS is disabled on all current tables — no auth yet").

---

## 4. HR Zone Resolution (`lib/hrZones.ts` refactor)

### 4.1 Current State

`lib/hrZones.ts` currently exports:
- `loadHRZones(): Promise<HRZones | null>` — reads from AsyncStorage
- `saveHRZones(zones: HRZones): Promise<void>` — writes to AsyncStorage
- `getZoneForHR(hr: number, zones: HRZones): number | null` — 1-based zone lookup

### 4.2 EF-004 Addition: `resolveHRZones()`

A new exported async function `resolveHRZones()` implements the four-priority chain:

```typescript
/**
 * Resolve HR zones via a four-priority chain. Returns a fully resolved
 * HRZones array (5 zones, each with min/max BPM bounds).
 *
 * Priority 1: AsyncStorage HR zones (loadHRZones) — athlete-set personalized zones
 * Priority 2: LTHR from AsyncStorage/Supabase (loadLTHR) — derive 5-zone boundaries
 * Priority 3: Most-recent garmin_activity_laps hrz_* columns — back-calculate zone bounds
 * Priority 4: Default zones based on 180 bpm max HR with standard percentages
 *
 * The returned HRZones is used by both efRecalc.ts (Z1–Z2 qualifying filter)
 * and the refactored decouplingRecalc.ts (effort tier classification).
 */
export async function resolveHRZones(): Promise<HRZones>
```

**Priority 1 — AsyncStorage HR zones:**
If `loadHRZones()` returns a non-null array with at least zones[0] and zones[1] populated, return it directly.

**Priority 2 — LTHR-derived zones:**
If `loadLTHR()` returns a non-null value, derive 5-zone boundaries using the standard Friel/Daniels percentages relative to LTHR:
- Zone 1: [0, LTHR × 0.80]
- Zone 2: [LTHR × 0.80, LTHR × 0.89]
- Zone 3: [LTHR × 0.90, LTHR × 0.93]
- Zone 4: [LTHR × 0.94, LTHR × 0.99]
- Zone 5: [LTHR × 1.00, 999]

These percentages match what `decouplingRecalc.ts` currently uses for zone 3/4 thresholds (82%/90% of LTHR).

**Priority 3 — Lap hrz_* columns:**
Query the most recent `garmin_activity_laps` row where `hrz_3_hr` and `hrz_4_hr` are non-null. Back-calculate all 5 zone boundaries using the same Friel ratios, treating `hrz_3_hr` as LTHR × 0.90 to derive LTHR, then applying Priority 2 logic.

**Priority 4 — Default zones (180 bpm assumed max HR):**
```
Zone 1: [0,   108]   (60% of 180)
Zone 2: [109, 126]   (70% of 180)
Zone 3: [127, 144]   (80% of 180)
Zone 4: [145, 162]   (90% of 180)
Zone 5: [163, 999]   (100%+)
```

### 4.3 `decouplingRecalc.ts` Refactor

The existing private `resolveHRZoneThresholds()` in `decouplingRecalc.ts` is replaced with a call to the shared `resolveHRZones()` from `lib/hrZones.ts`. The `classifyEffortTier()` function in `lib/decoupling.ts` already accepts `HRZoneThresholds` (zone 3 and 4 min). After the refactor, `decouplingRecalc.ts` derives the equivalent `HRZoneThresholds` from the fully resolved `HRZones` returned by `resolveHRZones()`:

```typescript
const zones = await resolveHRZones();
const thresholds: HRZoneThresholds = {
  hrz_3_min: zones[2].min,
  hrz_4_min: zones[3].min,
};
```

This produces functionally identical behavior to the current code, with the logic living in one place.

---

## 5. Core Calculation Library (`lib/ef.ts`)

`lib/ef.ts` is pure TypeScript — zero I/O, zero external dependencies. All functions are exported and unit-testable in isolation.

### 5.1 Type Definitions

```typescript
/**
 * A single lap record from garmin_activity_laps, with only the fields needed
 * for EF computation. The same fields are available from the existing LapRecord
 * in lib/decoupling.ts — ef.ts defines its own minimal type to stay independent.
 */
export interface EFLapRecord {
  lap: number;
  moving_time_seconds: number | null;
  elapsed_time_seconds: number | null;  // cumulative elapsed from activity start
  distance: number | null;              // meters
  avg_hr: number | null;
  gap_pace_sec_per_km: number | null;   // from lap_gap table; null if GAP not computed
}

/** HR zone bounds as min/max BPM. Re-exported from hrZones.ts for convenience. */
export type { HRZoneBounds, HRZones } from './hrZones';
```

### 5.2 Core EF Calculation

```typescript
/**
 * Compute EF from a speed in m/s and an average HR in bpm.
 *
 * EF = speed_mps / avg_hr
 *
 * Returns null if either input is non-positive (defensive guard).
 */
export function calculateEFRun(speedMps: number, avgHR: number): number | null
```

Implementation note: `speedMps` is derived from GAP pace when available:
```
speedMps = 1000 / gap_pace_sec_per_km
```
Or from raw pace when GAP is unavailable:
```
speedMps = (distance_m) / moving_time_seconds
```

### 5.3 Warmup-Excluded EF from Laps

```typescript
export interface EFFromLapsResult {
  efValue: number;
  lapCount: number;
  gapUsed: boolean;
}

/**
 * Compute EF from lap records, applying the 10-minute warmup exclusion.
 *
 * Warmup exclusion: laps whose cumulative elapsed_time_seconds from activity
 * start is < 600s (10 minutes) are dropped in full (conservative exclusion —
 * consistent with Section 5 precedent documented in agent-decision-log.md).
 *
 * For remaining laps:
 *   - Use gap_pace_sec_per_km if non-null (GAP available); set gapUsed = true
 *   - Fall back to raw speed (distance / moving_time_seconds) if no GAP
 *   - Speed and HR contributions are time-weighted (by moving_time_seconds)
 *     to avoid distortion from partial or very short laps
 *   - Laps with null/zero moving_time or null avg_hr are skipped
 *
 * Returns null if no valid post-warmup laps remain (insufficient_laps).
 */
export function calculateEFFromLaps(
  laps: EFLapRecord[]
): EFFromLapsResult | null
```

**Weighting rationale:** Section 5 uses distance-weighted EF for decoupling because laps are typically uniform distance (auto-lap at 1 km). For EF specifically, time-weighting is slightly more correct because HR is a time-series signal — a 5-minute slow lap and a 4-minute fast lap at the same HR contribute the same number of heartbeats in proportion to their time, not their distance. Both approaches produce nearly identical results on uniform laps; time-weighting is chosen for theoretical correctness.

### 5.4 Qualifying Run Filter

```typescript
export interface QualifyingResult {
  qualifying: boolean;
  reason?: 'duration_too_short' | 'temp_out_of_range' | 'hr_outside_z2' | 'insufficient_laps';
}

/**
 * Determine whether an activity qualifies for inclusion in the EF trendline.
 *
 * Disqualification conditions (first failing condition wins):
 *   1. movingTimeSec <= 1800 (< 30 minutes) → 'duration_too_short'
 *   2. avgTempC is non-null AND (avgTempC > 27 || avgTempC < 0) → 'temp_out_of_range'
 *      (null temp is treated as unknown — activity is NOT excluded on temperature alone)
 *   3. avgHR > zones[1].max (above Z2 upper bound) → 'hr_outside_z2'
 *      OR avgHR < zones[0].min (below Z1 lower bound) → 'hr_outside_z2'
 *
 * Note: 'insufficient_laps' is returned by the caller when calculateEFFromLaps
 * returns null (no valid post-warmup laps). It is included in the reason type
 * for schema consistency but is not evaluated inside this function.
 */
export function isQualifyingRun(params: {
  movingTimeSec: number;
  avgHR: number;
  zones: HRZones;
  avgTempC: number | null;
}): QualifyingResult
```

### 5.5 Rolling Average

```typescript
/**
 * Compute a rolling average of EF values within a trailing windowDays window
 * ending on `referenceDate` (ISO YYYY-MM-DD).
 *
 * Only entries whose date falls within [referenceDate - windowDays + 1, referenceDate]
 * are included. Returns null if no entries fall within the window.
 *
 * @param entries      Array of {date, efValue} pairs. Need not be sorted.
 * @param referenceDate  The window's end date. Defaults to today.
 * @param windowDays   Window size in days (e.g., 30 or 90).
 */
export function computeRollingEFAvg(
  entries: Array<{ date: string; efValue: number }>,
  windowDays: number,
  referenceDate?: string
): number | null
```

### 5.6 Linear Regression

```typescript
export interface EFRegressionResult {
  slope: number;       // EF per day (positive = improving)
  intercept: number;   // EF at day 0 (epoch baseline; not directly user-facing)
  rSquared: number;    // Coefficient of determination [0, 1]
}

/**
 * Fit a linear regression of EF vs. date across qualifying activity entries.
 *
 * Date is converted to a numeric day index (days since the earliest date in
 * the input set) so that the slope is interpretable as EF per day.
 *
 * Returns null when:
 *   - Fewer than 3 data points are provided (insufficient for a meaningful fit)
 *   - All entries have the same date (zero variance in x — regression undefined)
 *
 * TODO: Polynomial regression extension point. When Section 21 delivers more
 * data and the qualifying run count grows, a degree-2 polynomial fit can be
 * added here as computeEFPolynomialRegression(). The linear version is the
 * correct starting point given sparse easy-run data (see agent-decision-log.md
 * 2026-03-08 "Regression Type" decision).
 *
 * @param entries  Array of {date, efValue} pairs. Need not be sorted.
 */
export function computeEFRegression(
  entries: Array<{ date: string; efValue: number }>
): EFRegressionResult | null
```

**Implementation note for R²:** Use the standard formula `R² = 1 - SS_res / SS_tot` where `SS_res = Σ(y_i - ŷ_i)²` and `SS_tot = Σ(y_i - ȳ)²`. When `SS_tot = 0` (all EF values are identical), return `rSquared = 1.0`.

### 5.7 Alert Detection

```typescript
/**
 * Returns true when the 30-day average EF has changed by more than `threshold`
 * relative to the 90-day average, in either direction (improvement or decline).
 *
 * Formula: |avg30d - avg90d| / avg90d > threshold
 *
 * Returns false if avg90d is zero or either value is null.
 *
 * @param avg30d     Rolling 30-day EF average
 * @param avg90d     Rolling 90-day EF average
 * @param threshold  Fractional threshold. Defaults to 0.05 (5%).
 */
export function detectEFAlert(
  avg30d: number,
  avg90d: number,
  threshold?: number
): boolean
```

### 5.8 Section 21 Stub

```typescript
/**
 * Normalize EF for ambient temperature relative to a reference temperature.
 *
 * Current state: STUB — returns `ef` unchanged with no transformation.
 * This function is a seam for Section 21 (Temperature Normalization) to
 * fill in. When Section 21 ships, replace this body with the physiological
 * HR-temperature model.
 *
 * Reference: Ely et al. (2007) found ~1% HR increase per 1°C above 10°C at
 * threshold intensity. Section 21 will implement a calibrated version of this.
 *
 * TODO (Section 21): implement normalization.
 *   Suggested signature for the final implementation:
 *   normalizeTempEF(ef, tempC, refTempC) → ef_normalized
 *   using model: ef_adjusted = ef / (1 + k * (tempC - refTempC))
 *   where k is a fitted per-athlete coefficient from Section 21.
 *
 * @param ef       Raw EF value (m/s/bpm)
 * @param tempC    Ambient temperature in degrees Celsius
 * @param refTempC Reference temperature. Defaults to 15°C.
 * @returns        `ef` unchanged (stub behavior)
 */
export function normalizeTempEF(
  ef: number,
  tempC: number,
  refTempC: number = 15
): number {
  // TODO: implement when Section 21 ships
  void tempC;
  void refTempC;
  return ef;
}
```

---

## 6. Supabase I/O Pipeline (`lib/efRecalc.ts`)

Follows the same pattern as `gapRecalc.ts` and `decouplingRecalc.ts`: singleton Supabase client, try/catch on every exported async function, sequential batch processing (no `Promise.all` over activities).

### 6.1 Module Constants

```typescript
/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Batch size for upsert operations (matches gapRecalc.ts pattern). */
const BATCH_SIZE = 500;

/** Minimum total ascent (meters) for GAP to be considered valid for EF. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Alert threshold: 5% change in 30d vs 90d EF triggers a notification. */
const EF_ALERT_THRESHOLD = 0.05;
```

### 6.2 Main Exported Function

```typescript
export interface EFRecalcResult {
  ok: boolean;
  activitiesProcessed?: number;
  activitiesSkipped?: number;
  errors?: number;
  trendRowsUpserted?: number;
  alertTriggered?: boolean;
  error?: string;
}

/**
 * Recalculate EF for all run activities since `fromDate`, then recompute
 * the EF trend (rolling averages + regression) and check the alert condition.
 *
 * @param fromDate  ISO date (YYYY-MM-DD). Process activities on or after this date.
 *                  Omit to process all activities on record.
 */
export async function recalculateEF(fromDate?: string): Promise<EFRecalcResult>
```

### 6.3 Pipeline Steps

**Step 1 — Resolve HR zones**

```typescript
const zones = await resolveHRZones();  // from lib/hrZones.ts
```

**Step 2 — Fetch run activities**

Query `garmin_activities` for all activities with sport ILIKE `'%run%'` (matching Garmin sport values like `'running'`, `'trail_running'`). Fetch:
- `activity_id`, `start_time`, `moving_time_seconds`, `avg_hr`, `avg_temperature`, `ascent`

Apply date filter if `fromDate` is provided:
```typescript
.gte('start_time', fromDate)
```

**Step 3 — Per-activity EF computation**

For each activity:

3a. **Fetch laps** from `garmin_activity_laps`:
```
SELECT lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr
WHERE activity_id = $1
ORDER BY lap ASC
```

3b. **Fetch GAP data** from `lap_gap`:
```
SELECT lap, gap_pace_sec_per_km
WHERE activity_id = $1
ORDER BY lap ASC
```

And from `activity_gap`:
```
SELECT gap_applied, total_ascent_m
WHERE activity_id = $1
```

3c. **Determine whether to use GAP.** Use GAP speed as the EF numerator when:
- `activity_gap` row exists AND `gap_applied = true`
- AND `total_ascent_m > GAP_ASCENT_THRESHOLD_M` (100 m, consistent with Section 6 pattern)

If both conditions are met, merge `lap_gap.gap_pace_sec_per_km` into the lap records as `EFLapRecord.gap_pace_sec_per_km`. Otherwise, leave `gap_pace_sec_per_km = null` on all laps (raw pace fallback).

3d. **Compute EF** via `calculateEFFromLaps(laps)`.

If `calculateEFFromLaps` returns `null`, upsert a row to `activity_ef` with:
- `qualifying = false`
- `disqualification_reason = 'insufficient_laps'`
- `ef_value` — cannot be stored; skip upsert for this activity (do not store a partial record)

Wait — on reflection: do not upsert when EF cannot be computed. Log the skip and continue.

3e. **Apply qualifying filter** via `isQualifyingRun()`. Pass:
- `movingTimeSec` from `garmin_activities.moving_time_seconds`
- `avgHR` from `garmin_activities.avg_hr`
- `zones` from `resolveHRZones()` (resolved once in Step 1, reused)
- `avgTempC` from `garmin_activities.avg_temperature`

3f. **Apply Section 21 stub.** Call `normalizeTempEF(efValue, tempC ?? 15)` to produce `ef_temp_adjusted`. Since the stub returns `ef` unchanged, store `temp_adjusted = false` and `ef_temp_adjusted = null`.

3g. **Upsert to `activity_ef`**:
```typescript
{
  athlete_id:              SINGLE_ATHLETE_ID,
  activity_id:             String(actRow.activity_id),
  date:                    actRow.start_time.slice(0, 10),
  sport:                   'run',
  ef_value:                efResult.efValue,
  gap_used:                efResult.gapUsed,
  qualifying:              qualifyingResult.qualifying,
  disqualification_reason: qualifyingResult.reason ?? null,
  temp_c:                  actRow.avg_temperature ?? null,
  temp_adjusted:           false,
  ef_temp_adjusted:        null,
}
// onConflict: 'athlete_id,activity_id'
```

**Step 4 — Compute rolling averages**

After processing all activities, query all `activity_ef` rows where `qualifying = true`, ordered by date ascending. For each calendar date from the earliest qualifying activity to today, compute:
- `rolling_30d_ef = computeRollingEFAvg(entries, 30, date)`
- `rolling_90d_ef = computeRollingEFAvg(entries, 90, date)`
- `n_qualifying_30d = count of entries in 30-day window`
- `n_qualifying_90d = count of entries in 90-day window`

**Step 5 — Compute linear regression**

Using all qualifying activities (no date window restriction — regression uses the full history):
- `regressionResult = computeEFRegression(allQualifyingEntries)`
- Store `ef_slope` and `ef_slope_r2` from the result (null if fewer than 3 entries)
- Since the regression applies globally (not per-day), store the same slope/R² on every row in `daily_ef_trend` for the current computation run. The slope represents the trend as of the latest computation date.

**Step 6 — Upsert `daily_ef_trend`**

Build one row per date and upsert in batches:
```typescript
{
  athlete_id:       SINGLE_ATHLETE_ID,
  date:             dateStr,
  rolling_30d_ef:   rolling30,
  rolling_90d_ef:   rolling90,
  ef_slope:         regressionResult?.slope ?? null,
  ef_slope_r2:      regressionResult?.rSquared ?? null,
  n_qualifying_30d: n30,
  n_qualifying_90d: n90,
}
// onConflict: 'athlete_id,date'
```

**Step 7 — Alert check**

For the most recent date that has both `rolling_30d_ef` and `rolling_90d_ef` non-null:

```typescript
const alertTriggered = detectEFAlert(latestRow.rolling_30d_ef, latestRow.rolling_90d_ef);
if (alertTriggered) {
  await supabase.from('athlete_notifications').insert({
    athlete_id: SINGLE_ATHLETE_ID,
    sport: 'running',
    type: 'ef_alert',
    message: `EF has changed by more than 5%: 30-day avg ${avg30.toFixed(4)} vs 90-day avg ${avg90.toFixed(4)}`,
    is_read: false,
  });
}
```

### 6.4 GAP Fallback Logic (Detail)

The GAP fallback is determined at the activity level by checking `activity_gap.gap_applied` and `total_ascent_m`. At the lap level, GAP data is read from `lap_gap.gap_pace_sec_per_km` and merged into `EFLapRecord` objects. The merge is keyed by `lap` number.

If a lap exists in `garmin_activity_laps` but has no corresponding row in `lap_gap` (e.g., the lap was added after GAP was last computed), that lap falls back to raw speed for its contribution to the EF average. This is tracked at the activity level by `gap_used` — which is set to `true` only if GAP was applied to at least one post-warmup lap.

```
activity_gap.gap_applied = true AND total_ascent_m > 100  →  use lap_gap for available laps
activity_gap row missing OR gap_applied = false            →  use raw pace from garmin_activity_laps
```

---

## 7. Integration Points

### 7.1 Sync Trigger Chain

`recalculateEF()` is called at the tail of `computeGAPBatch()` in `gapRecalc.ts`, after the decoupling backfill has been triggered. The updated call chain in `gapRecalc.ts`:

```typescript
// After upserts to activity_gap and lap_gap are complete:
await triggerDecouplingBackfill();   // existing
await triggerEFRecalc(fromDate);     // new (EF-005)
```

The new `triggerEFRecalc()` wrapper in `gapRecalc.ts` follows the same thin-wrapper pattern as `triggerDecouplingBackfill()`:

```typescript
export async function triggerEFRecalc(fromDate?: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const result = await recalculateEF(fromDate);
    return { ok: result.ok, error: result.error };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
```

### 7.2 Section 21 Backfill Stub

When Section 21 ships temperature normalization, the backfill entry point is:

```typescript
/**
 * Backfill EF temperature adjustment across all activity_ef rows.
 *
 * When Section 21 delivers the normalization model:
 *   1. Query all activity_ef rows where temp_adjusted = false AND temp_c IS NOT NULL
 *   2. Call normalizeTempEF(ef_value, temp_c) — which will no longer be a stub
 *   3. Update ef_temp_adjusted and set temp_adjusted = true
 *
 * This function is a stub — it is a no-op until Section 21 ships.
 * The seam is clean: normalizeTempEF() in lib/ef.ts is the only place to change.
 *
 * TODO (Section 21): implement body.
 */
export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  // TODO: implement when Section 21 ships
  return { ok: true, count: 0 };
}
```

This function is exported from `lib/efRecalc.ts` so Section 21 can call it directly as its entry point without requiring changes to the EF module interface.

---

## 8. Testing Strategy

### 8.1 Unit Tests (`__tests__/ef.test.ts`)

All tests use Jest, consistent with the project's existing test setup. No Supabase I/O in unit tests.

**`calculateEFRun`**
- Basic: speed 0.04 m/s, HR 140 → EF = 0.000286 (verify 6-decimal precision)
- Guard: speed = 0 → null; HR = 0 → null; negative inputs → null

**`calculateEFFromLaps`**
- Warmup exclusion: 3 laps totaling 8 min, 5 min, 7 min → first 2 laps dropped (cum elapsed < 600s), EF from lap 3 only
- GAP usage: laps with `gap_pace_sec_per_km` set → `gapUsed = true`; all null → `gapUsed = false`
- All-warmup scenario: every lap inside 10-min window → returns null
- Null HR laps are skipped from weighting
- Time-weighted average correctness: 2 laps of different durations verified against manual calculation

**`isQualifyingRun`**
- Duration: 1800s → disqualified; 1801s → qualifies (if HR/temp pass)
- Temperature: 28°C → disqualified; 27°C → qualifies; null temp → does not disqualify
- HR: above Z2 max → disqualified; below Z1 min → disqualified; within Z1–Z2 → qualifies
- Precedence: duration check fires before temp check

**`computeRollingEFAvg`**
- 30-day window with entries spanning 45 days → only most recent 30 days included
- Empty window → null
- All entries on same day → returns that day's average

**`computeEFRegression`**
- Fewer than 3 points → null
- Perfect linear trend → slope matches expected, R² = 1.0
- Flat trend (all same EF) → slope = 0, R² = 1.0
- All same date → null (zero variance)

**`detectEFAlert`**
- 5% above → true; 4.9% above → false; 5% below → true; 0% change → false
- avg90d = 0 → false

**`normalizeTempEF` (stub)**
- Any inputs → returns ef unchanged
- Verify refTempC default = 15 does not affect output (stub)

### 8.2 Regression Fixture

Include a regression fixture of 20 qualifying run entries spanning 90 days with known EF values. Assert that:
- Rolling 30-day and 90-day averages match hand-calculated expected values
- Regression slope and R² match expected values (computed externally)

This mirrors the regression fixture pattern established in `gap.test.ts` (10-lap fixture) and the PMC regression suite.

### 8.3 Integration Tests (Manual, Pre-PR)

- Run `recalculateEF()` against development Supabase. Verify:
  - `activity_ef` rows appear for all run activities
  - `qualifying = true` only for Z1–Z2 runs ≥ 30 min with acceptable temp
  - `gap_used = true` on activities that have `activity_gap.gap_applied = true`
  - `daily_ef_trend` rows populated for all dates since earliest qualifying run
  - `ef_slope` is non-null after ≥ 3 qualifying activities exist

---

## 9. Ticket Breakdown

### EF-001: SQL Migration (`sql/activity_ef.sql`)

**Description:** Create the `activity_ef` and `daily_ef_trend` tables. Extend the `athlete_notifications` CHECK constraint to include `'ef_alert'`. Write the migration following the exact pattern of `sql/activity_gap.sql` (idempotent, RLS disabled, anon/authenticated granted).

**Acceptance Criteria:**
- Migration runs without error on a clean Supabase instance
- Migration is idempotent (safe to run twice)
- `activity_ef` has all columns defined in Section 3.1 with correct types, constraints, and indexes
- `daily_ef_trend` has all columns defined in Section 3.2 with correct types and indexes
- `athlete_notifications` now accepts `type = 'ef_alert'`
- RLS is disabled; anon/authenticated are granted SELECT, INSERT, UPDATE
- `NOTIFY pgrst, 'reload schema'` at end of file

**Dependencies:** None (prerequisite for EF-002, EF-003)

**Complexity:** S

---

### EF-002: Core Calculation Library (`lib/ef.ts` + tests)

**Description:** Implement all pure functions in `lib/ef.ts` as specified in Section 5. Write `__tests__/ef.test.ts` covering all functions including the 20-entry regression fixture.

**Acceptance Criteria:**
- All exports match the function signatures in Section 5
- `calculateEFFromLaps`: warmup exclusion correctly drops laps with cumulative elapsed < 600s; time-weighted averaging produces correct result
- `isQualifyingRun`: duration, temperature, and HR zone checks all implemented; correct precedence
- `computeRollingEFAvg`: correct date-window logic for both 30-day and 90-day windows
- `computeEFRegression`: returns null for < 3 points; correct slope/R² on linear data; TODO comment for polynomial extension present
- `detectEFAlert`: 5% threshold works in both directions
- `normalizeTempEF`: stub returns ef unchanged; TODO comment present referencing Section 21
- All unit tests pass (`npm test`)
- No imports from Supabase, AsyncStorage, or React Native

**Dependencies:** EF-001 (schema only needed to understand column expectations; code can be written independently)

**Complexity:** M

---

### EF-003: Supabase I/O Pipeline (`lib/efRecalc.ts`)

**Description:** Implement `recalculateEF()` and `backfillEFWithTempAdjustment()` as specified in Section 6. Import `resolveHRZones()` from `lib/hrZones.ts` (implemented in EF-004). Add `triggerEFRecalc()` wrapper to `gapRecalc.ts` (EF-005 integration point).

**Acceptance Criteria:**
- `recalculateEF(fromDate?)` runs without error against development Supabase
- GAP fallback logic: activities with `activity_gap.gap_applied = true` and ascent > 100m → `gap_used = true` in `activity_ef`; others → `gap_used = false`
- Warmup exclusion applied at lap level (delegates to `calculateEFFromLaps`)
- Qualifying filter applied using resolved HR zones
- `activity_ef` rows upserted on conflict `(athlete_id, activity_id)`
- `daily_ef_trend` rows upserted on conflict `(athlete_id, date)`
- `ef_slope` and `ef_slope_r2` populated when ≥ 3 qualifying activities exist
- Alert notification inserted into `athlete_notifications` when 30d vs 90d EF change > 5%
- `backfillEFWithTempAdjustment()` is exported as a stub returning `{ ok: true, count: 0 }`
- Module constants match those in Section 6.1

**Dependencies:** EF-001, EF-002, EF-004

**Complexity:** L

---

### EF-004: HR Zone Utility Extraction (`lib/hrZones.ts` refactor)

**Description:** Add `resolveHRZones(): Promise<HRZones>` to `lib/hrZones.ts`, implementing the four-priority chain described in Section 4. Refactor `decouplingRecalc.ts` to import from the shared utility, replacing the private `resolveHRZoneThresholds()` function. All existing decoupling tests must continue to pass.

**Acceptance Criteria:**
- `resolveHRZones()` exported from `lib/hrZones.ts`
- Four-priority chain implemented as specified in Section 4.2
- Default zones (Priority 4) match the values in Section 4.2
- `decouplingRecalc.ts` no longer contains private `resolveHRZoneThresholds()`; uses `resolveHRZones()` instead
- Behavior of `decouplingRecalc.ts` is functionally unchanged (same zone classification outcomes)
- `npm test` passes (all existing decoupling and PMC tests continue to pass)

**Dependencies:** None (can be developed in parallel with EF-001/EF-002)

**Complexity:** S

---

### EF-005: Section 5 Integration + Backfill Trigger

**Description:** Wire `recalculateEF()` into the end of the GAP batch pipeline by adding `triggerEFRecalc()` to `gapRecalc.ts`. This ensures EF is automatically recomputed whenever new GAP data is written. Add a manual backfill entry point for initial population of `activity_ef` from all historical run activities.

**Acceptance Criteria:**
- `triggerEFRecalc(fromDate?)` exported from `lib/gapRecalc.ts` as a thin wrapper around `recalculateEF()`
- `computeGAPBatch()` calls `triggerEFRecalc()` after `triggerDecouplingBackfill()` (matching the Section 6 precedent for decoupling backfill)
- A standalone backfill call `recalculateEF()` (no `fromDate`) successfully populates `activity_ef` for all historical run activities on development Supabase
- `daily_ef_trend` populated correctly end-to-end after backfill
- `npm test` continues to pass (no regressions in GAP tests)

**Dependencies:** EF-003, EF-004

**Complexity:** S

---

## 10. Key Risks and Mitigations

### Risk 1: Sparse Qualifying Easy-Run Data

**Risk:** Many athletes train across all intensities; Z1–Z2 filter may yield too few qualifying activities for a meaningful regression trendline.

**Mitigation:**
- `computeEFRegression()` returns `null` when fewer than 3 qualifying entries exist; downstream consumers must handle `null` gracefully
- `n_qualifying_30d` and `n_qualifying_90d` are stored in `daily_ef_trend` so the UI can show "insufficient data" messaging
- The 5% alert is not triggered when `rolling_90d_ef` is null (guard in `detectEFAlert()`)
- The qualifying filter is intentionally not extended with additional criteria at this stage — tightening the filter reduces the already-sparse dataset further

### Risk 2: GAP Data Gaps

**Risk:** `activity_gap` may not exist for all run activities (Section 6 must have been run first; old activities may predate the migration).

**Mitigation:**
- `gap_used = false` is the safe default; EF falls back to raw pace seamlessly
- `calculateEFFromLaps()` handles null `gap_pace_sec_per_km` on every lap record — no crash path
- `activity_ef.gap_used` column allows downstream querying to identify which activities used GAP vs. raw pace, providing transparency and future backfill opportunity

### Risk 3: Section 21 Stub Creates Dead Code

**Risk:** `normalizeTempEF()` ships as a permanent stub if Section 21 is delayed; `temp_adjusted = false` and `ef_temp_adjusted = null` rows accumulate.

**Mitigation:**
- The seam is clean: only `lib/ef.ts:normalizeTempEF()` needs to change when Section 21 ships
- `backfillEFWithTempAdjustment()` is the Section 21 entry point — its signature is already in place, preventing the need for Section 21 to discover/design the backfill interface
- `temp_adjusted` boolean allows filtering to identify rows needing backfill at any future point

### Risk 4: HR Zone Resolution Returns Default Zones for New Athletes

**Risk:** An athlete with no AsyncStorage HR zones and no LTHR set will receive default zones (180 bpm max HR assumed), which may misclassify effort tiers and incorrectly qualify or disqualify activities.

**Mitigation:**
- Default zones are documented in Section 4.2 with explicit bpm values
- `disqualification_reason` in `activity_ef` makes the filter outcome transparent and auditable
- Section 7 has no personalization ticket; the four-priority chain is a best-effort approach that degrades gracefully rather than failing

### Risk 5: `elapsed_time_seconds` Null in `garmin_activity_laps`

**Risk:** The warmup exclusion depends on `elapsed_time_seconds` being present. If Garmin FIT files lack cumulative elapsed time, all laps would have `elapsed_time_seconds = null`, causing the warmup exclusion to skip all laps or no laps depending on implementation.

**Mitigation:**
- `calculateEFFromLaps()` treats a null `elapsed_time_seconds` as "exclude this lap" (conservative: drop rather than include with uncertain timing)
- If all laps have null `elapsed_time_seconds`, `calculateEFFromLaps()` returns null → `insufficient_laps` disqualification
- This is consistent with the decoupling implementation in `lib/decoupling.ts` which has the same dependency on `elapsed_time_seconds`

---

## 11. Design Decisions

This section summarizes the five resolved TPM product decisions that shape this TDD. Full entries are in `docs/agent-decision-log.md`.

### Decision 1: Cycling EF Deferred to Section 12
**Log entry:** 2026-03-08 "Section 7 — Cycling EF Deferred to Section 12"

Cycling EF requires normalized power (NP), which is a Section 12 deliverable. The `activity_ef` schema includes `sport TEXT CHECK (sport IN ('run', 'cycle'))` to accommodate cycling EF in the future without a schema migration. No cycling EF code is written in Section 7. `efRecalc.ts` filters `garmin_activities` to runs only via `ilike '%run%'`.

### Decision 2: Warmup Exclusion via Lap-Drop (10-Minute Threshold)
**Log entry:** 2026-03-08 "Section 7 — Warmup Exclusion Uses Lap-Drop Approach"

Laps with cumulative `elapsed_time_seconds < 600` are dropped in full. This is the same mechanism as Section 5 (documented in the 2026-03-07 "Warmup Exclusion Mechanism via Laps" decision). Partial lap boundary splitting is not implemented; conservative full-lap exclusion is appropriate given the data granularity.

### Decision 3: HR Zone Resolution via Shared `resolveHRZones()` Utility
**Log entry:** 2026-03-08 "Section 7 — HR Zone Filtering Uses Shared resolveHRZones Utility"

The four-priority chain (AsyncStorage → LTHR → lap hrz_* columns → default) is extracted into `lib/hrZones.ts` rather than duplicated in `efRecalc.ts`. `decouplingRecalc.ts` is refactored to use the same shared function. This eliminates divergence risk if the resolution chain is updated.

### Decision 4: Linear Regression Only (Polynomial Deferred)
**Log entry:** 2026-03-08 "Section 7 — Regression Type: Linear Only for Initial Implementation"

Linear regression is the correct choice for sparse easy-run data where polynomial fits would overfit. `computeEFRegression()` returns slope, intercept, and R². A `TODO` comment in `lib/ef.ts` marks the polynomial extension point for a future iteration with sufficient data.

### Decision 5: Section 21 Temperature Normalization via Stub
**Log entry:** 2026-03-08 "Section 7 — Section 21 Dependency Handled via Stub Pattern" (implicit in TPM intake resolution)

`normalizeTempEF(ef, tempC, refTempC=15)` is shipped as a pass-through stub in `lib/ef.ts`. `temp_adjusted = false` and `ef_temp_adjusted = null` are stored on all `activity_ef` rows until Section 21 ships. `backfillEFWithTempAdjustment()` in `lib/efRecalc.ts` is the Section 21 entry point and is also a no-op stub today. The seam is clean: only `normalizeTempEF()` needs a real implementation.
