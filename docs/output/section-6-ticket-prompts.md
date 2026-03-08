# Section 6 Ticket Prompts

## Ticket 1

You are the Staff Engineer Lead implementing GAP-001: Core Calculation Library.

### Context

This ticket creates `lib/gap.ts` — the pure TypeScript calculation library for Grade Adjusted Pace (GAP) — and its companion test file `__tests__/gap.test.ts`. GAP normalizes running pace for elevation change using the Minetti et al. (2002) metabolic cost curve. This library has zero I/O and zero external dependencies. It is the foundation for GAP-002 (SQL migration), GAP-003 (Supabase pipeline), and GAP-004 (Section 5 backfill integration).

The library follows the identical pattern established by `lib/decoupling.ts`: pure functions, a private `round2()` helper, and no imports from Supabase, AsyncStorage, or React Native.

### Files to Read First

Read these files before writing any code:

1. `/Users/daltonrandall/Desktop/running-app/lib/decoupling.ts` — source of the `round2()` pattern, type definition style, and exported function structure to mirror
2. `/Users/daltonrandall/Desktop/running-app/__tests__/decoupling.test.ts` — source of the test file structure and `assert()` / `near()` helper pattern to mirror
3. `/Users/daltonrandall/Desktop/running-app/__tests__/pmc.test.ts` — secondary reference for test file conventions (plain Node, `node --experimental-strip-types`, no test framework)

### Exact Implementation Spec

#### File to create: `/Users/daltonrandall/Desktop/running-app/lib/gap.ts`

##### Constants

```typescript
/** Flat-ground metabolic cost from the Minetti curve: C(0) = 3.6 J/kg/m */
const C_FLAT = 3.6;

/** Minimum fractional grade (clamping lower bound). */
const GRADE_MIN = -0.40;

/** Maximum fractional grade (clamping upper bound). */
const GRADE_MAX = 0.45;
```

##### Private helper

Define `round2` as a private (non-exported) function, identical to the one in `lib/decoupling.ts`:

```typescript
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
```

##### Type Definitions (all exported)

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

##### `minettiCost(grade: number): number`

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

##### `clampGrade(grade: number): { grade: number; clamped: boolean }`

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

##### `lapGrade(ascent: number | null, descent: number | null, distanceKm: number): number`

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

##### `lapGapPace(actualPaceSecPerKm: number, grade: number): number`

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

##### `computeGAP(laps: GarminLap[]): GAPResult`

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

#### File to create: `/Users/daltonrandall/Desktop/running-app/__tests__/gap.test.ts`

Follow the exact pattern from `__tests__/decoupling.test.ts`:
- Header comment with run command: `node --experimental-strip-types __tests__/gap.test.ts`
- Import all exported functions and types from `../lib/gap.ts`
- Define local `assert(condition, msg)` and `near(a, b, tol)` helpers (copy from decoupling.test.ts)
- Organize tests into labeled sections with `console.log()` section headers
- Print `All tests passed` or exit with code 1 on failure

**Minetti curve tests** (implement all of the following):

| Test | Description | Expected |
|---|---|---|
| `minettiCost(0)` | Flat-ground baseline | 3.6 (exactly) |
| `minettiCost(0.10)` | 10% uphill | ~5.26 — verify that a 360 sec/km pace gives GAP pace ~245 sec/km (30-40% faster) |
| `minettiCost(-0.10)` | 10% downhill | ~2.48 — verify GAP pace is ~30% slower than actual |
| `minettiCost(0.45)` | Maximum uphill (clamped boundary) | Positive, > 3.6 |
| `minettiCost(-0.40)` | Maximum downhill (clamped boundary) | Positive (curve rises again at steep downhills) |
| `minettiCost(0.20)` | 20% uphill | Higher cost than `minettiCost(0.10)` |

**`clampGrade` tests** (implement all of the following):

| Test | Input | Expected output |
|---|---|---|
| In-range grade | 0.10 | `{ grade: 0.10, clamped: false }` |
| Exactly at upper bound | 0.45 | `{ grade: 0.45, clamped: false }` |
| Exceeds upper bound | 0.60 | `{ grade: 0.45, clamped: true }` |
| Exactly at lower bound | -0.40 | `{ grade: -0.40, clamped: false }` |
| Below lower bound | -0.55 | `{ grade: -0.40, clamped: true }` |
| Zero grade | 0.0 | `{ grade: 0.0, clamped: false }` |

