-- EF-001: Efficiency Factor (EF) Schema Migration
--
-- Creates two tables for EF analytics:
--   activity_ef      – one row per activity: activity-level EF value and qualification status
--   daily_ef_trend   – one row per (athlete_id, date): rolling EF trend and slope metrics
--
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS, DROP CONSTRAINT IF EXISTS).
--
-- Prerequisites:
--   - athletes table must exist (created by daily_pmc_values.sql)
--   - activity_gap.sql must have run (adds 'gap_anomaly' to notifications)


-- ---------------------------------------------------------------------------
-- activity_ef
-- ---------------------------------------------------------------------------
-- One row per activity. Upsert key: (athlete_id, activity_id).
-- Stores the computed EF value and all inputs required to verify or re-derive it.

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

-- Date-range queries per athlete (activity list, downstream consumers)
CREATE INDEX IF NOT EXISTS idx_activity_ef_athlete_date
    ON activity_ef (athlete_id, date);

-- Efficient lookup of qualifying activities for rolling EF trend computation
CREATE INDEX IF NOT EXISTS idx_activity_ef_qualifying
    ON activity_ef (athlete_id, qualifying, date)
    WHERE qualifying = true;


-- ---------------------------------------------------------------------------
-- daily_ef_trend
-- ---------------------------------------------------------------------------
-- One row per (athlete_id, date). Stores rolling EF averages and slope metrics
-- derived from qualifying activity_ef rows in the preceding windows.

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

-- Date-range queries per athlete (trend chart, downstream consumers)
CREATE INDEX IF NOT EXISTS idx_daily_ef_trend_athlete_date
    ON daily_ef_trend (athlete_id, date);


-- ---------------------------------------------------------------------------
-- Access control (RLS disabled -- consistent with all other tables)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON activity_ef      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON daily_ef_trend   TO anon, authenticated;

ALTER TABLE activity_ef     DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_ef_trend  DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Extend athlete_notifications CHECK constraint to include 'ef_alert'
-- (reserved for future use -- not triggered in Section 3 implementation)
-- ---------------------------------------------------------------------------
-- The constraint was last modified in activity_gap.sql. We extend it again
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
        'gap_anomaly',
        'ef_alert'
    ));

NOTIFY pgrst, 'reload schema';
