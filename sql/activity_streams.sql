-- ING-002: activity_streams table
--
-- Per-second time-series raw telemetry for each activity.
-- Population is DEFERRED — this table is schema-ready but no data is written
-- until athletes.activity_streams_enabled = true.
-- All stream fields are nullable (device availability varies).
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS activity_streams (
    id                  BIGSERIAL    PRIMARY KEY,
    activity_id         TEXT         NOT NULL REFERENCES garmin_activities(activity_id)
                                     ON DELETE CASCADE,
    timestamp           TIMESTAMPTZ  NOT NULL,
    hr                  INT,
    pace_sec_per_km     FLOAT,
    power_watts         FLOAT,
    cadence             INT,
    elevation_m         FLOAT,
    lat                 FLOAT,
    lng                 FLOAT,
    gct_ms              INT,
    vertical_osc_cm     FLOAT,
    temperature_c       FLOAT,
    UNIQUE (activity_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_activity_streams_activity_time
    ON activity_streams (activity_id, timestamp);

GRANT SELECT, INSERT ON activity_streams TO anon, authenticated;
ALTER TABLE activity_streams DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
