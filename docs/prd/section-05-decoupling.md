# Section 5 — Running: Aerobic Decoupling & Cardiac Drift
## Scoped PRD for Staff Engineer Lead

**Version:** 1.0
**Date:** 2026-03-07
**Author:** TPM Agent
**Status:** Ready for Technical Design

---

## Scoped PRD Section 5

### 5.1 Objective

Quantify the relationship between pace and heart rate across a session to assess aerobic fitness and predict endurance durability. Aerobic decoupling is the single most important metric for ultra performance in this system. This section covers the pure calculation backend: computation, storage, and baseline learning. UI/UX is deferred to Phase 2.

---

### 5.2 Background & Research

Aerobic decoupling measures how much heart rate drifted upward relative to output (speed) during steady-state exercise. Friel (2009) popularized the metric: compare the efficiency factor (speed/HR) of the first half to the second half. Decoupling >5% on an easy long run suggests insufficient aerobic base for the target effort. Seiler & Kjerland (2006, Scand J Med Sci Sports) showed that trained endurance athletes exhibit <3–5% decoupling on sub-threshold steady-state efforts lasting 60–90 minutes.

For ultra runners, decoupling rate on 2–4 hour runs is a direct proxy for race-day fade. A 100k blowup can be retrospectively analyzed by looking at decoupling in the final quartile. This metric feeds directly into race prediction (Section 22) and pacing strategy simulation (Section 23).

---

### 5.3 Calculation Specification

#### 5.3.1 Data Source

**All decoupling calculations operate on `garmin_activity_laps` (lap-level data), not per-second streams.**

Per-second activity records are not synced to Supabase (see `migrations/002_garmin_laps.sql` — deliberate architectural decision). Laps provide per-segment avg_hr, distance (km), and moving_time_seconds, which are sufficient for the Friel decoupling method. The laps table also provides start_time and stop_time per lap for sequencing.

Relevant columns from `garmin_activity_laps`:
- `activity_id` (FK to garmin_activities)
- `lap` (0-indexed lap number)
- `start_time`, `stop_time`
- `moving_time_seconds`
- `distance` (km)
- `avg_hr` (bpm)
- `ascent`, `descent` (meters — used for future GAP integration)

Relevant columns from `garmin_activities`:
- `avg_hr`, `moving_time_seconds`, `distance`, `ascent`
- `is_race` (from PMC-002 race detection)
- `avg_pace_seconds` (seconds/km — fallback if laps are unavailable)

#### 5.3.2 Efficiency Factor Formula

EF is computed as **speed in meters per second divided by average HR in bpm**:

```
lap_speed_mps = (lap_distance_km * 1000) / lap_moving_time_seconds

EF_segment = mean(lap_speed_mps) / mean(lap_avg_hr)
```

where the means are weighted by `lap_moving_time_seconds` (time-weighted average, not simple arithmetic mean of laps).

**Why speed, not pace:** Using speed (m/s) means faster = higher numerator = higher EF. Using pace (sec/km) would invert this: a slower, more fatigued run would paradoxically show higher EF. Speed-over-HR matches the convention in Section 7 (EF_run = avg_GAP (m/s) / avg_HR) and lib/vdot.ts. All EF values in this system are in units of m/s/bpm, resulting in typical values in the range 0.030–0.065 for easy-to-threshold efforts.

#### 5.3.3 Half-Split Decoupling (Primary Metric)

```
EF_first_half  = time_weighted_speed(first_half_laps)  / time_weighted_avg_hr(first_half_laps)
EF_second_half = time_weighted_speed(second_half_laps) / time_weighted_avg_hr(second_half_laps)

decoupling_pct = ((EF_first_half - EF_second_half) / EF_first_half) * 100
```

- Positive decoupling_pct: HR drifted up relative to speed (normal aerobic drift)
- Negative decoupling_pct: pace improved relative to HR (uncommon; may indicate downhill-heavy second half or a negative split race)

The half split point is determined by cumulative moving_time_seconds of the post-warmup laps. Laps are assigned to H1 or H2 based on which half their midpoint falls into (do not split a lap across halves).

