# Section 4 — Training Monotony & Strain: Technical Design Document

**Section:** 4
**Author:** Staff Engineer Lead
**Date:** 2026-03-09
**Status:** Draft

---

## 1. Overview

This document describes the technical design for PRD Section 4: Training Monotony & Strain. The feature computes rolling 7-day monotony and strain metrics (Foster 1998) across three sport series (run, cycle, combined), persists the results to a dedicated table, and emits alerts to `athlete_notifications` when thresholds are exceeded.

All product decisions referenced below are documented in `docs/agent-decision-log.md` (entries dated 2026-03-09) and reflected in the PRD clarifications at Section 4.5.

---

## 2. Background: Foster (1998) Definitions

```
daily_loads   = [TSS_day1, TSS_day2, ..., TSS_day7]   # 7-day window
mean          = sum(daily_loads) / 7
stdev         = population standard deviation (N=7)
monotony      = mean / stdev
strain        = sum(daily_loads) * monotony
```

Rest days contribute TSS=0, which increases stdev and reduces monotony — this is the protective signal the metric is designed to detect.

**Edge case — stdev = 0 (all seven loads identical):**
`monotony = NULL`, `strain = sum(daily_loads)` (no multiplication). A NULL monotony never triggers any alert.

**Partial windows (days 1–6):**
Both monotony and strain are NULL for any date where a full 7-day lookback is unavailable.

---

## 3. Architecture

### 3.1 Component Map

```
lib/monotony.ts              ← Pure calculation (no I/O)
lib/monotonyRecalc.ts        ← Supabase read + upsert pipeline
sql/daily_monotony_strain.sql      ← New table migration
sql/athlete_notifications_monotony.sql  ← CHECK constraint extension
```

### 3.2 Data Flow

```
garmin_activities (active_load, sport, start_time)
        │
        ▼ monotonyRecalc.ts reads + sums per calendar day
lib/monotony.ts :: calculateMonotonyStrain()
        │
        ▼ rolling 7-day windows
daily_monotony_strain (one row per athlete × date × sport)
        │
        ▼ monotonyRecalc.ts :: checkAndEmitAlerts()
athlete_notifications (type='high_monotony_strain')
```

### 3.3 Sport Series

Three independent series are computed and stored separately:

| sport     | TSS source                              | Weight          |
|-----------|-----------------------------------------|-----------------|
| `run`     | `active_load` where sport ILIKE '%run%' | 1.0 (raw)       |
| `cycle`   | `active_load` where sport ILIKE '%cycl%'| 1.0 (raw)       |
| `combined`| all sports                              | run×1.0, cycle×0.5, other×1.0 |

This mirrors the PMC pipeline's sport handling in `pmcRecalc.ts` (`sportWeight()` function and `W_RUN`/`W_CYCLE` constants).

### 3.4 Singleton Athlete ID

Until authentication is implemented, all rows use the placeholder:
`SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001'`
(consistent with `pmcRecalc.ts`).

---

## 4. Pure Library: `lib/monotony.ts`

### 4.1 Exported Interface

```typescript
/** Sport weight constants for the combined series. */
export const SPORT_WEIGHTS = {
  run: 1.0,
  cycle: 0.5,
} as const;

export interface MonotonyStrainDay {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Population mean / stdev over the 7-day window ending on this date.
   *  NULL when stdev = 0 (degenerate case) or when fewer than 7 days of
   *  history are available (days 1–6). */
  monotony: number | null;
  /** Weekly load sum * monotony. When monotony is NULL, equals the weekly
   *  load sum only (no multiplier). NULL on days 1–6. */
  strain: number | null;
}
```

### 4.2 `calculateMonotony(dailyLoads: number[]): number | null`

- **Input:** exactly 7 numeric values (0 = rest day). Caller guarantees length === 7.
- **Algorithm:**
  1. Compute `mean = sum / 7`.
  2. Compute population stdev: `sqrt(sum((x - mean)^2) / 7)`.
  3. If `stdev === 0` (or below a floating-point epsilon, e.g. `< 1e-9`): return `null`.
  4. Return `mean / stdev`.