**`lapGrade` tests** (implement all of the following):

| Test | Inputs | Expected |
|---|---|---|
| Flat lap | ascent=10, descent=10, dist=1km | 0.0 |
| Uphill lap | ascent=100, descent=0, dist=1km | 0.10 |
| Downhill lap | ascent=0, descent=100, dist=1km | -0.10 |
| Null ascent | ascent=null, descent=50, dist=1km | -0.05 (treats null as 0) |
| Null descent | ascent=50, descent=null, dist=1km | 0.05 |
| Both null | ascent=null, descent=null, dist=1km | 0.0 |
| Zero distance | ascent=50, descent=0, dist=0km | 0.0 (guard) |

**`lapGapPace` tests** (implement all of the following):

| Test | Inputs | Expected |
|---|---|---|
| Flat grade | pace=360 sec/km, grade=0 | 360 (GAP = actual on flat) |
| 10% uphill | pace=360 sec/km, grade=0.10 | ~245 sec/km (~30-40% faster) |
| 10% downhill | pace=360 sec/km, grade=-0.10 | ~524 sec/km (~45% slower) |
| Steep uphill (max clamped) | pace=360, grade=0.45 | GAP < 360 |

**`computeGAP` tests** (implement all of the following):

| Test | Description | Expected |
|---|---|---|
| Single flat lap | 1 lap, grade=0 | GAP = raw pace, gap_applied = false |
| Single uphill lap | 1 lap with ascent=100, distance=1000m, moving_time=300s | GAP < raw pace, gap_applied = true |
| Multiple mixed laps | 5 laps with varying grades | Weighted avg verified by hand |
| Paused lap excluded | 1 lap with moving_time=0 | lap_count = 0, avg values null |
| Zero-distance lap excluded | 1 lap with distance=0 | lap_count = 0 |
| All null elevation | 5 laps with null ascent/descent | gap_applied = false, GAP pace = raw pace |
| Grade clamping count | 2 laps with raw grade > 0.45 | laps_grade_clamped = 2 |
| Empty laps array | [] | lap_count = 0, avg_gap_pace_seconds = null, avg_raw_pace_seconds = null |

**Regression fixture** — implement as a separate labeled section:

A 10-lap activity where every lap is exactly 1 km and moving_time and elevation vary. Pre-compute the expected `gap_pace_sec_per_km` for each lap by hand using the Minetti formula, then verify the `avg_gap_pace_seconds` matches the distance-weighted average within ±0.5. Use these exact inputs:

```
Lap 1: moving_time=240, distance=1000m, ascent=0,  descent=0
Lap 2: moving_time=260, distance=1000m, ascent=40, descent=0
Lap 3: moving_time=250, distance=1000m, ascent=80, descent=0
Lap 4: moving_time=270, distance=1000m, ascent=0,  descent=40
Lap 5: moving_time=255, distance=1000m, ascent=60, descent=0
Lap 6: moving_time=265, distance=1000m, ascent=0,  descent=60
Lap 7: moving_time=280, distance=1000m, ascent=50, descent=10
Lap 8: moving_time=245, distance=1000m, ascent=10, descent=50
Lap 9: moving_time=300, distance=1000m, ascent=0,  descent=0
Lap 10: moving_time=290, distance=1000m, ascent=30, descent=20
```

Verify: `result.activityGap.lap_count === 10`, `result.activityGap.gap_applied === true`, `result.activityGap.total_ascent_m === 270`.

### Acceptance Criteria

1. `minettiCost(0)` returns exactly 3.6
2. `minettiCost(0.10)` produces a GAP pace approximately 30-40% faster than actual pace (verified in unit tests)
3. `clampGrade(0.60)` returns `{ grade: 0.45, clamped: true }`; `clampGrade(0.30)` returns `{ grade: 0.30, clamped: false }`
4. `lapGrade(null, null, 1)` returns 0; `lapGrade(100, 0, 1)` returns 0.10
5. `computeGAP([])` returns `{ lapGapResults: [], activityGap: { lap_count: 0, gap_applied: false, avg_gap_pace_seconds: null, avg_raw_pace_seconds: null, total_ascent_m: 0, laps_grade_clamped: 0 } }`
6. `computeGAP` skips laps with `moving_time_seconds <= 0` or `distance <= 0`
7. Activity-level `avg_gap_pace_seconds` is distance-weighted (verified by regression fixture)
8. All unit tests pass with `npm test`