#### 5.3.4 Quartile Decoupling (Extended Metric for Races and Long Runs)

Computed when the activity qualifies: `is_race = true` OR `moving_time_seconds > 7200` (2 hours).

```
Q1 laps: cumulative_time in [0%, 25%) of post-warmup duration
Q2 laps: cumulative_time in [25%, 50%)
Q3 laps: cumulative_time in [50%, 75%)
Q4 laps: cumulative_time in [75%, 100%]

EF_Q1 = time_weighted_speed(Q1_laps) / time_weighted_avg_hr(Q1_laps)
EF_Q2, EF_Q3, EF_Q4 similarly

decoupling_q1q4_pct = ((EF_Q1 - EF_Q4) / EF_Q1) * 100   -- overall fade
decoupling_q1q2_pct = ((EF_Q1 - EF_Q2) / EF_Q1) * 100   -- early fade
```

Quartile decoupling is stored in addition to half-split decoupling, not as a replacement. Thirds are not implemented.

#### 5.3.5 Preprocessing

**Step 1: Warmup Exclusion**

Exclude all laps whose cumulative elapsed time from activity start falls within the first 10 minutes. "Cumulative elapsed time" is computed as the sum of `moving_time_seconds` of laps with `lap` index less than the current lap. A lap that straddles the 10-minute boundary (i.e., its moving_time_seconds would push cumulative time past 10 min) is excluded in full (conservative: do not split).

**Step 2: Paused/Stopped Segment Exclusion**

Laps with `moving_time_seconds = 0` or `moving_time_seconds IS NULL` are excluded entirely. Laps where `moving_time_seconds < 0.5 * elapsed_time_seconds` (more than 50% stopped time) are also excluded as substantially paused segments.

**Step 3: HR Validity Check**

Exclude laps where `avg_hr IS NULL` or `avg_hr <= 0`. After exclusion, if fewer than 75% of the remaining post-warmup laps have valid HR values, set `hr_data_insufficient = true` and skip decoupling computation for this activity (store NULL for all EF and decoupling fields).

**Step 4: Minimum Duration Check**

After preprocessing, if the remaining qualifying laps total fewer than 30 minutes of moving time, skip the activity. This handles cases where warmup + HR dropout removes most of the activity.

**Step 5: GAP — Deferred**

Section 6 (Grade Adjusted Pace) has not been implemented. Until Section 6 is available, all EF calculations use raw speed (distance/time), not GAP-adjusted speed. Set `gap_used = false` on every stored row. If `garmin_activities.ascent > 100` (meters), set `awaiting_gap = true` to flag that the decoupling value is terrain-uncorrected. When Section 6 ships, a backfill job will recompute decoupling on GAP for all rows where `awaiting_gap = true` and set `gap_used = true`.

---

### 5.4 Storage Schema

Three new tables:

#### `activity_decoupling`

One row per activity. Written by the decoupling computation job after each sync.

```sql
CREATE TABLE IF NOT EXISTS activity_decoupling (
    id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id            UUID          NOT NULL REFERENCES athletes(id),
    activity_id           TEXT          NOT NULL REFERENCES garmin_activities(activity_id) ON DELETE CASCADE,

    -- Computation metadata
    computed_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    gap_used              BOOLEAN       NOT NULL DEFAULT false,
    awaiting_gap          BOOLEAN       NOT NULL DEFAULT false,
    hr_data_insufficient  BOOLEAN       NOT NULL DEFAULT false,
    laps_excluded_warmup  INTEGER,        -- count of laps dropped in warmup exclusion
    laps_excluded_hr      INTEGER,        -- count of laps dropped due to HR invalidity
    qualifying_duration_s INTEGER,        -- post-warmup, post-exclusion moving time in seconds

    -- Half-split EF values (m/s/bpm)
    ef_h1                 DOUBLE PRECISION,
    ef_h2                 DOUBLE PRECISION,
    decoupling_pct        DOUBLE PRECISION,   -- primary metric; positive = normal drift

    -- Quartile EF values (NULL if activity does not qualify)
    ef_q1                 DOUBLE PRECISION,
    ef_q2                 DOUBLE PRECISION,
    ef_q3                 DOUBLE PRECISION,
    ef_q4                 DOUBLE PRECISION,
    decoupling_q1q4_pct   DOUBLE PRECISION,   -- Q1 vs Q4 overall fade
    decoupling_q1q2_pct   DOUBLE PRECISION,   -- Q1 vs Q2 early fade

    -- Effort tier for baseline bucketing
    effort_tier           TEXT          CHECK (effort_tier IN ('easy', 'moderate', 'hard')),

    UNIQUE (athlete_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_date
    ON activity_decoupling (athlete_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_decoupling_awaiting_gap
    ON activity_decoupling (awaiting_gap) WHERE awaiting_gap = true;
```

