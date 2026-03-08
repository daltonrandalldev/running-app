# Section 7 — Running Efficiency Factor (EF): Implementation Ticket Prompts

**Author:** Prompt Engineer
**Date:** 2026-03-08
**TDD:** `docs/output/section-7-tech-design.md`
**Section:** 7 (Running: Efficiency Factor)

---

## Ticket 1

**EF-001: Create the SQL migration for `activity_ef` and `daily_ef_trend` tables.**

### Summary

Write an idempotent SQL migration file that creates the `activity_ef` and `daily_ef_trend` tables, extends the `athlete_notifications` CHECK constraint to include `'ef_alert'`, disables RLS, and grants access to `anon` and `authenticated` roles — following the exact structure and conventions of `sql/activity_gap.sql`.

### File to Create

- `sql/activity_ef.sql`

### What to Write

The migration must be safe to run multiple times (idempotent). Use `IF NOT EXISTS` for all `CREATE TABLE` and `CREATE INDEX` statements. Use `DROP CONSTRAINT IF EXISTS` before re-adding the `athlete_notifications` CHECK constraint. End the file with `NOTIFY pgrst, 'reload schema';`.

**Table 1: `activity_ef`**

One row per activity. Upsert key: `(athlete_id, activity_id)`.

```sql
CREATE TABLE IF NOT EXISTS activity_ef (
    id                       SERIAL           PRIMARY KEY,
    athlete_id               UUID             NOT NULL REFERENCES athletes(id),
    activity_id              TEXT             NOT NULL,
    date                     DATE             NOT NULL,
    sport                    TEXT             NOT NULL DEFAULT 'run'
                                              CHECK (sport IN ('run', 'cycle')),
    ef_value                 DOUBLE PRECISION NOT NULL,
    gap_used                 BOOLEAN          NOT NULL DEFAULT false,
    qualifying               BOOLEAN          NOT NULL DEFAULT false,
    disqualification_reason  TEXT             CHECK (disqualification_reason IN (
                                                 'duration_too_short',
                                                 'temp_out_of_range',
                                                 'hr_outside_z2',
                                                 'insufficient_laps'
                                             )),
    temp_c                   DOUBLE PRECISION,
    temp_adjusted            BOOLEAN          NOT NULL DEFAULT false,
    ef_temp_adjusted         DOUBLE PRECISION,
    computed_at              TIMESTAMPTZ      NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, activity_id)
);
```

Create the following indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_activity_ef_athlete_date
    ON activity_ef (athlete_id, date);

CREATE INDEX IF NOT EXISTS idx_activity_ef_qualifying
    ON activity_ef (athlete_id, qualifying, date)
    WHERE qualifying = true;
```

**Table 2: `daily_ef_trend`**

One row per `(athlete_id, date)`. Upsert key: `(athlete_id, date)`.

```sql
CREATE TABLE IF NOT EXISTS daily_ef_trend (
    id                   SERIAL           PRIMARY KEY,
    athlete_id           UUID             NOT NULL REFERENCES athletes(id),
    date                 DATE             NOT NULL,
    rolling_30d_ef       DOUBLE PRECISION,
    rolling_90d_ef       DOUBLE PRECISION,
    ef_slope             DOUBLE PRECISION,
    ef_slope_r2          DOUBLE PRECISION,
    n_qualifying_30d     INTEGER          NOT NULL DEFAULT 0,
    n_qualifying_90d     INTEGER          NOT NULL DEFAULT 0,
    computed_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, date)
);
```

Create the following index:

```sql
CREATE INDEX IF NOT EXISTS idx_daily_ef_trend_athlete_date
    ON daily_ef_trend (athlete_id, date);
```

**`athlete_notifications` Extension**

Extend the existing CHECK constraint (last modified in `sql/activity_gap.sql`) to add `'ef_alert'`. Use the drop-and-recreate pattern:

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

**Access Control**

```sql
GRANT SELECT, INSERT, UPDATE ON activity_ef      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON daily_ef_trend   TO anon, authenticated;