### Testing Instructions

Run the test suite:

```bash
npm test
```

The test runner executes `node --experimental-strip-types __tests__/gap.test.ts` (and other test files). All tests in `__tests__/gap.test.ts` must pass. `process.exitCode` must not be set to 1.

You can also run the gap tests in isolation to iterate quickly:

```bash
node --experimental-strip-types __tests__/gap.test.ts
```

### Critical Constraints

- Follow the exact same pattern as `lib/decoupling.ts` — pure functions, no I/O, no imports beyond TypeScript builtins
- `round2()` is a private (non-exported) helper — define it exactly as in `lib/decoupling.ts`
- Do NOT add features beyond what is specified above
- Do NOT import from Supabase, AsyncStorage, React Native, or any codebase module
- `lap_gap` and `activity_gap` types map directly to the database columns — do not rename fields

### Working Directory

`/Users/daltonrandall/Desktop/running-app`

---

## Ticket 2

You are the Staff Engineer Lead implementing GAP-002: SQL Migration.

### Context

This ticket creates `sql/activity_gap.sql` — the Supabase schema migration for Section 6 Grade Adjusted Pace. It creates two tables: `activity_gap` (one row per activity, stores the activity-level GAP summary) and `lap_gap` (one row per activity/lap pair, stores per-lap grade and GAP pace). This migration must be idempotent and follow the exact same RLS/GRANT patterns as all other migrations in this codebase.

### Files to Read First

Read these files before writing any code:

1. `/Users/daltonrandall/Desktop/running-app/sql/activity_decoupling.sql` — the most recent prior migration; shows the exact RLS disable, GRANT, CHECK constraint drop-and-recreate, and NOTIFY pgrst patterns to follow
2. `/Users/daltonrandall/Desktop/running-app/sql/daily_pmc_values.sql` — the original migration that created the `athletes` table (referenced as FK target in `activity_gap` and `lap_gap`)

### Exact Implementation Spec

#### File to create: `/Users/daltonrandall/Desktop/running-app/sql/activity_gap.sql`

Write the file with this exact content (verbatim, including all comments):

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

### Acceptance Criteria

1. Migration runs successfully in Supabase SQL editor with no errors
2. Re-running the migration produces no errors (idempotent via IF NOT EXISTS)
3. `activity_gap` has a UNIQUE constraint on `activity_id`
4. `lap_gap` has a UNIQUE constraint on `(activity_id, lap)`
5. RLS is disabled on both tables
6. `GRANT SELECT, INSERT, UPDATE` is applied to both tables for `anon, authenticated`
7. `athlete_notifications_type_check` constraint includes all five notification types: `'personalization_available'`, `'model_updated'`, `'more_data_needed'`, `'decoupling_anomaly'`, `'gap_anomaly'`

### Testing Instructions

Run the migration manually in the Supabase SQL editor:

1. Paste the full contents of `sql/activity_gap.sql` into the Supabase SQL editor and execute.
2. Verify no errors appear.
3. Run again — verify it completes with no errors (idempotency check).
4. In the Table Editor, confirm `activity_gap` and `lap_gap` tables appear with the correct columns.
5. Confirm RLS is disabled on both tables (check the "RLS disabled" indicator in the Table Editor).
6. Run the following query to verify the CHECK constraint:
   ```sql
   SELECT conname, pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conname = 'athlete_notifications_type_check';
   ```
   Confirm all five notification types appear in the result.

No `npm test` changes are needed for this ticket — the migration is SQL only.

### Critical Constraints

- Do NOT add DELETE permission to either table — GAP data is always overwritten via upsert, not partially deleted
- Do NOT add a foreign key constraint from `activity_id` to `garmin_activities` — use a soft reference, consistent with `activity_decoupling`
- RLS MUST be disabled on both tables — consistent with all other tables in this codebase
- GRANT must include both `anon` and `authenticated` roles
- The CHECK constraint drop-and-recreate pattern is required for idempotency — do not use `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS` (not supported in all PostgreSQL versions)
- SINGLE_ATHLETE_ID = `'00000000-0000-0000-0000-000000000001'` (no code in this ticket, but keep this in mind as the athlete FK target for future upserts)

