# Section 4 — Training Monotony & Strain: Ticket Prompts

**Section:** 4
**Author:** Prompt Engineer
**Date:** 2026-03-09
**Source TDD:** `docs/output/section-4-tech-design.md`

---

## Ticket 1

**ID:** MON-001
**Title:** Implement pure monotony/strain calculation library (`lib/monotony.ts`) + unit tests

### Context

Training Monotony and Strain are rolling 7-day metrics defined by Foster (1998). Monotony = mean daily load / population stdev; Strain = weekly load sum × monotony. A NULL monotony (caused by a zero-stdev window or by having fewer than 7 days of history) never triggers an alert. This pure library has no I/O and no Supabase dependency — it is the calculation core that MON-002's pipeline will call.

The library must handle three independent sport series:
- `run`: only activities matching `sport ILIKE '%run%'`, weight 1.0
- `cycle`: only activities matching `sport ILIKE '%cycl%'`, weight 1.0
- `combined`: all activities, with run weighted 1.0, cycle weighted 0.5, and **all other sports weighted 1.0**

Note on the `combined` series weight for "other" sports: any activity whose sport string does not contain `'run'` or `'cycl'` (case-insensitive) receives a weight of 1.0. This mirrors the `sportWeight()` function in `lib/pmcRecalc.ts` exactly.

### File to Create

- `lib/monotony.ts` — pure TypeScript module, zero runtime imports (no Supabase, no pmc.ts)

### Implementation Spec

#### Step 1 — Copy UTC date helpers as private module-level functions

Do **not** import from `lib/pmc.ts` (those helpers are not exported). Copy them verbatim as private functions inside `lib/monotony.ts`:

```typescript
function parseISODate(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDay(d: Date): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function todayISO(): string {
  return toISODate(new Date());
}
```

Using UTC-only arithmetic avoids DST drift across the date range.

#### Step 2 — Export `SPORT_WEIGHTS` constant

```typescript
export const SPORT_WEIGHTS = {
  run: 1.0,
  cycle: 0.5,
} as const;
```

#### Step 3 — Export interfaces

```typescript
export interface MonotonyStrainDay {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Population mean / stdev over the 7-day window ending on this date.
   *  NULL when stdev = 0 (degenerate case) or when fewer than 7 days of
   *  history are available (days 1–6). */
  monotony: number | null;
  /** Weekly load sum * monotony. When monotony is NULL due to stdev=0,
   *  equals the weekly load sum only (no multiplier).
   *  NULL on days 1–6 (partial window). */
  strain: number | null;
}
```

#### Step 4 — Implement `calculateMonotony`

