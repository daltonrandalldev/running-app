-- ING-003: daily_health table
--
-- Daily wellness metrics per athlete. One row per (athlete_id, date).
-- Sources: GarminDB (via Python sync) and/or Intervals.icu wellness endpoint.
-- All metric columns are nullable — field availability depends on device and source.
-- HRV stored as two columns: hrv_rmssd (RMSSD ms) and hrv_status (Garmin 1–5 scale).
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
-- Prerequisites: daily_pmc_values.sql must have run (provides athletes table).

CREATE TABLE IF NOT EXISTS daily_health (
    id                  BIGSERIAL    PRIMARY KEY,
    athlete_id          UUID         NOT NULL REFERENCES athletes(id),
    date                DATE         NOT NULL,
    source_platform     TEXT         NOT NULL DEFAULT 'garmin'
                                     CHECK (source_platform IN (
                                         'garmin', 'intervals_icu', 'merged'
                                     )),
    resting_hr          INT,
    hrv_rmssd           FLOAT,
    hrv_status          INT
                                     CHECK (hrv_status BETWEEN 1 AND 5),
    sleep_total_min     INT,
    sleep_deep_min      INT,
    sleep_light_min     INT,
    sleep_rem_min       INT,
    sleep_awake_min     INT,
    weight_kg           FLOAT,
    spo2_pct            FLOAT,
    stress_score        INT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_health_athlete_date
    ON daily_health (athlete_id, date);

GRANT SELECT, INSERT, UPDATE ON daily_health TO anon, authenticated;
ALTER TABLE daily_health DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