#### `decoupling_baseline`

One row per (athlete_id, effort_tier). Upserted after each recalculation.

```sql
CREATE TABLE IF NOT EXISTS decoupling_baseline (
    id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id            UUID          NOT NULL REFERENCES athletes(id),
    effort_tier           TEXT          NOT NULL CHECK (effort_tier IN ('easy', 'moderate', 'hard')),

    n_qualifying_runs     INTEGER       NOT NULL DEFAULT 0,
    mean_decoupling_pct   DOUBLE PRECISION,
    stdev_decoupling_pct  DOUBLE PRECISION,
    lower_bound           DOUBLE PRECISION,   -- mean - 2*stdev
    upper_bound           DOUBLE PRECISION,   -- mean + 2*stdev
    is_established        BOOLEAN       NOT NULL DEFAULT false,   -- true when n >= 20
    last_recalculated     TIMESTAMPTZ,

    UNIQUE (athlete_id, effort_tier)
);
```

#### `decoupling_trend`

One row per (athlete_id, effort_tier, date). Written by the trend job.

```sql
CREATE TABLE IF NOT EXISTS decoupling_trend (
    id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id            UUID          NOT NULL REFERENCES athletes(id),
    effort_tier           TEXT          NOT NULL CHECK (effort_tier IN ('easy', 'moderate', 'hard')),
    date                  DATE          NOT NULL,
    rolling_30d_mean      DOUBLE PRECISION,   -- 30-day rolling average of decoupling_pct
    n_activities          INTEGER,             -- number of activities in the 30-day window

    UNIQUE (athlete_id, effort_tier, date)
);

CREATE INDEX IF NOT EXISTS idx_decoupling_trend_athlete_tier_date
    ON decoupling_trend (athlete_id, effort_tier, date DESC);
```

---

### 5.5 Effort Tier Classification

Each qualifying activity is bucketed into one of three macro-effort tiers using the athlete's existing HR zone configuration from `lib/hrZones.ts`:

- **Easy:** activity avg_hr falls in Zone 1 or Zone 2 (HR < hrz_3_min)
- **Moderate:** activity avg_hr falls in Zone 3 (hrz_3_min <= HR < hrz_4_min)
- **Hard:** activity avg_hr falls in Zone 4 or Zone 5 (HR >= hrz_4_min)

If the athlete has no HR zones configured, effort_tier is set to NULL and the activity is excluded from baseline computation (but decoupling_pct is still stored for the activity).

The HR zone bounds are loaded from `AsyncStorage` (key `hr_zones_v1`) via the existing `loadHRZones()` function. If not available in AsyncStorage, fall back to `lthr_settings` via `loadLTHR()` and derive approximate zones using standard LTHR zone percentages.

---

### 5.6 Personal Decoupling Baseline

#### Computation

After each sync, for each effort_tier where `n_qualifying_runs >= 20`:
1. Fetch all `activity_decoupling` rows for this athlete and effort_tier where `hr_data_insufficient = false` and `decoupling_pct IS NOT NULL`.
2. Compute `mean_decoupling_pct` and `stdev_decoupling_pct` using population statistics (not sample — athlete-specific, not generalized).
3. Set `lower_bound = mean - 2*stdev`, `upper_bound = mean + 2*stdev`.
4. Set `is_established = true`.
5. Upsert into `decoupling_baseline`.

#### Deviation Flagging

