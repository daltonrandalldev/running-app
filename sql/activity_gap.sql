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
