-- migrations/002_garmin_laps.sql
-- ============================================================
-- Adds the garmin_activity_laps table.
--
-- Decision: activity_records (per-second GPS/HR stream) is
-- intentionally NOT synced. At 500 activities it would grow
-- to ~150 MB in Postgres; laps give per-mile/km HR, pace,
-- cadence, and zone time at negligible cost (~4 KB total per
-- 500 activities). Records can be added later as a 30-second
-- downsampled table when time-series charts or route maps are
-- needed. The raw source data is always available in the local
-- GarminDB SQLite at ~/HealthData/DBs/garmin_activities.db.
--
-- Safe to re-run — uses IF NOT EXISTS.
-- ============================================================


-- ── garmin_activity_laps ─────────────────────────────────────────────────────
-- One row per lap within an activity. Maps to GarminDB's `activity_laps` table.
-- Lap numbers are 0-indexed (lap 0 = first lap).
-- All durations in seconds, distances in kilometers, temps in Celsius.
-- HR zone time columns store seconds spent in each zone per lap.
-- HR zone HR columns store the threshold BPM that starts each zone.

CREATE TABLE IF NOT EXISTS garmin_activity_laps (
    -- identity (composite PK matching GarminDB)
    activity_id             TEXT            NOT NULL
                                REFERENCES garmin_activities (activity_id)
                                ON DELETE CASCADE,
    lap                     INTEGER         NOT NULL,               -- 0-indexed lap number

    -- timing
    start_time              TIMESTAMPTZ,
    stop_time               TIMESTAMPTZ,
    elapsed_time_seconds    INTEGER,                                -- total lap time including pauses
    moving_time_seconds     INTEGER,                                -- active moving time within lap

    -- distance & movement
    distance                DOUBLE PRECISION,                       -- kilometers
    cycles                  DOUBLE PRECISION,                       -- stride cycles (used to compute cadence)

    -- heart rate
    avg_hr                  INTEGER,                                -- bpm
    max_hr                  INTEGER,                                -- bpm

    -- calories
    calories                INTEGER,

    -- cadence (steps/min for running; rpm for cycling)
    avg_cadence             INTEGER,
    max_cadence             INTEGER,

    -- elevation (meters)
    ascent                  DOUBLE PRECISION,
    descent                 DOUBLE PRECISION,

    -- temperature (Celsius)
    avg_temperature         DOUBLE PRECISION,
    min_temperature         DOUBLE PRECISION,                       -- sparse: not always recorded
    max_temperature         DOUBLE PRECISION,

    -- speed (km/h) — sparse: NULL for most Garmin running activities
    avg_speed               DOUBLE PRECISION,
    max_speed               DOUBLE PRECISION,

    -- respiration (breaths/min) — sparse: device-dependent
    avg_rr                  DOUBLE PRECISION,
    max_rr                  DOUBLE PRECISION,

    -- GPS coordinates
    start_lat               DOUBLE PRECISION,
    start_long              DOUBLE PRECISION,
    stop_lat                DOUBLE PRECISION,
    stop_long               DOUBLE PRECISION,

    -- HR zone definitions (threshold BPM that starts each zone)
    hr_zones_method         TEXT,                                   -- 'heart_rate_reserve', 'percent_max_hr', etc.
    hrz_1_hr                INTEGER,
    hrz_2_hr                INTEGER,
    hrz_3_hr                INTEGER,
    hrz_4_hr                INTEGER,
    hrz_5_hr                INTEGER,

    -- HR zone time (seconds spent in each zone during this lap)
    hrz_1_seconds           INTEGER,
    hrz_2_seconds           INTEGER,
    hrz_3_seconds           INTEGER,
    hrz_4_seconds           INTEGER,
    hrz_5_seconds           INTEGER,

    -- metadata
    synced_at               TIMESTAMPTZ     NOT NULL DEFAULT now(),

    PRIMARY KEY (activity_id, lap)
);

-- Index for fetching all laps for a single activity (primary access pattern)
CREATE INDEX IF NOT EXISTS garmin_activity_laps_activity_id_idx
    ON garmin_activity_laps (activity_id);

-- Index for time-range queries (e.g. "all laps in the last 4 weeks")
CREATE INDEX IF NOT EXISTS garmin_activity_laps_start_time_idx
    ON garmin_activity_laps (start_time DESC);


-- ── Access control ────────────────────────────────────────────────────────────

GRANT SELECT ON garmin_activity_laps TO anon, authenticated;
ALTER TABLE garmin_activity_laps DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