```typescript
export function calculateMonotony(dailyLoads: number[]): number | null {
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

- Uses **population** stdev (divide by N=7, not N-1).
- Returns `null` when stdev is below floating-point epsilon (`< 1e-9`).
- Throws on wrong-length input — the caller is responsible for supplying exactly 7 values.

#### Step 5 — Implement `calculateStrain`

```typescript
export function calculateStrain(dailyLoads: number[]): number {
  const weeklySum = dailyLoads.reduce((s, v) => s + v, 0);
  const monotony = calculateMonotony(dailyLoads);
  if (monotony === null) return weeklySum;
  return weeklySum * monotony;
}
```

When monotony is `null` (zero-stdev degenerate case), strain equals the raw weekly sum with no multiplier.

#### Step 6 — Implement private `sportWeight` helper

```typescript
function sportWeight(sport: string): number {
  const s = sport.toLowerCase();
  if (s.includes('run')) return SPORT_WEIGHTS.run;   // 1.0
  if (s.includes('cycl')) return SPORT_WEIGHTS.cycle; // 0.5
  return 1.0; // all other sports (neither run nor cycle) — weight 1.0
}
```

#### Step 7 — Implement `calculateMonotonyStrain`

```typescript
export function calculateMonotonyStrain(
  activities: { date: string; tss: number; sport: string }[],
  sport: 'run' | 'cycle' | 'combined',
): MonotonyStrainDay[]
```

Full algorithm:

1. **Return `[]` immediately if `activities` is empty.**

2. **Filter and weight by `sport`:**
   - `'run'`: keep rows where `row.sport.toLowerCase().includes('run')`, use `tss * 1.0`.
   - `'cycle'`: keep rows where `row.sport.toLowerCase().includes('cycl')`, use `tss * 1.0`.
   - `'combined'`: keep **all** rows, apply `sportWeight(row.sport)` to each TSS value. Sports that are neither run nor cycle receive weight 1.0.

3. **Aggregate by date:** sum weighted TSS values for all activities on the same calendar day into a `Map<string, number>`. Multiple activities on the same date accumulate.

4. **Determine date range:** earliest date key in the map → `todayISO()` (same pattern as `calculatePMC` in `lib/pmc.ts`). Use the UTC date helpers copied in Step 1.

5. **Build a contiguous daily load array:** walk from `startDate` through `endDate` day by day. For each date, look up the map value (default 0 if no activity — rest days contribute 0). This produces a `number[]` covering the entire range with no gaps.

6. **Rolling 7-day window:** iterate over the daily load array by index `i` (0-based):
   - If `i < 6`: emit `{ date, monotony: null, strain: null }` — partial window, not enough history.
   - If `i >= 6`: extract `dailyLoads = loadArray.slice(i - 6, i + 1)` (7 values ending on today's index). Call `calculateMonotony(dailyLoads)` and `calculateStrain(dailyLoads)`. Emit `{ date, monotony, strain }`.

7. **Round output before returning:**
   - `monotony`: `Math.round(monotony * 10000) / 10000` (4 decimal places). Leave `null` as `null`.
   - `strain`: `Math.round(strain * 100) / 100` (2 decimal places). Leave `null` as `null`.
   - Rounding prevents floating-point drift in stored values, consistent with `round1` in `lib/pmc.ts`.

8. **Return** the full array from `startDate` through today.

#### Verification examples (use in unit tests)

**Example A — degenerate (zero stdev):**
```
dailyLoads = [60, 60, 60, 60, 60, 60, 60]
mean  = 60, stdev = 0  →  monotony = null
strain = 420  (weekly sum, no multiplier)
```

**Example B — normal varied week:**
```
dailyLoads = [80, 0, 60, 0, 100, 50, 20]
sum   = 310
mean  = 310 / 7 ≈ 44.286
variance = ((80-44.286)² + (0-44.286)² + (60-44.286)² + (0-44.286)²
           + (100-44.286)² + (50-44.286)² + (20-44.286)²) / 7
         ≈ 1161.22 / 7 ≈ 165.89  →  stdev ≈ 12.88