### Working Directory

`/Users/daltonrandall/Desktop/running-app`

---

## Ticket 3

You are the Staff Engineer Lead implementing GAP-003: Supabase I/O Pipeline.

### Context

This ticket creates `lib/gapRecalc.ts` — the Supabase I/O layer for Grade Adjusted Pace. It reads lap records from `garmin_activity_laps`, calls the pure `computeGAP()` function from `lib/gap.ts`, upserts results into `lap_gap` and `activity_gap`, and delegates to `backfillDecouplingWithGAP()` to trigger Section 5 re-computation. This module follows the identical pattern established by `lib/decouplingRecalc.ts` and `lib/pmcRecalc.ts`: singleton Supabase client, try/catch on every exported function, sequential batch processing.

This ticket depends on GAP-001 (`lib/gap.ts`) and GAP-002 (`sql/activity_gap.sql` — tables must exist in Supabase).

### Files to Read First

Read these files before writing any code:

1. `/Users/daltonrandall/Desktop/running-app/lib/decouplingRecalc.ts` — the primary pattern to mirror: import style, SINGLE_ATHLETE_ID constant, try/catch error handling, Supabase query patterns, upsert patterns, return type interfaces
2. `/Users/daltonrandall/Desktop/running-app/lib/gap.ts` (written in GAP-001) — to understand `GarminLap`, `GAPResult`, `LapGapResult`, `ActivityGapResult`, and the `computeGAP()` signature
3. `/Users/daltonrandall/Desktop/running-app/lib/supabase.ts` — to confirm the singleton export name

### Exact Implementation Spec

#### File to create: `/Users/daltonrandall/Desktop/running-app/lib/gapRecalc.ts`

##### Imports and constants

```typescript
import { supabase } from './supabase';
import {
  computeGAP,
  type GarminLap,
  type GAPResult,
  type LapGapResult,
  type ActivityGapResult,
} from './gap';
import { backfillDecouplingWithGAP } from './decouplingRecalc';

/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Minimum total ascent (meters) for GAP to be considered meaningful. */
const GAP_ASCENT_THRESHOLD_M = 100;

/** Batch size for upsert operations (matches pmcRecalc.ts pattern). */
const BATCH_SIZE = 500;
```

##### Return type interfaces (all exported)

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

##### `computeGAPForActivity(activityId: string): Promise<GAPRecalcResult>`

Steps:
1. Fetch activity metadata from `garmin_activities` — select `activity_id, start_time, ascent`
2. Fetch lap records from `garmin_activity_laps` — select `lap, moving_time_seconds, distance, ascent, descent`, ordered by `lap` ascending
3. Map lap rows to `GarminLap[]` objects
4. Call `computeGAP(laps)`
5. Upsert all lap results into `lap_gap` (batched by BATCH_SIZE)
6. Upsert activity summary into `activity_gap`
7. Return `GAPRecalcResult`

Use these exact Supabase query patterns:

```typescript
// Step 1: Fetch activity metadata
const { data: actRow, error: actErr } = await supabase
  .from('garmin_activities')
  .select('activity_id, start_time, ascent')
  .eq('activity_id', activityId)
  .maybeSingle();

if (actErr) throw actErr;
if (!actRow) return { ok: false, error: `Activity ${activityId} not found` };

// Step 2: Fetch lap records
const { data: lapRows, error: lapErr } = await supabase
  .from('garmin_activity_laps')
  .select('lap, moving_time_seconds, distance, ascent, descent')
  .eq('activity_id', activityId)
  .order('lap', { ascending: true });

if (lapErr) throw lapErr;

// Step 3: Map to GarminLap[]
const laps: GarminLap[] = (lapRows ?? []).map((r: any) => ({
  lap: r.lap,
  moving_time_seconds: r.moving_time_seconds,
  distance: r.distance,
  ascent: r.ascent,
  descent: r.descent,
}));

// Step 4: Compute GAP
const result = computeGAP(laps);

// Step 5: Upsert lap_gap (batched)
const lapUpsertRows = result.lapGapResults.map((l) => ({
  athlete_id: SINGLE_ATHLETE_ID,
  activity_id: String(actRow.activity_id),
  lap: l.lap,
  raw_pace_sec_per_km: l.raw_pace_sec_per_km,
  gap_pace_sec_per_km: l.gap_pace_sec_per_km,
  grade_fractional: l.grade_fractional,
  grade_clamped: l.grade_clamped,
  distance_km: l.distance_km,
}));

for (let i = 0; i < lapUpsertRows.length; i += BATCH_SIZE) {
  const chunk = lapUpsertRows.slice(i, i + BATCH_SIZE);
  const { error } = await supabase
    .from('lap_gap')
    .upsert(chunk, { onConflict: 'activity_id,lap' });
  if (error) throw error;
}

// Step 6: Upsert activity_gap
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

// Step 7: Return result
return {
  ok: true,
  activityId: String(actRow.activity_id),
  gap_applied: result.activityGap.gap_applied,
  lap_count: result.activityGap.lap_count,
};
```

