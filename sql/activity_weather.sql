-- Section 21: activity_weather table
--
-- Stores weather conditions at the time and location of each outdoor activity.
-- Source: Open-Meteo historical archive API (archive-api.open-meteo.com).
-- Indoor activities (start_lat IS NULL) are excluded — no row is inserted.
--
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS).
--
-- Prerequisites:
--   - athletes table must exist (created by daily_pmc_values.sql)
--   - activity_ef.sql must have run (establishes activity_ef table referenced
--     by the EF backfill pipeline)

CREATE TABLE IF NOT EXISTS activity_weather (
    -- Primary key: matches activity_ef.activity_id type (TEXT)
    activity_id             TEXT             PRIMARY KEY,

    -- Athlete reference (no FK on activity_id; consistent with activity_ef pattern)
    athlete_id              UUID             NOT NULL REFERENCES athletes(id),

    -- Weather conditions at activity start time (Open-Meteo hourly data)
    temperature_celsius     DOUBLE PRECISION,
    humidity_pct            DOUBLE PRECISION,
    wind_speed_kmh          DOUBLE PRECISION,
    wind_direction_deg      DOUBLE PRECISION,

    -- Elevation from Open-Meteo DEM (not device GPS elevation)
    elevation_m             DOUBLE PRECISION,

    -- Mid-run temperature delta: max - min over activity duration (hourly resolution)
    -- NULL for activities < 1 hour (only one hourly data point available)
    mid_run_temp_delta      DOUBLE PRECISION,

    -- True when mid_run_temp_delta > 3°C (segment adjustment flagged)
    used_segment_adjustment BOOLEAN          NOT NULL DEFAULT false,

    -- Audit timestamp
    fetched_at              TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Index for per-athlete weather lookups (join with activity_ef)
CREATE INDEX IF NOT EXISTS idx_activity_weather_athlete
    ON activity_weather (athlete_id);

-- Access control (RLS disabled — consistent with all other tables)
GRANT SELECT, INSERT, UPDATE ON activity_weather TO anon, authenticated;

ALTER TABLE activity_weather DISABLE ROW LEVEL SECURITY;

-- Add heat_sensitivity_k column to athlete_parameters for personal coefficient storage
ALTER TABLE athlete_parameters
    ADD COLUMN IF NOT EXISTS heat_sensitivity_k DOUBLE PRECISION;

NOTIFY pgrst, 'reload schema';