After baseline is established, each newly computed activity decoupling value is compared to the baseline for its effort_tier. If `decoupling_pct > upper_bound` or `decoupling_pct < lower_bound`, the activity is flagged. The flagging mechanism is the `athlete_notifications` table (already exists at `sql/athlete_notifications.sql`). Notification type: `'decoupling_anomaly'`, payload includes `activity_id`, `decoupling_pct`, `expected_range: [lower_bound, upper_bound]`, `effort_tier`.

---

### 5.7 Rolling Decoupling Trend

After each baseline recalculation, compute the 30-day rolling average of `decoupling_pct` for the `easy` effort tier (easy runs are the most standardized signal of aerobic development):

- For each day in the last 90 days (3 months of trend), aggregate all easy-tier qualifying activities in the 30-day window ending on that day.
- Compute the mean decoupling_pct for that window.
- Upsert into `decoupling_trend`.

A negative slope of the rolling mean over time indicates improving aerobic fitness (HR drifting less for the same pace on easy runs). The trend is also computed for `moderate` and `hard` tiers but the `easy` tier is the primary fitness signal.

---

### 5.8 Computation Trigger

The decoupling computation job runs after each Garmin sync (triggered via the existing sync pipeline). Call order:

1. `recalculateAllSports()` (PMC — existing)
2. `computeActivityDecoupling(activityId)` for each new/updated activity
3. `recalculateDecouplingBaseline()` for affected effort tiers
4. `recalculateDecouplingTrend()` for affected effort tiers

The computation should be idempotent — re-running it on an existing activity overwrites the existing `activity_decoupling` row (upsert on `athlete_id, activity_id`).

---

### 5.9 Requirements

| ID | Requirement | Acceptance Criteria |
|---|---|---|
| R1 | Calculate aerobic decoupling for every run >30 minutes with stable HR data | decoupling_pct computed and stored in activity_decoupling. Stable HR defined as: avg_hr valid on >=75% of post-warmup qualifying laps. Runs failing this are stored with hr_data_insufficient = true and NULL decoupling. |
| R2 | Use GAP-adjusted speed when elevation data available | Deferred: gap_used = false until Section 6 ships. Runs with ascent > 100m stored with awaiting_gap = true. Backfill job defined and documented. |
| R3 | Support quartile-level decoupling for races and long runs >2 hours | ef_q1/q2/q3/q4, decoupling_q1q4_pct, decoupling_q1q2_pct stored for qualifying activities (is_race = true OR moving_time > 7200s). |
| R4 | Build personal decoupling baseline by effort zone | After >=20 qualifying runs per effort tier (Easy/Moderate/Hard based on avg_hr vs. HR zones), mean, stdev, lower_bound, upper_bound stored in decoupling_baseline. is_established = true. Deviations >2 stdev trigger athlete_notifications. |
| R5 | Track decoupling trend over time (rolling 30-day average for easy runs) | rolling_30d_mean stored in decoupling_trend per (athlete, effort_tier, date) for last 90 days. Negative slope = improving aerobic fitness. |
| R6 | Warmup exclusion: first 10 minutes excluded from all calculations | Laps within the first 10 minutes of cumulative moving time excluded. Laps straddling the boundary excluded in full. laps_excluded_warmup count stored. |
| R7 | Exclude stopped/paused segments | Laps with moving_time_seconds = 0 or NULL excluded. Laps where moving_time_seconds < 50% of elapsed_time_seconds excluded. |

---

### 5.10 Out of Scope for This Section

- UI chart rendering for decoupling trend (Phase 2)
- GAP-adjusted decoupling (requires Section 6; handled by backfill path)
- Per-second cardiac drift visualization (requires per-second stream sync; deferred)
- Decoupling integration into race prediction (Section 22) — Section 22 will read from activity_decoupling table

---

## Decisions Made