monotony ≈ 44.286 / 12.88 ≈ 3.44
strain   = 310 * 3.44 ≈ 1066.4
```

**Example C — combined series same-day run+cycle:**
```
run activity:   tss=100, sport='running'   → weighted: 100 * 1.0 = 100
cycle activity: tss=100, sport='cycling'   → weighted: 100 * 0.5 = 50
combined day load = 150
```

**Example D — partial window (6 days of data):**
```
All 6 returned rows have monotony: null, strain: null
```

### Unit Tests

Write tests in a file at `__tests__/monotony.test.ts` (or wherever the project's existing test suite expects — check `npm test` configuration). Tests must pass via `npm test`.

### Acceptance Criteria

1. `calculateMonotony([60,60,60,60,60,60,60])` returns `null` (zero stdev).
2. `calculateMonotony([80,0,60,0,100,50,20])` returns a value matching the hand-calculated result within 0.001.
3. `calculateStrain([60,60,60,60,60,60,60])` returns `420` (weekly sum, no multiplier).
4. `calculateStrain([80,0,60,0,100,50,20])` returns `weeklySum * monotony` within 0.01.
5. `calculateMonotonyStrain([], 'combined')` returns `[]`.
6. For a dataset with exactly 6 days: all returned rows have `monotony: null, strain: null`.
7. For a dataset with 7 days: the last row has non-null monotony and strain; the first 6 rows have nulls.
8. Combined sport series: a run activity with `active_load=100` and a cycle activity on the same date with `active_load=100` contributes `100 + 50 = 150` to that day's combined load.
9. `SPORT_WEIGHTS` constant is exported and equals `{ run: 1.0, cycle: 0.5 }`.
10. `calculateMonotony` throws if input length !== 7.
11. All unit tests pass via `npm test`.

### Dependencies

None. This is a pure TypeScript module with no Supabase dependency and no imports from other project files.

---

## Ticket 2

**ID:** MON-002
**Title:** Add `daily_monotony_strain` SQL table and `lib/monotonyRecalc.ts` recalculation pipeline

### Context

This ticket wires the pure `lib/monotony.ts` library (MON-001) to Supabase. It creates the persistence table and the recalculation pipeline that reads `garmin_activities`, calls `calculateMonotonyStrain`, and upserts results. The pipeline pattern mirrors `lib/pmcRecalc.ts` exactly: same `SINGLE_ATHLETE_ID` placeholder, same `MAX_BACKFILL_DAYS` cap, same 500-row batch upsert, same `Promise.all` parallel orchestration for multi-sport runs.

A note on partial windows and what gets stored: days 1–6 from the earliest activity date produce `strain: null`. These rows are **not** stored in `daily_monotony_strain`. Only rows with non-null strain are upserted. This keeps the table clean and ensures that downstream queries (including `checkAndEmitAlerts` in MON-003) can assume all stored rows represent complete 7-day windows.

A note on the 90-day history concept used in MON-003 alerting: "90 days of history" means 90 rows in `daily_monotony_strain` where `sport = 'combined'` for the athlete (not 90 calendar days). Rows with `strain IS NULL` are not stored, so SQL `AVG()` over stored rows naturally excludes NULLs — no special handling needed.

### Files to Create

- `sql/daily_monotony_strain.sql` — run once in the Supabase SQL editor
- `lib/monotonyRecalc.ts` — Supabase read + upsert pipeline

### Implementation Spec

#### Part A — SQL Migration (`sql/daily_monotony_strain.sql`)

Create the file with exactly this content:

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

Schema notes:
- `BIGSERIAL` primary key (not `UUID`) — this table accumulates 3 rows/day and a sequential integer is more storage-efficient for a high-insert append table.
- `NUMERIC` (not `FLOAT`) — avoids floating-point artifacts in a metric users read directly. The pipeline rounds values before upsert, so precision is controlled at the application layer.
- The `UNIQUE (athlete_id, date, sport)` constraint is the upsert conflict target, matching the `daily_pmc_values` pattern.

**Prerequisite:** `daily_pmc_values.sql` must have been run first (it creates the `athletes` table that `daily_monotony_strain` references via foreign key).

#### Part B — Recalculation Pipeline (`lib/monotonyRecalc.ts`)

##### Module-level constants

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

##### Exported interfaces

```typescript
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
```

##### `recalculateMonotony(fromDate?, sport?): Promise<RecalcResult>`

```typescript
export async function recalculateMonotony(
  fromDate?: string,
  sport?: 'run' | 'cycle' | 'combined',
): Promise<RecalcResult>
```

If `sport` is omitted, delegate to `recalculateAllMonotonySports(fromDate)` and return the `combined` result. (Alternatively, callers who need all three sports should call `recalculateAllMonotonySports` directly.)

**Algorithm for a single sport (when `sport` is provided):**

1. **Determine cutoff date:**
   ```typescript
   const cutoff = fromDate ?? earliestAllowedDate();
   ```
   Where `earliestAllowedDate()` is a private helper:
   ```typescript
   function earliestAllowedDate(): string {
     const d = new Date();
     d.setUTCDate(d.getUTCDate() - MAX_BACKFILL_DAYS);
     return d.toISOString().slice(0, 10);
   }
   ```

2. **Fetch activities from Supabase.** Base query for all sports:
   ```typescript
   supabase
     .from('garmin_activities')
     .select('start_time, active_load, sport')
     .not('active_load', 'is', null)
     .gte('start_time', cutoff)
     .order('start_time', { ascending: true })
   ```
   Then add a sport filter for `'run'` and `'cycle'` (not for `'combined'`):
   - `'run'`: chain `.ilike('sport', '%run%')`
   - `'cycle'`: chain `.ilike('sport', '%cycl%')`
   - `'combined'`: no additional filter — all activities are fetched; the library applies weights.

3. **Map rows to the activity array:**
   ```typescript
   const activities = (data ?? []).map((row) => ({
     date: row.start_time.slice(0, 10),
     tss: row.active_load as number,
     sport: row.sport ?? '',
   }));
   ```

4. **Call the pure library:**
   ```typescript
   const days = calculateMonotonyStrain(activities, sport);
   ```

5. **Filter to non-null strain rows only:**
   ```typescript
   const rows = days.filter((d) => d.strain !== null);
   ```
   Days 1–6 return `strain: null` and must not be stored. Storing null-strain rows would create confusing table entries for dates that have no complete 7-day window.

6. **Return early if no rows:**
   ```typescript
   if (rows.length === 0) return { ok: true, rowsUpserted: 0 };
   ```

7. **Batch upsert in chunks of 500:**
   ```typescript
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
   ```

8. **Return:**
   ```typescript
   return { ok: true, rowsUpserted: rows.length };
   ```
   Wrap the entire function body in `try/catch` and return `{ ok: false, error: e?.message ?? 'Unknown error' }` on any exception.

##### `recalculateAllMonotonySports(fromDate?): Promise<RecalcAllResult>`

Run all three series in parallel using `Promise.all`, mirroring `recalculateAllSports()` in `lib/pmcRecalc.ts`:

```typescript
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
```

### Acceptance Criteria

1. Running `daily_monotony_strain.sql` creates the table with the correct schema: columns `id`, `athlete_id`, `date`, `sport`, `monotony` (nullable), `strain` (nullable), `created_at`; UNIQUE on `(athlete_id, date, sport)`.
2. CHECK constraint on `sport` rejects values outside `('run', 'cycle', 'combined')`.
3. Both indexes (`idx_daily_monotony_strain_athlete_date`, `idx_daily_monotony_strain_athlete_sport_date`) are created.
4. `recalculateMonotony('2025-01-01', 'combined')` fetches activities, calls `calculateMonotonyStrain`, and upserts results. Running it twice does not produce duplicate rows (upsert idempotency).
5. Rows for days 1–6 (partial window) are **not** stored in the table (null strain rows are filtered before upsert).
6. `recalculateAllMonotonySports()` runs all three series in parallel and returns `{ run: RecalcResult, cycle: RecalcResult, combined: RecalcResult }`.
7. With no qualifying activities for a sport, `recalculateMonotony` returns `{ ok: true, rowsUpserted: 0 }` without error.
8. Batch upsert processes rows in chunks of 500 (no single payload exceeds Supabase size limits).

### Dependencies

- MON-001 must be complete (`lib/monotony.ts` must exist and export `calculateMonotonyStrain`).
- `daily_pmc_values.sql` must have been run in the Supabase project (provides the `athletes` table referenced by the foreign key).

---

## Ticket 3

**ID:** MON-003
**Title:** Add monotony/strain alert emission (`checkAndEmitAlerts`) and extend `athlete_notifications` schema

### Context

This ticket adds the alerting layer on top of the recalculation pipeline built in MON-002. `checkAndEmitAlerts` reads today's combined-series row from `daily_monotony_strain`, evaluates monotony and strain thresholds, and inserts a row into `athlete_notifications` when the thresholds are exceeded.

**Alert scope note:** `checkAndEmitAlerts` checks only the `combined` sport series. Per-sport alerting (run-only or cycle-only monotony alerts) is explicitly deferred to a future ticket — do not implement it here. Add a code comment in `checkAndEmitAlerts` to document this:
```typescript
// Per-sport (run/cycle) alerting is explicitly deferred — see docs/output/section-4-tech-design.md §10.5
```

**90-day strain history clarification:** The `day_count >= 90` guard means 90 rows in `daily_monotony_strain` where `sport = 'combined'` for the athlete, NOT 90 calendar days. Because partial-window rows (days 1–6) are never stored, every row in the table represents a complete 7-day window. SQL `AVG()` excludes NULLs automatically, so no special NULL handling is needed in the query.

**Severity levels:**
- `'High'`: `monotony >= 2.0` AND `strain > avg_90d * 1.5` AND `>= 90` prior combined-series rows exist.
- `'Medium'`: `monotony >= 1.8` AND `monotony < 2.0` — no strain threshold required; this is an informational early warning.
- Neither threshold met OR `monotony IS NULL`: no alert.

### Files to Create

- `sql/athlete_notifications_monotony.sql` — extends the `type` CHECK constraint

### Files to Modify

- `lib/monotonyRecalc.ts` — add `AlertResult` interface and `checkAndEmitAlerts()` function

### Implementation Spec

#### Part A — SQL Migration (`sql/athlete_notifications_monotony.sql`)

The `type` CHECK constraint on `athlete_notifications` must be extended. The established pattern (from `activity_gap.sql`, `activity_decoupling.sql`, `activity_ef.sql`) is to drop the constraint by name and recreate it with the new value set.

Create the file with exactly this content:

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

Constraint history (for reference — do not alter prior migrations):

| Migration file | Types added |
|---|---|
| `athlete_notifications.sql` | personalization_available, model_updated, more_data_needed |
| `activity_decoupling.sql` | + decoupling_anomaly |
| `activity_gap.sql` | + gap_anomaly |
| `activity_ef.sql` | + ef_alert |
| `athlete_notifications_monotony.sql` | + high_monotony_strain |

#### Part B — `checkAndEmitAlerts` in `lib/monotonyRecalc.ts`

Add the following to `lib/monotonyRecalc.ts`. Do not remove or alter `recalculateMonotony` or `recalculateAllMonotonySports`.

##### New exported interface

```typescript
export interface AlertResult {
  ok: boolean;
  alertsEmitted?: number;
  error?: string;
}
```

##### Alert message templates

```typescript
const ALERT_MESSAGES = {
  High: (monotony: number, strain: number) =>
    `Training monotony is high (${monotony.toFixed(2)}) and strain (${Math.round(strain)}) exceeds your 90-day average by 50%. Consider adding an easy or rest day.`,
  Medium: (monotony: number) =>
    `Training monotony is approaching a high level (${monotony.toFixed(2)}). Varying session intensity can reduce overtraining risk.`,
};
```

##### Full function implementation

```typescript
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
```

Add this private helper at the module level (not exported):

```typescript
function subtractDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