- **No side effects. No I/O.**

```typescript
export function calculateMonotony(dailyLoads: number[]): number | null {
  // length guard — caller must supply exactly 7 values
  if (dailyLoads.length !== 7) {
    throw new Error(`calculateMonotony requires exactly 7 values, got ${dailyLoads.length}`);
  }
  const mean = dailyLoads.reduce((s, v) => s + v, 0) / 7;
  const variance = dailyLoads.reduce((s, v) => s + (v - mean) ** 2, 0) / 7;
  const stdev = Math.sqrt(variance);
  if (stdev < 1e-9) return null;
  return mean / stdev;
}
```

### 4.3 `calculateStrain(dailyLoads: number[]): number`

- **Input:** exactly 7 numeric values.
- **Algorithm:**
  1. `weeklySum = sum(dailyLoads)`.
  2. `monotony = calculateMonotony(dailyLoads)`.
  3. If `monotony === null`: return `weeklySum`.
  4. Return `weeklySum * monotony`.

```typescript
export function calculateStrain(dailyLoads: number[]): number {
  const weeklySum = dailyLoads.reduce((s, v) => s + v, 0);
  const monotony = calculateMonotony(dailyLoads);
  if (monotony === null) return weeklySum;
  return weeklySum * monotony;
}
```

### 4.4 `calculateMonotonyStrain(activities, sport): MonotonyStrainDay[]`

**Signature:**
```typescript
export function calculateMonotonyStrain(
  activities: { date: string; tss: number; sport: string }[],
  sport: 'run' | 'cycle' | 'combined',
): MonotonyStrainDay[]
```

**Algorithm:**

1. **Filter and weight** by `sport`:
   - `'run'`: keep rows where `row.sport.toLowerCase().includes('run')`, weight = 1.0.
   - `'cycle'`: keep rows where `row.sport.toLowerCase().includes('cycl')`, weight = 1.0.
   - `'combined'`: keep all rows, apply `sportWeight(row.sport)` (run=1.0, cycle=0.5, other=1.0).

2. **Aggregate by date:** sum weighted TSS values for activities on the same calendar day into a `Map<string, number>`. Multiple activities on the same date are summed.

3. **Determine date range:** earliest activity date → today (same pattern as `calculatePMC` in `lib/pmc.ts`). Use UTC date arithmetic to avoid DST drift.

4. **Build daily load array:** for each date in the range, look up the map (0 if no activity). This produces a full `number[]` for the entire range.

5. **Rolling 7-day window:** for each date at index `i` (0-based from start):
   - If `i < 6`: emit `{ date, monotony: null, strain: null }` (partial window).
   - If `i >= 6`: extract `dailyLoads = loadArray[i-6 .. i]` (7 values, ending on this date). Call `calculateMonotony` and `calculateStrain`. Emit `{ date, monotony, strain }`.

6. **Return** the full array from earliest date through today.