ALTER TABLE activity_ef     DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_ef_trend  DISABLE ROW LEVEL SECURITY;
```

### Acceptance Criteria

1. Migration runs without error on a clean Supabase instance.
2. Migration is idempotent — running it twice produces no errors and no duplicate objects.
3. `activity_ef` contains all columns listed above with correct types, defaults, and CHECK constraints.
4. `daily_ef_trend` contains all columns listed above with correct types and defaults.
5. Both indexes on `activity_ef` exist (`idx_activity_ef_athlete_date`, `idx_activity_ef_qualifying`).
6. The partial index on `activity_ef` uses `WHERE qualifying = true`.
7. `idx_daily_ef_trend_athlete_date` index exists on `daily_ef_trend`.
8. `athlete_notifications` accepts `type = 'ef_alert'` without constraint violation.
9. `athlete_notifications` still accepts all previously valid `type` values (`personalization_available`, `model_updated`, `more_data_needed`, `decoupling_anomaly`, `gap_anomaly`).
10. RLS is disabled on both new tables.
11. `anon` and `authenticated` are granted `SELECT, INSERT, UPDATE` on both new tables.
12. File ends with `NOTIFY pgrst, 'reload schema';`.

### Dependencies

None. This ticket is a prerequisite for EF-002 (schema context) and EF-003 (tables must exist before upserts).

### TDD Reference

Section 3 (Database Schema) — sections 3.1, 3.2, 3.3, 3.4.

### Pattern Reference

Follow `sql/activity_gap.sql` exactly for file structure, comment style, section headers, and access control block ordering.

---

## Ticket 2

**EF-002: Implement the pure EF calculation library (`lib/ef.ts`) and its unit tests (`__tests__/ef.test.ts`).**

### Summary

Write `lib/ef.ts` — a zero-I/O, zero-external-dependency TypeScript module — exporting all 7 functions and types specified below. Write `__tests__/ef.test.ts` using Jest, covering every function including a 20-entry regression fixture. No imports from Supabase, AsyncStorage, or React Native are permitted.

### Files to Create

- `lib/ef.ts`
- `__tests__/ef.test.ts`

### Types and Exports

**Type definitions (export all of these from `lib/ef.ts`):**

```typescript
export interface EFLapRecord {
  lap: number;
  moving_time_seconds: number | null;
  elapsed_time_seconds: number | null;  // cumulative elapsed from activity start
  distance: number | null;              // meters
  avg_hr: number | null;
  gap_pace_sec_per_km: number | null;   // from lap_gap table; null if GAP not computed
}

export interface EFFromLapsResult {
  efValue: number;
  lapCount: number;
  gapUsed: boolean;
}

export interface QualifyingResult {
  qualifying: boolean;
  reason?: 'duration_too_short' | 'temp_out_of_range' | 'hr_outside_z2' | 'insufficient_laps';
}

export interface EFRegressionResult {
  slope: number;       // EF per day (positive = improving)
  intercept: number;   // EF at day 0 (epoch baseline)
  rSquared: number;    // Coefficient of determination [0, 1]
}

// Re-export from hrZones.ts for convenience (do not redefine):
export type { HRZoneBounds, HRZones } from './hrZones';
```

**Function signatures (implement all 7):**

```typescript
export function calculateEFRun(speedMps: number, avgHR: number): number | null

export function calculateEFFromLaps(laps: EFLapRecord[]): EFFromLapsResult | null

export function isQualifyingRun(params: {
  movingTimeSec: number;
  avgHR: number;
  zones: HRZones;
  avgTempC: number | null;
}): QualifyingResult

export function computeRollingEFAvg(
  entries: Array<{ date: string; efValue: number }>,
  windowDays: number,
  referenceDate?: string
): number | null

export function computeEFRegression(
  entries: Array<{ date: string; efValue: number }>
): EFRegressionResult | null

export function detectEFAlert(
  avg30d: number,
  avg90d: number,
  threshold?: number
): boolean

