-- DEC-002: Aerobic Decoupling Schema Migration
--
-- Creates three tables for Section 5 aerobic decoupling analytics:
--   activity_decoupling   – per-activity EF split and decoupling results
--   decoupling_baseline   – per-athlete, per-tier rolling baseline statistics
--   decoupling_trend      – per-athlete, per-tier, per-day 30-day rolling mean
--
-- Also extends athlete_notifications to accept 'decoupling_anomaly'.
--
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS, DROP CONSTRAINT IF EXISTS).
-- Prerequisites: athletes table must exist (created by daily_pmc_values.sql).

-- ---------------------------------------------------------------------------
-- activity_decoupling
-- ---------------------------------------------------------------------------
-- Stores per-activity aerobic decoupling computation results.
-- activity_id is a soft TEXT reference to garmin_activities; no FK enforced.

CREATE TABLE IF NOT EXISTS activity_decoupling (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),
    activity_id            TEXT             NOT NULL UNIQUE,
    date                   DATE             NOT NULL,
    ef_h1                  DOUBLE PRECISION,
    ef_h2                  DOUBLE PRECISION,
    decoupling_pct         DOUBLE PRECISION,
    ef_q1                  DOUBLE PRECISION,
    ef_q2                  DOUBLE PRECISION,
    ef_q3                  DOUBLE PRECISION,
    ef_q4                  DOUBLE PRECISION,
    decoupling_q1q4_pct    DOUBLE PRECISION,
    decoupling_q1q2_pct    DOUBLE PRECISION,
    effort_tier            TEXT             NOT NULL CHECK (effort_tier IN ('easy', 'moderate', 'hard')),
    gap_used               BOOLEAN          NOT NULL DEFAULT false,
    awaiting_gap           BOOLEAN          NOT NULL DEFAULT true,
    hr_data_insufficient   BOOLEAN          NOT NULL DEFAULT false,
    laps_excluded_warmup   INTEGER          NOT NULL DEFAULT 0,
    laps_excluded_hr       INTEGER          NOT NULL DEFAULT 0,
    qualifying_duration_s  INTEGER          NOT NULL DEFAULT 0,
    computed_at            TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- decoupling_baseline
-- ---------------------------------------------------------------------------
-- Stores per-athlete, per-effort-tier baseline statistics used to detect
-- anomalies. One row per (athlete_id, effort_tier); updated on each refit.

CREATE TABLE IF NOT EXISTS decoupling_baseline (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),
    effort_tier            TEXT             NOT NULL CHECK (effort_tier IN ('easy', 'moderate', 'hard')),
    n_qualifying_runs      INTEGER          NOT NULL DEFAULT 0,
    mean_decoupling_pct    DOUBLE PRECISION NOT NULL DEFAULT 0,
    stdev_decoupling_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
    lower_bound            DOUBLE PRECISION NOT NULL DEFAULT 0,
    upper_bound            DOUBLE PRECISION NOT NULL DEFAULT 0,
    is_established         BOOLEAN          NOT NULL DEFAULT false,
    last_recalculated      TIMESTAMPTZ      NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, effort_tier)
);

-- ---------------------------------------------------------------------------
-- decoupling_trend
-- ---------------------------------------------------------------------------
-- Stores daily rolling 30-day mean decoupling per athlete and effort tier.
-- One row per (athlete_id, effort_tier, date).

CREATE TABLE IF NOT EXISTS decoupling_trend (
    id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id             UUID             NOT NULL REFERENCES athletes(id),
    effort_tier            TEXT             NOT NULL CHECK (effort_tier IN ('easy', 'moderate', 'hard')),
    date                   DATE             NOT NULL,
    rolling_30d_mean       DOUBLE PRECISION NOT NULL,
    n_activities           INTEGER          NOT NULL DEFAULT 0,
    UNIQUE (athlete_id, effort_tier, date)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_tier_date
    ON activity_decoupling (athlete_id, effort_tier, date);

CREATE INDEX IF NOT EXISTS idx_activity_decoupling_athlete_date
    ON activity_decoupling (athlete_id, date);

CREATE INDEX IF NOT EXISTS idx_decoupling_trend_athlete_tier_date
    ON decoupling_trend (athlete_id, effort_tier, date);

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- decoupling_trend gets DELETE permission; the other two do not.

GRANT SELECT, INSERT, UPDATE ON activity_decoupling TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON decoupling_baseline TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON decoupling_trend TO anon, authenticated;

ALTER TABLE activity_decoupling DISABLE ROW LEVEL SECURITY;
ALTER TABLE decoupling_baseline DISABLE ROW LEVEL SECURITY;
ALTER TABLE decoupling_trend    DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Extend athlete_notifications to accept 'decoupling_anomaly'
-- ---------------------------------------------------------------------------
-- The inline CHECK on the type column was auto-named athlete_notifications_type_check
-- by PostgreSQL. Drop it (IF NOT EXISTS makes this idempotent) and replace it
-- with an expanded constraint that includes the new notification type.

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

NOTIFY pgrst, 'reload schema';