Also add a private `todayISO` helper if it is not already present in the module:

```typescript
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
```

### Acceptance Criteria

1. Running `athlete_notifications_monotony.sql` extends the `type` CHECK constraint to include `'high_monotony_strain'` without error. Running it twice does not error (idempotent via `DROP CONSTRAINT IF EXISTS`).
2. `checkAndEmitAlerts()` for a date where `monotony > 2.0` AND `strain > avg_90d * 1.5` AND `>= 90` combined-series rows exist in `daily_monotony_strain` prior to that date: inserts a row into `athlete_notifications` with `type='high_monotony_strain'`, `confidence_label='High'`.
3. `checkAndEmitAlerts()` for a date where `monotony` is in `[1.8, 2.0)`: inserts with `confidence_label='Medium'` regardless of strain threshold.
4. `checkAndEmitAlerts()` for a date where `monotony < 1.8`: inserts nothing.
5. `checkAndEmitAlerts()` for a date where `monotony > 2.0` but fewer than 90 combined-series rows exist prior to that date: inserts nothing (no alert until history is sufficient).
6. `checkAndEmitAlerts()` for a date where `monotony IS NULL` (stdev=0 or partial window): inserts nothing.
7. Running `checkAndEmitAlerts()` twice for the same date does not insert duplicate rows (deduplication by `athlete_id + type + confidence_label + created_at::date`).
8. The `message` field contains a human-readable description including the current monotony value rounded to 2 decimal places.

### Dependencies

- MON-002 must be complete (`lib/monotonyRecalc.ts` and `daily_monotony_strain` table must exist and have been populated with data for the combined series).
- `athlete_notifications_monotony.sql` must be run in the Supabase project before calling `checkAndEmitAlerts()` (otherwise the `type` CHECK will reject the insert).
- `activity_ef.sql` must have been run before `athlete_notifications_monotony.sql` (the constraint drop-and-recreate includes `'ef_alert'` which was added by that migration).