export function normalizeTempEF(
  ef: number,
  tempC: number,
  refTempC?: number
): number
```

### Implementation Specifications

**`calculateEFRun(speedMps, avgHR)`**
- Returns `ef = speedMps / avgHR`.
- Returns `null` if `avgHR <= 0` or `speedMps <= 0` (defensive guard — Engineer 2 requirement).
- `speedMps` is derived by the caller (not inside this function): use `1000 / gap_pace_sec_per_km` when GAP available, or `distance_m / moving_time_seconds` for raw pace.

**`calculateEFFromLaps(laps)`**
- Warmup exclusion: drop any lap where `elapsed_time_seconds` is `null` OR `elapsed_time_seconds < 600` (10-minute threshold, conservative full-lap exclusion — consistent with Section 5 precedent). Do not interpolate partial lap boundaries.
- For remaining (post-warmup) laps:
  - Skip laps where `moving_time_seconds` is null/zero or `avg_hr` is null/zero.
  - Compute speed per lap: use `1000 / gap_pace_sec_per_km` if `gap_pace_sec_per_km` is non-null; otherwise use `(distance ?? 0) / moving_time_seconds`.
  - Use **time-weighted** averaging (weight by `moving_time_seconds`): `weightedSpeedSum / totalWeight` and `weightedHRSum / totalWeight`, then call `calculateEFRun()` with the weighted averages.
  - Set `gapUsed = true` if any post-warmup lap used `gap_pace_sec_per_km`.
- Returns `null` if no valid post-warmup laps remain.
- `lapCount` in the result is the count of post-warmup laps that contributed to the weighted average.

**`isQualifyingRun(params)`**
- Evaluate disqualification conditions in this order (first failing condition wins):
  1. `movingTimeSec <= 1800` → `{ qualifying: false, reason: 'duration_too_short' }`
  2. `avgTempC` is non-null AND (`avgTempC > 27` OR `avgTempC < 0`) → `{ qualifying: false, reason: 'temp_out_of_range' }`. A null `avgTempC` does NOT disqualify on temperature.
  3. `avgHR > zones[1].max` OR `avgHR < zones[0].min` → `{ qualifying: false, reason: 'hr_outside_z2' }`
- If none of the above: `{ qualifying: true }`.
- Note: `'insufficient_laps'` is part of the `reason` type for schema consistency but is not evaluated inside this function — it is set by the caller when `calculateEFFromLaps` returns null.

**`computeRollingEFAvg(entries, windowDays, referenceDate?)`**
- Window: `[referenceDate - windowDays + 1, referenceDate]` inclusive (all dates as ISO strings `YYYY-MM-DD`).
- `referenceDate` defaults to today's date (use `new Date().toISOString().slice(0, 10)`).
- Returns the simple mean of `efValue` for all entries within the window.
- Returns `null` if no entries fall within the window.
- Input entries need not be sorted.

**`computeEFRegression(entries)`**
- Convert each entry's `date` to a numeric day index = days since the earliest date in the input set (so day 0 = earliest date, enabling interpretable slope units of EF/day).
- Fit ordinary least squares (OLS) linear regression: y = ef, x = day index.
- Standard R² formula: `R² = 1 - SS_res / SS_tot` where `SS_res = Σ(y_i - ŷ_i)²` and `SS_tot = Σ(y_i - ȳ)²`. When `SS_tot = 0` (all EF values identical), set `rSquared = 1.0`.
- Returns `null` when:
  - Fewer than 3 data points provided.
  - All entries have the same date (zero variance in x — regression undefined).
- Include a `TODO` comment at the polynomial extension point: `// TODO (Section 21): add computeEFPolynomialRegression() when qualifying run count grows`.

**`detectEFAlert(avg30d, avg90d, threshold?)`**
- Formula (per Engineer 2 specification): `|avg30d - avg90d| / avg90d > threshold`
- `threshold` defaults to `0.05` (5%).
- Returns `false` if `avg90d === 0` or either `avg30d` or `avg90d` is not a finite number.
- Returns `true` for both improvement (avg30d > avg90d by threshold) and decline (avg30d < avg90d by threshold).

**`normalizeTempEF(ef, tempC, refTempC = 15)`**
- Stub — return `ef` unchanged with no transformation.
- Suppress unused-variable warnings with `void tempC; void refTempC;`.
- Include the following TODO comment block verbatim:
```typescript
// TODO (Section 21): implement normalization.
// Suggested signature for the final implementation:
//   normalizeTempEF(ef, tempC, refTempC) → ef_normalized
//   using model: ef_adjusted = ef / (1 + k * (tempC - refTempC))
//   where k is a fitted per-athlete coefficient from Section 21.
// Reference: Ely et al. (2007) ~1% HR increase per 1°C above 10°C at threshold intensity.
```

### Test Requirements (`__tests__/ef.test.ts`)

Write Jest tests. All tests are pure — no Supabase, no AsyncStorage, no React Native imports.

**`calculateEFRun`**
- Basic: `calculateEFRun(0.04, 140)` ≈ `0.000286` (verify to 6 decimal places).
- Guard: `calculateEFRun(0, 140)` → `null`; `calculateEFRun(0.04, 0)` → `null`; negative inputs → `null`.

**`calculateEFFromLaps`**
- Warmup exclusion: provide 3 laps with cumulative `elapsed_time_seconds` of 480s, 780s, 1200s respectively — first two laps are dropped (< 600s), EF computed from lap 3 only.
- GAP usage: laps with `gap_pace_sec_per_km` set → `gapUsed = true`; all null → `gapUsed = false`.
- All-warmup scenario: every lap has `elapsed_time_seconds < 600` → returns `null`.
- Null `elapsed_time_seconds` laps are treated as warmup (dropped).
- Null `avg_hr` laps are skipped from weighting.
- Time-weighted average correctness: build 2 post-warmup laps with different `moving_time_seconds`; verify the weighted EF against a manual calculation.