**Round output:** monotony to 4 decimal places, strain to 2 decimal places (consistent with PMC's `round1` helper pattern — prevents floating-point drift in stored values without losing meaningful precision).

**Empty input:** return `[]`.

### 4.5 Helper: `sportWeight(sport: string): number`

```typescript
function sportWeight(sport: string): number {
  const s = sport.toLowerCase();
  if (s.includes('run')) return SPORT_WEIGHTS.run;   // 1.0
  if (s.includes('cycl')) return SPORT_WEIGHTS.cycle; // 0.5
  return 1.0; // all other sports, consistent with pmcRecalc.ts
}
```

Intentionally mirrors the logic of `sportWeight()` in `pmcRecalc.ts` so the combined series is consistent between PMC and Monotony.

### 4.6 Date Helper Notes

Copy the UTC-only date helpers from `lib/pmc.ts` (`parseISODate`, `toISODate`, `addDay`, `todayISO`) as private module-level functions rather than importing them (they are not exported from `pmc.ts`). This keeps `lib/monotony.ts` a standalone pure module with no runtime imports.

---

## 5. SQL Migration: `sql/daily_monotony_strain.sql`

### 5.1 Table Definition

```sql
-- MON-002: daily_monotony_strain table
--
-- Stores per-athlete, per-day rolling 7-day monotony and strain values.
-- One row per athlete × date × sport. Upsert key: (athlete_id, date, sport).
--
-- monotony is nullable: NULL when stdev = 0 (degenerate case) or when fewer
-- than 7 days of history exist (days 1–6 from the earliest activity date).
--
-- strain is nullable for the same partial-window reason (days 1–6).
-- When monotony is NULL but a full window exists, strain = weekly TSS sum.
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
-- Prerequisites: athletes table must exist (created by daily_pmc_values.sql).

CREATE TABLE IF NOT EXISTS daily_monotony_strain (
    id           BIGSERIAL    PRIMARY KEY,
    athlete_id   UUID         NOT NULL REFERENCES athletes(id),
    date         DATE         NOT NULL,
    sport        TEXT         NOT NULL
                              CHECK (sport IN ('run', 'cycle', 'combined')),
    monotony     NUMERIC,     -- nullable: stdev=0 case or partial window
    strain       NUMERIC,     -- nullable: partial window only (days 1-6)
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, date, sport)
);

-- Primary query pattern: fetch all values for an athlete in a date range
CREATE INDEX IF NOT EXISTS idx_daily_monotony_strain_athlete_date
    ON daily_monotony_strain (athlete_id, date);

-- Sport-filtered date range queries (per-sport trend analysis)
CREATE INDEX IF NOT EXISTS idx_daily_monotony_strain_athlete_sport_date
    ON daily_monotony_strain (athlete_id, sport, date);

-- Access control (RLS disabled -- consistent with all other tables in this project)
GRANT SELECT, INSERT, UPDATE ON daily_monotony_strain TO anon, authenticated;

ALTER TABLE daily_monotony_strain DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

### 5.2 Schema Notes

- `BIGSERIAL` primary key (vs. `UUID` in `daily_pmc_values`) because this table will accumulate 3 rows/day and a sequential integer is more storage-efficient for a high-insert append table.
- `NUMERIC` (variable precision) rather than `FLOAT` to avoid storage of misleading floating-point artifacts in a metric that users read directly. The recalc pipeline rounds values before upsert, so the effective precision is controlled at the application layer.
- The `UNIQUE (athlete_id, date, sport)` constraint is the upsert conflict target, matching `daily_pmc_values` pattern.

---

## 6. Recalculation Pipeline: `lib/monotonyRecalc.ts`

### 6.1 Module Overview

```typescript
import { supabase } from './supabase';
import {
  calculateMonotonyStrain,
  type MonotonyStrainDay,
} from './monotony';

const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';
const MAX_BACKFILL_DAYS = 365 * 4;
const BATCH = 500;
```

### 6.2 `recalculateMonotony(fromDate?, sport?): Promise<RecalcResult>`

**Signature:**
```typescript
export async function recalculateMonotony(
  fromDate?: string,
  sport?: 'run' | 'cycle' | 'combined',
): Promise<RecalcResult>
```

If `sport` is omitted, defaults to running all three series via `recalculateAllMonotonySports(fromDate)`.

**Algorithm for a single sport:**

1. **Determine cutoff date:** `fromDate ?? earliestAllowedDate()` (same `MAX_BACKFILL_DAYS` cap as `pmcRecalc.ts`).

2. **Fetch activities from Supabase:**
   ```sql
   SELECT start_time, active_load, sport
   FROM garmin_activities
   WHERE active_load IS NOT NULL
     AND start_time >= :cutoff
   ORDER BY start_time ASC
   ```
   For sport-specific queries, add the `ILIKE` filter matching `pmcRecalc.ts`:
   - `'run'`: `.ilike('sport', '%run%')`
   - `'cycle'`: `.ilike('sport', '%cycl%')`
   - `'combined'`: no sport filter (all activities fetched, weights applied in library).

3. **Map to activity array:** `{ date: row.start_time.slice(0, 10), tss: row.active_load, sport: row.sport ?? '' }`.

4. **Call** `calculateMonotonyStrain(activities, resolvedSport)`.

5. **Filter to non-null strain rows only** for upsert (days 1–6 produce `strain: null` and need not be stored — they would be confusing if queried and are re-derived on every recalc).

6. **Batch upsert** in chunks of 500:
   ```typescript
   await supabase
     .from('daily_monotony_strain')
     .upsert(chunk, { onConflict: 'athlete_id,date,sport' });
   ```
   Each row: `{ athlete_id: SINGLE_ATHLETE_ID, date, sport, monotony, strain }`.

7. Return `{ ok: true, rowsUpserted: rows.length }` or `{ ok: false, error }` on exception.

### 6.3 `recalculateAllMonotonySports(fromDate?): Promise<RecalcAllResult>`

```typescript
export interface RecalcAllResult {
  run: RecalcResult;
  cycle: RecalcResult;
  combined: RecalcResult;
}

export async function recalculateAllMonotonySports(
  fromDate?: string,
): Promise<RecalcAllResult>
```

Runs all three series in parallel using `Promise.all`, mirroring `recalculateAllSports()` in `pmcRecalc.ts`.

### 6.4 `checkAndEmitAlerts(asOfDate?): Promise<AlertResult>`

**Signature:**
```typescript
export interface AlertResult {
  ok: boolean;
  alertsEmitted?: number;
  error?: string;
}

export async function checkAndEmitAlerts(
  asOfDate?: string,
): Promise<AlertResult>
```

**Algorithm:**

1. **Resolve target date:** `asOfDate ?? todayISO()`.

2. **Fetch today's combined-series row** from `daily_monotony_strain`:
   ```sql
   SELECT monotony, strain
   FROM daily_monotony_strain
   WHERE athlete_id = :athlete_id
     AND date = :asOfDate
     AND sport = 'combined'
   ```
   If no row or `monotony IS NULL`: return `{ ok: true, alertsEmitted: 0 }` (NULL monotony never alerts).

3. **Monotony threshold check:**
   - If `monotony >= 2.0`: candidate for 'High' alert. Proceed to strain check.
   - If `monotony >= 1.8 AND monotony < 2.0`: candidate for 'Medium' warning. Strain check is not required for Medium (informational only).
   - If `monotony < 1.8`: no alert, return early.

4. **90-day rolling strain average** (required before any High alert; skip for Medium):
   ```sql
   SELECT AVG(strain) AS avg_strain_90d, COUNT(*) AS day_count
   FROM daily_monotony_strain
   WHERE athlete_id = :athlete_id
     AND sport = 'combined'
     AND date >= :asOfDate::date - INTERVAL '89 days'
     AND date < :asOfDate::date
     AND strain IS NOT NULL
   ```
   - If `day_count < 90` (fewer than 90 prior days of strain data): **no High alert fires**. Per PQ-5, the system requires enough history to compute a non-NULL 90-day average before alerting.
   - Compute `threshold = avg_strain_90d * 1.5`.

5. **Determine severity:**
   - `monotony >= 2.0 AND strain > threshold AND day_count >= 90`: severity = `'High'`, type = `'high_monotony_strain'`.
   - `monotony >= 1.8 AND monotony < 2.0`: severity = `'Medium'`, type = `'high_monotony_strain'`.
   - Otherwise: no alert.

6. **Deduplication:** Before inserting, check whether an alert of the same `type` and `confidence_label` was already emitted for the same `athlete_id` on the same `date`:
   ```sql
   SELECT id FROM athlete_notifications
   WHERE athlete_id = :athlete_id
     AND type = 'high_monotony_strain'
     AND created_at::date = :asOfDate
   ```
   If a row exists: skip insertion (idempotent — avoid duplicate alerts on re-run).

7. **Insert into `athlete_notifications`:**
   ```typescript
   {
     athlete_id: SINGLE_ATHLETE_ID,
     sport: 'combined',
     type: 'high_monotony_strain',
     message: <human-readable string — see §6.5>,
     confidence_label: 'High' | 'Medium',
     r_squared: null,
     ci_width: null,
   }
   ```

8. Return `{ ok: true, alertsEmitted: 1 }` or `{ ok: true, alertsEmitted: 0 }`.

### 6.5 Alert Message Templates

```
High:   "Training monotony is high ({monotony:.2f}) and strain ({strain:.0f})
         exceeds your 90-day average by 50%. Consider adding an easy or rest day."

Medium: "Training monotony is approaching a high level ({monotony:.2f}).
         Varying session intensity can reduce overtraining risk."
```

### 6.6 `RecalcResult` Interface

```typescript
export interface RecalcResult {
  ok: boolean;
  rowsUpserted?: number;
  error?: string;
}
```

---

## 7. SQL Migration: `sql/athlete_notifications_monotony.sql`

The `type` CHECK constraint on `athlete_notifications` must be extended to include `'high_monotony_strain'`. The established pattern (used in `activity_gap.sql`, `activity_decoupling.sql`, and `activity_ef.sql`) is: drop the existing constraint by name and recreate it with the new value set.

```sql
-- MON-003: Extend athlete_notifications type CHECK to include 'high_monotony_strain'
--
-- Idempotent — safe to run multiple times (DROP CONSTRAINT IF EXISTS).
-- Prerequisites:
--   - athlete_notifications table must exist (created by athlete_notifications.sql)
--   - activity_ef.sql must have run (establishes 'ef_alert' in the constraint)

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
        'ef_alert',
        'high_monotony_strain'
    ));