| # | Decision | Rationale | PRD Impact |
|---|---|---|---|
| D1 | Lap-level data (garmin_activity_laps) is the computation source, not per-second streams | Per-second records deliberately not synced (see migrations/002). Laps are sufficient for Friel's method. | Formula spec updated to use lap aggregation; half/quartile split defined by cumulative lap time |
| D2 | EF = speed (m/s) / avg_hr, not pace / avg_hr | Pace formula inverts the efficiency direction. Speed-over-HR matches Section 7 and standard Friel convention. | Formula corrected in 5.3.2; unit convention documented |
| D3 | "Stable HR data" = valid avg_hr on >=75% of post-warmup qualifying laps | Prevents garbage values from polluting the baseline; consistent with PMC pipeline's NULL-skip approach | R1 acceptance criteria made explicit |
| D4 | Warmup exclusion is lap-boundary-aligned (whole laps excluded, straddling lap excluded in full) | Per-second precision unavailable; conservative whole-lap exclusion avoids synthetic averages | 5.3.5 preprocessing updated |
| D5 | GAP dependency deferred; gap_used and awaiting_gap flags track state for backfill | Prevents Section 5 from being blocked by Section 6 delivery | R2 updated; schema includes gap_used, awaiting_gap columns |
| D6 | Quartiles only (no thirds); both halves and quartiles stored | Thirds offer no advantage over quartiles; quartiles more informative for ultra analysis | 5.3.4 updated; schema stores ef_h1/h2 and ef_q1/q2/q3/q4 |
| D7 | 3-tier effort bucketing (Easy/Moderate/Hard) using existing HR zones from hrZones.ts | Full 5-zone granularity requires 100 qualifying runs to reach the 20-per-zone threshold; 3 tiers are achievable in 3–6 months | R4 updated; effort_tier column constrained to 3 values |
| D8 | Dedicated activity_decoupling table (not columns on garmin_activities) | garmin_activities already has 40+ columns; dedicated table follows pattern of daily_pmc_values | Three new tables: activity_decoupling, decoupling_baseline, decoupling_trend |
| D9 | Notifications via existing athlete_notifications table | Avoids new notification infrastructure; type = 'decoupling_anomaly' | 5.6 deviation flagging spec added |

---

## Implementation Tickets

### DEC-001: Core Decoupling Calculation Library (`lib/decoupling.ts`)

Implement the pure TypeScript decoupling computation function: takes an array of lap records, runs preprocessing (warmup exclusion, pause exclusion, HR validity check), computes half-split EF and decoupling_pct, computes quartile EF and decoupling for qualifying activities, classifies effort_tier, and returns a typed result object. Must be pure (no I/O) and fully unit-testable.

### DEC-002: Database Schema Migration (`sql/activity_decoupling.sql`)

Write the migration SQL creating the three new tables: `activity_decoupling`, `decoupling_baseline`, and `decoupling_trend`. Include all indexes, GRANT statements, RLS disable, and NOTIFY pgrst. Follow the pattern of existing migration files.

### DEC-003: Decoupling Computation Job (`lib/decouplingRecalc.ts`)

Implement the `computeActivityDecoupling(activityId)` function that reads laps from Supabase, calls the lib/decoupling.ts library, and upserts the result into `activity_decoupling`. Implement `recalculateDecouplingBaseline()` and `recalculateDecouplingTrend()` functions. Wire all three into the post-sync trigger sequence after `recalculateAllSports()`.

### DEC-004: Personal Baseline & Deviation Flagging

Implement baseline statistical computation (mean, stdev, bounds per effort tier, is_established logic) and the deviation notification trigger (insert into athlete_notifications when decoupling_pct falls outside the 2-stdev range). Include the 20-run minimum guard.

### DEC-005: Rolling Trend Computation

Implement the 30-day rolling average trend computation across all three effort tiers, writing to `decoupling_trend` for the last 90 days. This job is called after each baseline recalculation.

### DEC-006: GAP Backfill Path (Stub)

Define and document the backfill job interface: `backfillDecouplingWithGAP()` — a function that queries `activity_decoupling WHERE awaiting_gap = true`, fetches the GAP-adjusted speed data (expected from Section 6 output), recomputes EF and decoupling_pct using GAP, and updates the row with `gap_used = true`, `awaiting_gap = false`. Implement the stub (the function exists but throws `NotImplementedError` until Section 6 ships). This ensures Section 5 does not need to be revisited for the GAP integration — only the stub body needs to be filled in.