**`isQualifyingRun`**
- Duration: `movingTimeSec = 1800` → disqualified (`'duration_too_short'`); `movingTimeSec = 1801` → passes duration check (may still fail HR/temp).
- Temperature: `avgTempC = 28` → `'temp_out_of_range'`; `avgTempC = 27` → passes temp check; `avgTempC = null` → does not disqualify.
- HR: `avgHR` above `zones[1].max` → `'hr_outside_z2'`; below `zones[0].min` → `'hr_outside_z2'`; within Z1–Z2 bounds → qualifies.
- Precedence: duration check fires before temp check (both would fail, reason is `'duration_too_short'`).

**`computeRollingEFAvg`**
- 30-day window: provide entries spanning 45 days; only entries in the most recent 30 days are included.
- Empty window: no entries within window → `null`.
- All entries on same day: returns mean of those entries.

**`computeEFRegression`**
- Fewer than 3 points → `null`.
- Perfect linear trend → slope matches expected value, `rSquared = 1.0`.
- Flat trend (all same EF value) → `slope = 0`, `rSquared = 1.0`.
- All entries have the same date → `null` (zero variance in x).

**`detectEFAlert`**
- 5% improvement: `avg30d = 1.05 * avg90d` → `true`.
- 4.9% improvement: `avg30d = 1.049 * avg90d` → `false`.
- 5% decline: `avg30d = 0.95 * avg90d` → `true`.
- No change: `avg30d = avg90d` → `false`.
- `avg90d = 0` → `false`.

**`normalizeTempEF` (stub)**
- Any numeric inputs → returns `ef` unchanged.
- Verify that changing `tempC` and `refTempC` does not alter the return value.

**Regression Fixture**

Include a fixture of 20 qualifying run entries spread across 90 days with known EF values. Assert that:
- `computeRollingEFAvg(entries, 30, lastDate)` matches a hand-calculated expected value.
- `computeRollingEFAvg(entries, 90, lastDate)` matches a hand-calculated expected value.
- `computeEFRegression(entries).slope` and `.rSquared` match expected values (compute externally and hard-code assertions).

This mirrors the regression fixture pattern from `gap.test.ts` (10-lap fixture) and the PMC regression suite.

### Acceptance Criteria

1. All 7 exports present with exact signatures from the TDD.
2. `calculateEFRun` returns `null` for `speedMps <= 0` or `avgHR <= 0`.
3. `calculateEFFromLaps` drops all laps with `elapsed_time_seconds < 600` or `elapsed_time_seconds = null`; time-weighted averaging is used.
4. `calculateEFFromLaps` returns `null` when no valid post-warmup laps exist.
5. `isQualifyingRun` evaluates duration before temperature before HR zone (first-match wins).
6. `isQualifyingRun` does not disqualify on null temperature.
7. `computeRollingEFAvg` window bounds are inclusive and the default reference date is today.
8. `computeRollingEFAvg` returns `null` for an empty window.
9. `computeEFRegression` returns `null` for fewer than 3 points and for zero x-variance.
10. `computeEFRegression` includes a `TODO` comment for the polynomial extension point.
11. `detectEFAlert` formula is `|avg30d - avg90d| / avg90d > threshold`; returns `false` when `avg90d = 0`.
12. `normalizeTempEF` is a pass-through stub with the required `TODO` comment block.
13. No imports from Supabase, AsyncStorage, or React Native anywhere in `lib/ef.ts`.
14. `npm test` passes with all new tests green.

### Dependencies

EF-001 (schema context only — code can be written independently). No runtime dependency on the tables.

### TDD Reference

Section 5 (Core Calculation Library) — sections 5.1 through 5.8.
Section 8.1 (Unit Tests) and 8.2 (Regression Fixture).
Section 11 (Design Decisions 2 and 4 — warmup exclusion mechanism and linear regression choice).

### Gotchas and Edge Cases