NOTIFY pgrst, 'reload schema';
```

**Constraint history (for future maintainers):**

| Migration file                          | Types added                              |
|-----------------------------------------|------------------------------------------|
| `athlete_notifications.sql`             | personalization_available, model_updated, more_data_needed |
| `activity_decoupling.sql`               | + decoupling_anomaly                     |
| `activity_gap.sql`                      | + gap_anomaly                            |
| `activity_ef.sql`                       | + ef_alert                               |
| `athlete_notifications_monotony.sql`    | + high_monotony_strain                   |

---

## 8. Calculation Verification Examples

### 8.1 Normal Week (varies daily)

```
daily_loads = [80, 0, 60, 0, 100, 50, 20]
sum   = 310
mean  = 310 / 7 = 44.286
variance = ((80-44.286)² + (0-44.286)² + ... + (20-44.286)²) / 7
         ≈ 1161.22 / 7 = 165.89 → stdev ≈ 12.88
monotony = 44.286 / 12.88 ≈ 3.44   ← likely alert (monotony > 2.0 if strain also high)
strain   = 310 * 3.44 ≈ 1066.4
```

Wait — a week with rest days (0s) still shows high monotony when the non-zero days are very high. This is correct per Foster 1998: monotony reflects variation, and a big spike surrounded by zeros can produce high monotony.

### 8.2 Rest Day-Heavy Week (protective)

```
daily_loads = [100, 0, 0, 80, 0, 0, 70]
sum   = 250
mean  = 35.71
stdev ≈ 40.8
monotony ≈ 0.875   ← low monotony, well-varied
strain   = 250 * 0.875 = 218.75
```

### 8.3 Degenerate Zero-StDev Case

```
daily_loads = [60, 60, 60, 60, 60, 60, 60]
sum   = 420
stdev = 0
monotony = NULL
strain   = 420   (weekly sum, no multiplier)
```

### 8.4 Partial Window (day 5)

```
Only 5 days of data available since first activity
monotony = NULL
strain   = NULL
```

---

## 9. Ticket Breakdown

### MON-001: Pure Library (`lib/monotony.ts`) + Unit Tests

**Title:** Implement pure monotony/strain calculation library

**Files to create:**
- `lib/monotony.ts`

**Files to modify:**
- (none — pure new module)

**Acceptance Criteria:**
1. `calculateMonotony([60,60,60,60,60,60,60])` returns `null` (zero stdev).
2. `calculateMonotony([80,0,60,0,100,50,20])` returns a value matching hand-calculated result within 0.001.
3. `calculateStrain([60,60,60,60,60,60,60])` returns `420` (weekly sum, no multiplier).
4. `calculateStrain([80,0,60,0,100,50,20])` returns `weeklySum * monotony` within 0.01.
5. `calculateMonotonyStrain([], 'combined')` returns `[]`.
6. For a dataset with exactly 6 days: all returned rows have `monotony: null, strain: null`.
7. For a dataset with 7 days: the last row has non-null monotony and strain; the first 6 rows have nulls.
8. Combined sport series: a run activity with `active_load=100` and a cycle activity on the same date with `active_load=100` contributes `100 + 50 = 150` to that day's combined load.
9. `SPORT_WEIGHTS` constant is exported and equals `{ run: 1.0, cycle: 0.5 }`.
10. `calculateMonotony` throws if input length !== 7.
11. All unit tests pass via `npm test`.

**Dependencies:** None (pure TypeScript, no Supabase).

---

### MON-002: SQL Migration + Recalculation Pipeline

**Title:** Add `daily_monotony_strain` table and `lib/monotonyRecalc.ts` pipeline

**Files to create:**
- `sql/daily_monotony_strain.sql`
- `lib/monotonyRecalc.ts`

**Files to modify:**
- (none)

**Acceptance Criteria:**
1. Running `daily_monotony_strain.sql` creates the table with the correct schema: columns `id`, `athlete_id`, `date`, `sport`, `monotony` (nullable), `strain` (nullable), `created_at`; UNIQUE on `(athlete_id, date, sport)`.
2. CHECK constraint on `sport` rejects values outside `('run', 'cycle', 'combined')`.
3. Both indexes (`idx_daily_monotony_strain_athlete_date`, `idx_daily_monotony_strain_athlete_sport_date`) are created.
4. `recalculateMonotony('2025-01-01', 'combined')` fetches activities, calls `calculateMonotonyStrain`, and upserts results. Running it twice does not produce duplicate rows (upsert idempotency).
5. Rows for days 1–6 (partial window) are **not** stored in the table (null strain rows are filtered before upsert).
6. `recalculateAllMonotonySports()` runs all three series in parallel and returns `{ run: RecalcResult, cycle: RecalcResult, combined: RecalcResult }`.
7. With no qualifying activities for a sport, `recalculateMonotony` returns `{ ok: true, rowsUpserted: 0 }` without error.
8. Batch upsert processes rows in chunks of 500 (no single payload exceeds Supabase size limits).

**Dependencies:** MON-001 (requires `lib/monotony.ts`); `daily_pmc_values.sql` must have run (provides `athletes` table).

---

### MON-003: Alert Emission + `athlete_notifications` Schema Migration

**Title:** Add monotony/strain alert emission and extend notifications schema

**Files to create:**
- `sql/athlete_notifications_monotony.sql`

**Files to modify:**
- `lib/monotonyRecalc.ts` — add `checkAndEmitAlerts()` function

**Acceptance Criteria:**
1. Running `athlete_notifications_monotony.sql` extends the `type` CHECK constraint to include `'high_monotony_strain'` without error. Running it twice does not error (idempotent via `DROP CONSTRAINT IF EXISTS`).
2. `checkAndEmitAlerts()` for a date where `monotony > 2.0` AND `strain > avg_90d * 1.5` AND `>= 90 days` of strain history exist: inserts a row into `athlete_notifications` with `type='high_monotony_strain'`, `confidence_label='High'`.
3. `checkAndEmitAlerts()` for a date where `monotony` is in `[1.8, 2.0)`: inserts with `confidence_label='Medium'` regardless of strain threshold.
4. `checkAndEmitAlerts()` for a date where `monotony < 1.8`: inserts nothing.
5. `checkAndEmitAlerts()` for a date where `monotony > 2.0` but fewer than 90 days of strain history exist: inserts nothing (no alert until history is sufficient).
6. `checkAndEmitAlerts()` for a date where `monotony IS NULL` (stdev=0 or partial window): inserts nothing.
7. Running `checkAndEmitAlerts()` twice for the same date does not insert duplicate rows (deduplication by `athlete_id + type + created_at::date`).
8. The `message` field contains a human-readable description including the current monotony value rounded to 2 decimal places.

**Dependencies:** MON-002 (requires `daily_monotony_strain` table and recalculation pipeline to produce values to check against).

---

## 10. Key Design Decisions

### 10.1 No Race K-Factor Applied to Monotony TSS

The PMC pipeline applies race k-factors to ATL TSS (`effective_tss_race`) to model fatigue from races. Monotony uses raw `active_load` for all activities, with no race k-factor adjustment.

**Rationale:** Monotony measures *training pattern variability*, not accumulated fatigue. A race is a high-load stimulus that contributes to monotony via its raw load value — a race with monotony-context loads should register as a high-load day, which is physiologically correct. Applying a k-factor < 1 would artificially deflate the race day's contribution, masking the true pattern of the preceding week. The PMC's k-factor is a fitting-engine artifact for predicting long-term adaptation; it is not appropriate for a metric designed to detect *lack of within-week variation*.

### 10.2 `calculateMonotonyStrain` Dates Through Today

Like `calculatePMC`, the output array extends through today's date even if there are no activities in recent days. This ensures the table always has current data and the alert pipeline has a row to check.

### 10.3 Partial Window Rows Not Stored

Days 1–6 produce `null` strain and are not stored in `daily_monotony_strain`. This keeps the table clean (no NULL-strain rows) and avoids confusion in downstream queries that assume all stored rows represent complete 7-day windows.

### 10.4 90-Day Alert History Computed from `daily_monotony_strain`

The 90-day rolling strain average for the High alert threshold is computed directly from `daily_monotony_strain` at alert-emission time, not pre-stored. This avoids a separate "baseline" table and is consistent with query-time aggregation used elsewhere (e.g., the EF trend baseline).

### 10.5 Combined Series for Alerts Only

`checkAndEmitAlerts` checks only the `combined` sport series for alerts. Per-sport series (run, cycle) are stored for trend analysis and future UI use but do not trigger their own alerts in this implementation. This is consistent with the PRD's framing of monotony as an overall load-variability signal.

---

## 11. File Creation Summary

| File | Action | Ticket |
|------|--------|--------|
| `lib/monotony.ts` | Create | MON-001 |
| `sql/daily_monotony_strain.sql` | Create | MON-002 |
| `lib/monotonyRecalc.ts` | Create | MON-002, MON-003 |
| `sql/athlete_notifications_monotony.sql` | Create | MON-003 |

No existing files are modified in Phase 2 except `lib/monotonyRecalc.ts` (modified in MON-003 to add `checkAndEmitAlerts`).

---

## 12. Open Items / Deferred Scope

| Item | Status | Future ticket |
|------|--------|---------------|
| Adaptive ML correlation model (correlating high-strain weeks with subsequent EF decline) | Deferred per PQ-5 | Future |
| Per-sport (run/cycle) alert emission | Out of scope for MON-003 | Future |
| UI components to display monotony/strain chart | Out of scope for Section 4 | Section 7 or future |
| `recalculateMonotony` trigger on new activity sync | Out of scope; caller is responsible | Future integration |