Wrap the entire function body in `try { ... } catch (e: any) { return { ok: false, error: e?.message ?? 'Unknown error' }; }`.

##### `computeGAPBatch(activityIds: string[]): Promise<BatchGAPResult>`

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

##### `triggerDecouplingBackfill(): Promise<{ ok: boolean; count?: number; error?: string }>`

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
}> {
  try {
    const result = await backfillDecouplingWithGAP();
    return result;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
```

### Acceptance Criteria

1. `computeGAPForActivity` fetches laps from `garmin_activity_laps` ordered by `lap` ascending
2. `computeGAPForActivity` upserts `lap_gap` rows with `onConflict: 'activity_id,lap'`
3. `computeGAPForActivity` upserts `activity_gap` row with `onConflict: 'activity_id'`
4. `computeGAPBatch` processes activities sequentially (not in parallel — `for` loop, not `Promise.all`)
5. `computeGAPBatch` calls `triggerDecouplingBackfill()` after processing all activities
6. All exported functions return `{ ok: false, error: <message> }` on Supabase errors — no exceptions propagate to callers
7. An activity with no laps upserts an `activity_gap` row with `lap_count = 0` and null pace fields

### Testing Instructions

`lib/gapRecalc.ts` requires a live Supabase connection and populated `garmin_activity_laps` data. There is no automated test in `npm test` for this module. Verify manually:

1. Pick a known `activity_id` from `garmin_activity_laps` in your Supabase database.
2. In a scratch file or React Native debug console, call:
   ```typescript
   import { computeGAPForActivity } from './lib/gapRecalc';
   const result = await computeGAPForActivity('<your-activity-id>');
   console.log(JSON.stringify(result, null, 2));
   ```
3. Confirm `result.ok === true`, `result.lap_count > 0`, and that rows appear in `lap_gap` and `activity_gap` in Supabase.
4. Re-run the call — confirm no duplicate rows (idempotency via upsert).
5. Call `computeGAPBatch(['<id-1>', '<id-2>'])` and confirm `backfill_triggered` is a number in the response.

### Critical Constraints

- Follow the exact same pattern as `lib/decouplingRecalc.ts` — singleton Supabase client, try/catch on every exported async function, sequential processing
- Do NOT use `Promise.all()` for batch processing — activities must be processed sequentially to avoid overwhelming Supabase
- SINGLE_ATHLETE_ID = `'00000000-0000-0000-0000-000000000001'`
- Use the existing `supabase` singleton from `lib/supabase.ts`
- Do NOT add features beyond what the TDD specifies (no gap_used flag on garmin_activities in this ticket, no additional tables)
- `triggerDecouplingBackfill()` must delegate entirely to `backfillDecouplingWithGAP()` from `lib/decouplingRecalc.ts` — do not duplicate its logic here

### Working Directory

`/Users/daltonrandall/Desktop/running-app`

---

## Ticket 4

You are the Staff Engineer Lead implementing GAP-004: Section 5 Backfill Implementation.

### Context

This ticket replaces the existing `backfillDecouplingWithGAP()` stub in `lib/decouplingRecalc.ts` with a full implementation. The stub currently throws `NotImplementedError`. The full implementation queries `activity_decoupling` for rows where `awaiting_gap = true`, checks whether GAP data is available for each activity (from `activity_gap` and `lap_gap`), constructs synthetic `LapRecord` objects with GAP-adjusted distance, and re-runs `computeDecoupling()` with those synthetic laps. It then updates `activity_decoupling` to set `gap_used` and clear `awaiting_gap = false`.

This is the integration point between Section 6 (GAP) and Section 5 (Aerobic Decoupling). It depends on GAP-001, GAP-002, and GAP-003 (the `lap_gap` and `activity_gap` tables must be populated before this function runs meaningfully).

### Files to Read First

Read these files before writing any code:

1. `/Users/daltonrandall/Desktop/running-app/lib/decouplingRecalc.ts` — find the existing `backfillDecouplingWithGAP()` stub at the bottom; understand the full file context, existing imports, constants (`SINGLE_ATHLETE_ID`), and the `computeActivityDecoupling()` function pattern
2. `/Users/daltonrandall/Desktop/running-app/lib/decoupling.ts` — understand the `LapRecord` interface (all fields: `lap`, `moving_time_seconds`, `elapsed_time_seconds`, `distance`, `avg_hr`, `ascent`, `descent`) and the `computeDecoupling()` signature (accepts `DecouplingInput`)
3. `/Users/daltonrandall/Desktop/running-app/lib/gap.ts` (written in GAP-001) — understand the `LapGapResult` type, specifically `gap_pace_sec_per_km` and `distance_km`

### What to Modify

**File to modify:** `/Users/daltonrandall/Desktop/running-app/lib/decouplingRecalc.ts`

Find and replace only the `backfillDecouplingWithGAP()` function (the stub at the bottom of the file). Do not modify any other part of the file.

The current stub is:

```typescript
export async function backfillDecouplingWithGAP(): Promise<{ ok: boolean; error?: string }> {
  throw new Error(
    'NotImplementedError: backfillDecouplingWithGAP() is a stub. ' +
    'Implement when Section 6 (Grade Adjusted Pace) is complete. ' +
    'See docs/output/section-5-tech-design.md §7.2 for the integration contract.',
  );
}
```

Replace it with the full implementation described below.

### Exact Implementation Spec

#### Return type change

The function signature must be updated to return `count` on success:

```typescript
export async function backfillDecouplingWithGAP(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}>
```

#### GAP ascent threshold constant

Add this constant near the top of the file, alongside `SINGLE_ATHLETE_ID`:

```typescript
/** Minimum total ascent (meters) for GAP to be considered meaningful. */
const GAP_ASCENT_THRESHOLD_M = 100;
```

#### Full implementation

```typescript
export async function backfillDecouplingWithGAP(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  try {
    // Step 1: Query all activity_decoupling rows where awaiting_gap = true
    const { data: pendingRows, error: fetchErr } = await supabase
      .from('activity_decoupling')
      .select('activity_id, effort_tier')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('awaiting_gap', true);

    if (fetchErr) throw fetchErr;
    if (!pendingRows || pendingRows.length === 0) {
      return { ok: true, count: 0 };
    }

    let count = 0;

    for (const pending of pendingRows) {
      const activityId = pending.activity_id as string;

      // Step 2: Fetch activity metadata from garmin_activities
      const { data: actRow, error: actErr } = await supabase
        .from('garmin_activities')
        .select('activity_id, start_time, avg_hr, moving_time_seconds, distance, ascent, is_race, avg_pace_seconds')
        .eq('activity_id', activityId)
        .maybeSingle();

      if (actErr) throw actErr;
      if (!actRow) continue;

      // Step 3: Fetch lap records from garmin_activity_laps (raw laps)
      const { data: lapRows, error: lapErr } = await supabase
        .from('garmin_activity_laps')
        .select('lap, moving_time_seconds, elapsed_time_seconds, distance, avg_hr, ascent, descent')
        .eq('activity_id', activityId)
        .order('lap', { ascending: true });

      if (lapErr) throw lapErr;

      const rawLaps: LapRecord[] = (lapRows ?? []).map((r: any) => ({
        lap: r.lap,
        moving_time_seconds: r.moving_time_seconds,
        elapsed_time_seconds: r.elapsed_time_seconds,
        distance: r.distance,
        avg_hr: r.avg_hr,
        ascent: r.ascent,
        descent: r.descent,
      }));

      // Step 4: Fetch activity_gap row to check threshold
      const { data: gapRow, error: gapRowErr } = await supabase
        .from('activity_gap')
        .select('gap_applied, total_ascent_m')
        .eq('activity_id', activityId)
        .maybeSingle();

      if (gapRowErr) throw gapRowErr;

      // Apply threshold: use GAP only when total_ascent > 100m AND gap_applied = true
      const useGap = (gapRow?.total_ascent_m ?? 0) > GAP_ASCENT_THRESHOLD_M
                  && gapRow?.gap_applied === true;

      let lapsForDecoupling: LapRecord[] = rawLaps;

      if (useGap) {
        // Step 5: Fetch lap_gap rows to get gap_pace_sec_per_km per lap
        const { data: lapGapRows, error: lapGapErr } = await supabase
          .from('lap_gap')
          .select('lap, gap_pace_sec_per_km')
          .eq('activity_id', activityId)
          .order('lap', { ascending: true });

        if (lapGapErr) throw lapGapErr;

        // Build a lookup map: lap number → gap_pace_sec_per_km
        const gapPaceMap = new Map<number, number>(
          (lapGapRows ?? []).map((r: any) => [r.lap as number, r.gap_pace_sec_per_km as number]),
        );

        // Step 6: Construct synthetic LapRecord objects with GAP-adjusted distance
        // Formula: distance_m = (moving_time_seconds / gap_pace_sec_per_km) * 1000
        // This produces the flat-ground equivalent distance at GAP effort,
        // which causes computeDecoupling() to use GAP speed for EF calculations.
        lapsForDecoupling = rawLaps.map((lap) => {
          const gapPace = gapPaceMap.get(lap.lap);
          if (
            gapPace == null ||
            gapPace <= 0 ||
            lap.moving_time_seconds == null ||
            lap.moving_time_seconds <= 0
          ) {
            // No GAP data for this lap — keep raw distance
            return lap;
          }
          const gapDistance = Math.round(((lap.moving_time_seconds / gapPace) * 1000) * 100) / 100;
          return {
            ...lap,
            distance: gapDistance,
          };
        });
      }

      // Step 7: Re-run computeDecoupling() with the (possibly GAP-adjusted) laps
      const thresholds = await resolveHRZoneThresholds();
      let effort_tier: EffortTier = (pending.effort_tier as EffortTier) ?? 'moderate';
      if (thresholds != null && actRow.avg_hr != null) {
        effort_tier = classifyEffortTier(actRow.avg_hr as number, thresholds);
      }

      const activity: ActivityMetadata = {
        activity_id: String(actRow.activity_id),
        date: String(actRow.start_time).slice(0, 10),
        avg_hr: actRow.avg_hr,
        moving_time_seconds: actRow.moving_time_seconds,
        distance: actRow.distance,
        ascent: actRow.ascent,
        is_race: actRow.is_race === true,
        avg_pace_seconds: actRow.avg_pace_seconds,
      };

      const input: DecouplingInput = { activity, laps: lapsForDecoupling, effort_tier };
      const result: DecouplingResult = computeDecoupling(input);

      // Step 8: Upsert updated activity_decoupling row with gap_used and awaiting_gap = false
      const upsertRow = {
        athlete_id: SINGLE_ATHLETE_ID,
        activity_id: String(actRow.activity_id),
        date: activity.date,
        effort_tier: result.effort_tier,
        ef_h1: result.ef_h1,
        ef_h2: result.ef_h2,
        decoupling_pct: result.decoupling_pct,
        ef_q1: result.ef_q1,
        ef_q2: result.ef_q2,
        ef_q3: result.ef_q3,
        ef_q4: result.ef_q4,
        decoupling_q1q4_pct: result.decoupling_q1q4_pct,
        decoupling_q1q2_pct: result.decoupling_q1q2_pct,
        gap_used: useGap,
        awaiting_gap: false,
        hr_data_insufficient: result.hr_data_insufficient,
        laps_excluded_warmup: result.laps_excluded_warmup,
        laps_excluded_hr: result.laps_excluded_hr,
        qualifying_duration_s: result.qualifying_duration_s,
        skipped: result.skipped,
        skip_reason: result.skip_reason,
      };

      const { error: upsertErr } = await supabase
        .from('activity_decoupling')
        .upsert(upsertRow, { onConflict: 'activity_id' });

      if (upsertErr) throw upsertErr;

      count++;
    }

    return { ok: true, count };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
```

#### Threshold rule summary

- `useGap = true` when: `gapRow?.total_ascent_m > 100` AND `gapRow?.gap_applied === true`
- When `useGap = true`: reconstruct `LapRecord.distance` using `(moving_time_seconds / gap_pace_sec_per_km) * 1000`; set `gap_used = true`, `awaiting_gap = false`
- When `useGap = false`: use raw `LapRecord` objects unchanged; set `gap_used = false`, `awaiting_gap = false`
- In both cases, `awaiting_gap` is cleared to `false` so the activity is not reprocessed on the next backfill run

#### Synthetic LapRecord formula

```typescript
// distance_m = (moving_time_seconds / gap_pace_sec_per_km) * 1000
// Round to 2 decimal places before returning
const gapDistance = Math.round(((lap.moving_time_seconds / gapPace) * 1000) * 100) / 100;
```

This replaces the raw `distance` field in `LapRecord`. Since `computeDecoupling()` computes `speed_mps = (distance_m) / moving_time_seconds`, substituting the GAP-adjusted distance causes EF (speed/HR) to reflect the GAP-equivalent flat-ground speed rather than the raw GPS speed. No other fields in `LapRecord` are changed.

### Acceptance Criteria

1. Activities with `awaiting_gap = true` and `total_ascent_m > 100` are re-run with GAP-adjusted speed; their `gap_used` becomes `true` in `activity_decoupling`
2. Activities with `awaiting_gap = true` but `total_ascent_m <= 100` (or no `activity_gap` row) are re-run with raw speed; their `gap_used` remains `false`, `awaiting_gap` becomes `false`
3. After backfill, no `activity_decoupling` rows have `awaiting_gap = true` (all cleared)
4. `backfillDecouplingWithGAP()` returns `{ ok: true, count: N }` where N is the number of activities reprocessed
5. Existing decoupling fields (`effort_tier`, `laps_excluded_warmup`, `laps_excluded_hr`, etc.) are re-computed correctly on re-run via the full `computeDecoupling()` call
6. Function returns `{ ok: false, error: <message> }` on any Supabase error — no exceptions propagate

### Testing Instructions

`backfillDecouplingWithGAP()` requires a live Supabase database with data in `activity_decoupling` (with `awaiting_gap = true` rows) and `lap_gap`. There is no automated test in `npm test` for this function. Verify manually:

1. Confirm there is at least one row in `activity_decoupling` where `awaiting_gap = true` (these are created by `computeActivityDecoupling()` when `activity.ascent > 100`).
2. Confirm `lap_gap` and `activity_gap` are populated for those activities (run GAP-003 first if needed).
3. Call the function:
   ```typescript
   import { backfillDecouplingWithGAP } from './lib/decouplingRecalc';
   const result = await backfillDecouplingWithGAP();
   console.log(JSON.stringify(result, null, 2));
   ```
4. Confirm `result.ok === true` and `result.count` matches the number of previously-pending activities.
5. In Supabase, query `activity_decoupling` and confirm no rows have `awaiting_gap = true`.
6. For activities that had `total_ascent_m > 100`, confirm `gap_used = true`.
7. For activities that had `total_ascent_m <= 100`, confirm `gap_used = false` and `awaiting_gap = false`.
8. Re-run the function — confirm `result.count === 0` (no rows to reprocess).

Also run `npm test` to confirm no regressions were introduced in the existing decoupling library tests.

### Critical Constraints

- Modify ONLY the `backfillDecouplingWithGAP()` function — do not change any other function in `lib/decouplingRecalc.ts`
- The synthetic `LapRecord` formula is: `distance_m = (moving_time_seconds / gap_pace_sec_per_km) * 1000` — use this exactly
- Apply GAP only when `total_ascent_m > 100` AND `gap_applied = true` — both conditions must be true
- SINGLE_ATHLETE_ID = `'00000000-0000-0000-0000-000000000001'`
- Use the existing `supabase` singleton from `lib/supabase.ts` — already imported at the top of `decouplingRecalc.ts`
- Use `resolveHRZoneThresholds()` (the existing private function in `decouplingRecalc.ts`) to resolve the effort tier — do not duplicate its logic
- The upsert into `activity_decoupling` must use `onConflict: 'activity_id'` — same as `computeActivityDecoupling()`
- Do NOT add features beyond what the TDD specifies (no notifications, no trend recalculation in this function)

### Working Directory

`/Users/daltonrandall/Desktop/running-app`