- The `elapsed_time_seconds` field is **cumulative from activity start**, not lap duration. Do not confuse with `moving_time_seconds` (which is the individual lap's moving duration).
- If all laps have `elapsed_time_seconds = null`, `calculateEFFromLaps` must return `null` (not crash and not produce a result using all laps).
- For `computeEFRegression`: the day index for regression must be computed from the **earliest date in the input set**, not from epoch or today. This ensures the slope is in EF/day and the intercept is interpretable.
- `normalizeTempEF` must use `void tempC; void refTempC;` to avoid TypeScript "unused variable" errors since this is a stub.

---

## Ticket 3

**EF-003: Implement the Supabase I/O pipeline (`lib/efRecalc.ts`).**

### Summary

Write `lib/efRecalc.ts` — the I/O layer for Running EF — which resolves HR zones, fetches run activities and lap records, computes EF per activity using functions from `lib/ef.ts`, upserts results to `activity_ef` and `daily_ef_trend`, and checks the 5% alert condition. Also export `backfillEFWithTempAdjustment()` as a no-op stub for Section 21.

### File to Create

- `lib/efRecalc.ts`

### Imports

```typescript
import { supabase } from './supabase';
import {
  calculateEFFromLaps,
  isQualifyingRun,
  computeRollingEFAvg,
  computeEFRegression,
  detectEFAlert,
  normalizeTempEF,
  type EFLapRecord,
} from './ef';
import { resolveHRZones } from './hrZones';  // EF-004 must be complete
```

### Module Constants

```typescript
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';
const BATCH_SIZE = 500;
const GAP_ASCENT_THRESHOLD_M = 100;
const EF_ALERT_THRESHOLD = 0.05;
```

`BATCH_SIZE = 500` matches `gapRecalc.ts` (Engineer 2 performance requirement).

### Exported Interfaces

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
```

### Exported Functions

```typescript
export async function recalculateEF(fromDate?: string): Promise<EFRecalcResult>

export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}>
```

### Implementation: `recalculateEF(fromDate?)`

Follow the sequential pattern from `gapRecalc.ts` — no `Promise.all` over activities. Wrap the entire function body in try/catch and return `{ ok: false, error: e?.message }` on any thrown error.

**Step 1 — Resolve HR zones**

```typescript
const zones = await resolveHRZones();
```

Resolve once; reuse for every activity in the batch.

**Step 2 — Fetch run activities**

Query `garmin_activities` for all rows where `sport ILIKE '%run%'` (matching Garmin sport values like `'running'`, `'trail_running'`). Select:

```
activity_id, start_time, moving_time_seconds, avg_hr, avg_temperature, ascent
```

If `fromDate` is provided, add `.gte('start_time', fromDate)`.

**Step 3 — Per-activity EF computation (sequential loop)**

For each activity row:

3a. Fetch laps from `garmin_activity_laps`:
```
SELECT lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr
WHERE activity_id = $1
ORDER BY lap ASC
```

3b. Fetch GAP data. Query `lap_gap` for `gap_pace_sec_per_km` per lap (keyed by `lap`). Query `activity_gap` for `gap_applied` and `total_ascent_m`.

3c. **GAP fallback decision** (activity-level): Use GAP speed as the EF numerator (set `gap_pace_sec_per_km` on `EFLapRecord`) when ALL of:
- `activity_gap` row exists
- `gap_applied = true`
- `total_ascent_m > GAP_ASCENT_THRESHOLD_M` (100 m)

If any condition fails, set `gap_pace_sec_per_km = null` on all laps (raw pace fallback).

When GAP is applicable: merge `lap_gap` data into lap records by matching on `lap` number. If a lap exists in `garmin_activity_laps` but has no corresponding row in `lap_gap`, leave `gap_pace_sec_per_km = null` for that specific lap (it will use raw pace; `gapUsed` at the activity level is still `true` if at least one post-warmup lap used GAP).

3d. Call `calculateEFFromLaps(laps)`. If it returns `null`:
- Increment `activitiesSkipped`.
- Do NOT upsert any row to `activity_ef` for this activity. Log the skip and continue.

3e. Call `isQualifyingRun({ movingTimeSec, avgHR, zones, avgTempC })` using values from the `garmin_activities` row.

3f. Call `normalizeTempEF(efResult.efValue, actRow.avg_temperature ?? 15)`. Because this is currently a stub, store `temp_adjusted = false` and `ef_temp_adjusted = null` in the upsert (do not store the stub's return value as `ef_temp_adjusted`).

3g. Upsert to `activity_ef` with `onConflict: 'athlete_id,activity_id'`:

```typescript
{
  athlete_id:              SINGLE_ATHLETE_ID,
  activity_id:             String(actRow.activity_id),
  date:                    String(actRow.start_time).slice(0, 10),
  sport:                   'run',
  ef_value:                efResult.efValue,
  gap_used:                efResult.gapUsed,
  qualifying:              qualifyingResult.qualifying,
  disqualification_reason: qualifyingResult.reason ?? null,
  temp_c:                  actRow.avg_temperature ?? null,
  temp_adjusted:           false,
  ef_temp_adjusted:        null,
}
```

**Step 4 — Compute rolling averages**

After the activity loop, query all `activity_ef` rows where `qualifying = true` for `SINGLE_ATHLETE_ID`, ordered by date ascending.

For each calendar date from the earliest qualifying activity date to today (inclusive), compute:
- `rolling_30d_ef = computeRollingEFAvg(entries, 30, date)`
- `rolling_90d_ef = computeRollingEFAvg(entries, 90, date)`
- `n_qualifying_30d = count of entries whose date falls in the 30-day window`
- `n_qualifying_90d = count of entries whose date falls in the 90-day window`

**Step 5 — Compute linear regression**

Using all qualifying activities (no date window restriction):
```typescript
const regressionResult = computeEFRegression(allQualifyingEntries);
```

Store the same `ef_slope` and `ef_slope_r2` on every `daily_ef_trend` row in this computation run (global trend as of the latest run date). Both are `null` when fewer than 3 qualifying activities exist.

**Step 6 — Upsert `daily_ef_trend`** (in batches of `BATCH_SIZE = 500`)

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

For the most recent date row in `daily_ef_trend` that has both `rolling_30d_ef` and `rolling_90d_ef` non-null:

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

Return `EFRecalcResult` with all counters and `alertTriggered`.

### Implementation: `backfillEFWithTempAdjustment()`

Stub — no-op for Section 21. Include the full comment block:

```typescript
/**
 * Backfill EF temperature adjustment across all activity_ef rows.
 *
 * When Section 21 delivers the normalization model:
 *   1. Query all activity_ef rows where temp_adjusted = false AND temp_c IS NOT NULL
 *   2. Call normalizeTempEF(ef_value, temp_c) -- which will no longer be a stub
 *   3. Update ef_temp_adjusted and set temp_adjusted = true
 *
 * This function is a stub -- it is a no-op until Section 21 ships.
 * TODO (Section 21): implement body.
 */
export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  return { ok: true, count: 0 };
}
```

### Acceptance Criteria

1. `recalculateEF(fromDate?)` runs without error against development Supabase.
2. Activities with `activity_gap.gap_applied = true` AND `total_ascent_m > 100` have `gap_used = true` in `activity_ef`; all others have `gap_used = false`.
3. Activities where `calculateEFFromLaps` returns `null` are skipped (no row upserted); they increment `activitiesSkipped`.
4. `activity_ef` rows are upserted with `onConflict: 'athlete_id,activity_id'` (idempotent).
5. `daily_ef_trend` rows are upserted with `onConflict: 'athlete_id,date'` (idempotent).
6. `ef_slope` and `ef_slope_r2` are non-null in `daily_ef_trend` only when 3+ qualifying activities exist.
7. Alert notification is inserted into `athlete_notifications` with `type = 'ef_alert'` when 30d vs 90d EF change exceeds 5%.
8. `backfillEFWithTempAdjustment()` is exported and returns `{ ok: true, count: 0 }` without making any Supabase calls.
9. All module constants match Section 6.1 of the TDD (`BATCH_SIZE = 500`, `GAP_ASCENT_THRESHOLD_M = 100`, `EF_ALERT_THRESHOLD = 0.05`).
10. Sequential processing — no `Promise.all` over activities.
11. Every exported async function has a top-level try/catch returning `{ ok: false, error: ... }` on failure.

### Dependencies

- **EF-001** — `activity_ef` and `daily_ef_trend` tables must exist.
- **EF-002** — all pure functions in `lib/ef.ts` must be implemented.
- **EF-004** — `resolveHRZones()` must be exported from `lib/hrZones.ts`.

### TDD Reference

Section 6 (Supabase I/O Pipeline) — sections 6.1 through 6.4.
Section 7.2 (Section 21 Backfill Stub).

### Gotchas and Edge Cases

- BATCH_SIZE = 500 for all upsert operations — do not upsert all rows at once (matches `gapRecalc.ts`).
- When no qualifying activities exist at all, the `daily_ef_trend` loop produces no rows. Do not crash — just return `trendRowsUpserted: 0`.
- The alert check queries the computed `daily_ef_trend` rows from Step 6, not a separate Supabase query. Find the most recent row with both 30d and 90d non-null from the in-memory `daily_ef_trend` array.
- `temp_adjusted` must always be `false` and `ef_temp_adjusted` must always be `null` in this implementation — do not store the stub's output value.
- Sport filter uses `ILIKE '%run%'` to match Garmin sport variants (`'running'`, `'trail_running'`, etc.). Only run sport activities should be processed.

---

## Ticket 4

**EF-004: Extract the shared `resolveHRZones()` utility into `lib/hrZones.ts` and refactor `lib/decouplingRecalc.ts` to use it.**

### Summary

Add `resolveHRZones(): Promise<HRZones>` to the existing `lib/hrZones.ts` file. This function implements a four-priority HR zone resolution chain. Then refactor `lib/decouplingRecalc.ts` to replace its private `resolveHRZoneThresholds()` function with a call to the new shared utility. Existing behavior of `decouplingRecalc.ts` must be preserved exactly — all existing tests must continue to pass.

### Files to Modify

- `lib/hrZones.ts` — add `resolveHRZones()` export (do not rewrite existing exports)
- `lib/decouplingRecalc.ts` — refactor to import and use `resolveHRZones()` from `lib/hrZones.ts`

**Do not rewrite `lib/hrZones.ts` from scratch.** Only add the new function alongside the existing `loadHRZones()`, `saveHRZones()`, and `getZoneForHR()` exports.

### New Export: `resolveHRZones()`

```typescript
export async function resolveHRZones(): Promise<HRZones>
```

`HRZones` is the existing type from `lib/hrZones.ts` — an array of 5 zone objects, each with `min` and `max` BPM bounds.

**Four-priority resolution chain:**

**Priority 1 — AsyncStorage HR zones:**
Call `loadHRZones()`. If it returns a non-null array with at least `zones[0]` and `zones[1]` populated (non-null), return it directly.

**Priority 2 — LTHR-derived zones:**
Call `loadLTHR()` (existing export from `lib/hrZones.ts` or derive from AsyncStorage). If it returns a non-null value, derive 5-zone boundaries using these percentages of LTHR:
```
Zone 1: [0,             LTHR × 0.80]
Zone 2: [LTHR × 0.80,  LTHR × 0.89]
Zone 3: [LTHR × 0.90,  LTHR × 0.93]
Zone 4: [LTHR × 0.94,  LTHR × 0.99]
Zone 5: [LTHR × 1.00,  999]
```
Round boundary values to integers.

**Priority 3 — Lap `hrz_*` columns:**
Query the most recent `garmin_activity_laps` row where `hrz_3_hr` and `hrz_4_hr` are both non-null. Back-calculate LTHR using `LTHR = hrz_3_hr / 0.90`, then apply the Priority 2 percentage table to derive all 5 zone boundaries.

**Priority 4 — Default zones (180 bpm assumed max HR):**
```
Zone 1: [0,   108]
Zone 2: [109, 126]
Zone 3: [127, 144]
Zone 4: [145, 162]
Zone 5: [163, 999]
```
Return this hardcoded array when all higher-priority sources are unavailable.

### Refactor: `lib/decouplingRecalc.ts`

Read the current `decouplingRecalc.ts` before making changes. The existing file contains a private function `resolveHRZoneThresholds()` (or equivalent) that implements a subset of the priority chain, returning zone 3 and 4 thresholds for `classifyEffortTier()`.

Replace that private function with:

```typescript
import { resolveHRZones } from './hrZones';

// Inside the relevant function:
const zones = await resolveHRZones();
const thresholds: HRZoneThresholds = {
  hrz_3_min: zones[2].min,
  hrz_4_min: zones[3].min,
};
```

Derive `HRZoneThresholds` from the fully resolved `HRZones` array using `zones[2].min` (zone 3 lower bound) and `zones[3].min` (zone 4 lower bound). This produces **functionally identical** behavior to the current implementation — only the code location changes.

Remove the private `resolveHRZoneThresholds()` function from `decouplingRecalc.ts` entirely.

### Acceptance Criteria

1. `resolveHRZones()` is exported from `lib/hrZones.ts`.
2. Priority 1: returns AsyncStorage zones when `loadHRZones()` returns a valid non-null result.
3. Priority 2: derives all 5 zone bounds from LTHR using the specified percentages when LTHR is available.
4. Priority 3: back-calculates zones from `hrz_3_hr` column using `LTHR = hrz_3_hr / 0.90`, then applies Priority 2 percentages.
5. Priority 4: returns the exact default zone values from the TDD when all other sources are unavailable (`[0,108]`, `[109,126]`, `[127,144]`, `[145,162]`, `[163,999]`).
6. `decouplingRecalc.ts` imports `resolveHRZones` from `./hrZones` and no longer contains a private `resolveHRZoneThresholds()` function (or equivalent).
7. The zone thresholds passed to `classifyEffortTier()` in `decouplingRecalc.ts` are derived as `zones[2].min` and `zones[3].min` from the resolved `HRZones`.
8. All existing tests pass without modification: `npm test` is green before and after this change.
9. The existing `loadHRZones()`, `saveHRZones()`, and `getZoneForHR()` exports in `lib/hrZones.ts` are unchanged.

### Dependencies

None. This ticket can be developed in parallel with EF-001 and EF-002. It is a prerequisite for EF-003.

### TDD Reference

Section 4 (HR Zone Resolution) — sections 4.1, 4.2, 4.3.

### Gotchas and Edge Cases

- Read `lib/decouplingRecalc.ts` and `lib/hrZones.ts` in full before writing any code. The exact names of existing private functions and the current resolution logic may differ from the TDD description. Preserve the observable behavior of `decouplingRecalc.ts` exactly — only the internals change.
- The LTHR percentages in Priority 2 may differ slightly from what `decouplingRecalc.ts` currently uses (82%/90%). The shared `resolveHRZones()` uses the values in Section 4.2 of the TDD. When deriving `HRZoneThresholds` from the resolved zones, use `zones[2].min` and `zones[3].min` — not hardcoded LTHR percentages — so that the logic chain is consistent regardless of which priority was used.
- Priority 3 queries Supabase. Add try/catch around the lap query; fall through to Priority 4 on any error.
- The `HRZones` type must be an array (not a record/object). Confirm the existing type definition before implementing.

---

## Ticket 5

**EF-005: Wire `recalculateEF()` into the post-GAP call chain in `lib/gapRecalc.ts`.**

### Summary

Add `triggerEFRecalc(fromDate?)` as a new exported function in `lib/gapRecalc.ts`, following the existing `triggerDecouplingBackfill()` pattern. Update `computeGAPBatch()` to call `triggerEFRecalc()` after `triggerDecouplingBackfill()`. This ensures EF is automatically recomputed after every GAP batch.

### Files to Modify

- `lib/gapRecalc.ts` — add `triggerEFRecalc()` export; update `computeGAPBatch()` call chain

### New Export: `triggerEFRecalc(fromDate?)`

Add this function to `lib/gapRecalc.ts`:

```typescript
import { recalculateEF } from './efRecalc';

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

This is a thin wrapper — no logic beyond error isolation. Pattern matches `triggerDecouplingBackfill()` exactly.

### Update `computeGAPBatch()`

After the existing `triggerDecouplingBackfill()` call, add the call to `triggerEFRecalc()`:

```typescript
const backfillResult = await triggerDecouplingBackfill();
const backfill_triggered = backfillResult.ok ? (backfillResult.count ?? 0) : 0;

await triggerEFRecalc(/* fromDate is not passed here; recalculate all */);
```

The updated call order in `computeGAPBatch()` is:
1. Loop over activities calling `computeGAPForActivity()` (existing)
2. `triggerDecouplingBackfill()` (existing)
3. `triggerEFRecalc()` (new)

Do not pass `fromDate` into `triggerEFRecalc()` from `computeGAPBatch()` — always recalculate all EF data after a GAP batch (full recalc is safe and ensures consistency).

### Backfill Stub Verification

Confirm that `backfillEFWithTempAdjustment()` is already exported from `lib/efRecalc.ts` (implemented in EF-003). No code change needed in this ticket for the stub — just verify it is present and exported.

### Acceptance Criteria

1. `triggerEFRecalc(fromDate?)` is exported from `lib/gapRecalc.ts`.
2. `triggerEFRecalc()` is a thin wrapper around `recalculateEF()` — no duplicated logic.
3. `computeGAPBatch()` calls `triggerEFRecalc()` after `triggerDecouplingBackfill()`.
4. Call order in `computeGAPBatch()` is: activity loop → `triggerDecouplingBackfill()` → `triggerEFRecalc()`.
5. Running `recalculateEF()` (no `fromDate`) against development Supabase successfully populates `activity_ef` for all historical run activities.
6. After a full backfill, `daily_ef_trend` is populated for all dates from the earliest qualifying run to today.
7. `npm test` passes — no regressions in existing GAP, PMC, or decoupling tests.
8. `backfillEFWithTempAdjustment()` is confirmed as exported from `lib/efRecalc.ts` (no action required if EF-003 is complete).

### Dependencies

- **EF-003** — `recalculateEF()` must be implemented in `lib/efRecalc.ts`.
- **EF-004** — `resolveHRZones()` must be exported from `lib/hrZones.ts` (required by EF-003, which EF-005 calls).

### TDD Reference

Section 7.1 (Sync Trigger Chain).
Section 7.2 (Section 21 Backfill Stub — verification only).

### Gotchas and Edge Cases

- Read `lib/gapRecalc.ts` in full before editing. The existing `computeGAPBatch()` function and `triggerDecouplingBackfill()` are the models for this ticket. Do not change their signatures or behavior.
- `BatchGAPResult` in `gapRecalc.ts` does not need a new field for EF results. The EF trigger is fire-and-forget from `computeGAPBatch()`'s perspective — errors from `triggerEFRecalc()` are not propagated into `BatchGAPResult` (consistent with how decoupling backfill errors are currently handled).
- Do not add `recalculateEF` as a direct import at the top of `gapRecalc.ts` if it would create a circular dependency. Import it inside `triggerEFRecalc()` if needed (dynamic import), or restructure to avoid the cycle. Check the import graph before committing.
