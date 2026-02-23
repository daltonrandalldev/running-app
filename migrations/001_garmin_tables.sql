-- migrations/001_garmin_tables.sql
-- ============================================================
-- Creates the garmin_ tables that mirror GarminDB's SQLite
-- schema for activities, daily summaries, and sleep.
--
-- Prefixed with garmin_ to isolate from existing tables.
-- RLS disabled (consistent with existing tables in this project).
-- Safe to re-run — all statements use IF NOT EXISTS.
-- ============================================================


-- ── garmin_activities ────────────────────────────────────────────────────────
-- One row per recorded activity. Maps to GarminDB's `activities` table
-- joined with `steps_activities` (running/walking) or `cycle_activities`.
-- All distances in kilometers, all speeds in km/h, all temps in Celsius.
-- Pace values stored as seconds (e.g. 300 = 5:00/km). Time durations in seconds.

CREATE TABLE IF NOT EXISTS garmin_activities (
    -- identity
    activity_id             TEXT            PRIMARY KEY,   -- Garmin's numeric activity ID (as string)
    name                    TEXT,
    description             TEXT,
    sport                   TEXT,                          -- 'running', 'cycling', 'walking', 'hiking', etc.
    sub_sport               TEXT,                          -- 'trail_running', 'indoor_cycling', etc.

    -- timing
    start_time              TIMESTAMPTZ,
    stop_time               TIMESTAMPTZ,
    elapsed_time_seconds    INTEGER,                       -- total elapsed time including pauses
    moving_time_seconds     INTEGER,                       -- active moving time

    -- distance & speed
    distance                DOUBLE PRECISION,              -- kilometers
    avg_speed               DOUBLE PRECISION,              -- km/h
    max_speed               DOUBLE PRECISION,              -- km/h

    -- heart rate
    avg_hr                  INTEGER,                       -- bpm
    max_hr                  INTEGER,                       -- bpm

    -- calories & effort
    calories                INTEGER,

    -- cadence (steps/min for running; rpm for cycling)
    avg_cadence             INTEGER,
    max_cadence             INTEGER,

    -- elevation (meters)
    ascent                  DOUBLE PRECISION,
    descent                 DOUBLE PRECISION,

    -- temperature (Celsius)
    avg_temperature         DOUBLE PRECISION,
    min_temperature         DOUBLE PRECISION,
    max_temperature         DOUBLE PRECISION,

    -- GPS coordinates
    start_lat               DOUBLE PRECISION,
    start_long              DOUBLE PRECISION,
    stop_lat                DOUBLE PRECISION,
    stop_long               DOUBLE PRECISION,

    -- Garmin training metrics
    training_load           DOUBLE PRECISION,
    training_effect         DOUBLE PRECISION,
    anaerobic_training_effect DOUBLE PRECISION,
    vo2_max                 DOUBLE PRECISION,

    -- HR zones (seconds spent in each zone)
    hrz_1_seconds           INTEGER,
    hrz_2_seconds           INTEGER,
    hrz_3_seconds           INTEGER,
    hrz_4_seconds           INTEGER,
    hrz_5_seconds           INTEGER,

    -- running dynamics (steps_activities — NULL for non-running)
    steps                   INTEGER,
    avg_pace_seconds        INTEGER,                       -- seconds per km
    avg_moving_pace_seconds INTEGER,                       -- seconds per km
    max_pace_seconds        INTEGER,                       -- seconds per km (fastest)
    avg_steps_per_min       INTEGER,
    max_steps_per_min       INTEGER,
    avg_step_length         DOUBLE PRECISION,              -- meters
    avg_vertical_ratio      DOUBLE PRECISION,              -- %
    avg_vertical_oscillation DOUBLE PRECISION,             -- meters
    avg_gct_balance         DOUBLE PRECISION,              -- left % of left-right ground contact balance
    avg_ground_contact_time_ms INTEGER,                    -- milliseconds
    avg_stance_time_percent DOUBLE PRECISION,

    -- respiration (breaths/min)
    avg_rr                  DOUBLE PRECISION,
    max_rr                  DOUBLE PRECISION,

    -- metadata
    synced_at               TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Index for time-range queries (the most common access pattern)
CREATE INDEX IF NOT EXISTS garmin_activities_start_time_idx
    ON garmin_activities (start_time DESC);

-- Index for sport-type filtering
CREATE INDEX IF NOT EXISTS garmin_activities_sport_idx
    ON garmin_activities (sport);


-- ── garmin_daily_summary ─────────────────────────────────────────────────────
-- One row per calendar day. Maps to GarminDB's `daily_summary` table.
-- Captures overall wellness metrics: steps, HR ranges, stress, calories, sleep.

CREATE TABLE IF NOT EXISTS garmin_daily_summary (
    day                     DATE            PRIMARY KEY,

    -- heart rate
    hr_min                  INTEGER,                       -- bpm (lowest of the day)
    hr_max                  INTEGER,                       -- bpm (highest of the day)
    rhr                     INTEGER,                       -- resting heart rate

    -- stress
    stress_avg              INTEGER,                       -- 0–100 Garmin stress score

    -- steps
    step_goal               INTEGER,
    steps                   INTEGER,

    -- distance
    distance                DOUBLE PRECISION,              -- km

    -- floors
    floors_up               DOUBLE PRECISION,
    floors_down             DOUBLE PRECISION,

    -- calories
    calories_total          INTEGER,
    calories_active         INTEGER,
    calories_bmr            INTEGER,
    calories_goal           INTEGER,

    -- activity intensity (seconds)
    moderate_activity_seconds INTEGER,
    vigorous_activity_seconds INTEGER,

    -- oxygen & respiration
    spo2_avg                DOUBLE PRECISION,              -- %
    spo2_min                DOUBLE PRECISION,              -- %
    rr_waking_avg           DOUBLE PRECISION,              -- breaths/min
    rr_max                  DOUBLE PRECISION,
    rr_min                  DOUBLE PRECISION,

    -- body battery (Garmin energy level 0–100)
    bb_max                  INTEGER,
    bb_min                  INTEGER,

    -- metadata
    synced_at               TIMESTAMPTZ     NOT NULL DEFAULT now()
);


-- ── garmin_sleep ─────────────────────────────────────────────────────────────
-- One row per night. Maps to GarminDB's `sleep` table.
-- All duration fields stored as seconds for easy arithmetic.

CREATE TABLE IF NOT EXISTS garmin_sleep (
    day                     DATE            PRIMARY KEY,

    start_time              TIMESTAMPTZ,
    end_time                TIMESTAMPTZ,

    -- sleep stages (seconds)
    total_sleep_seconds     INTEGER,
    deep_sleep_seconds      INTEGER,
    light_sleep_seconds     INTEGER,
    rem_sleep_seconds       INTEGER,
    awake_seconds           INTEGER,

    -- wellness metrics during sleep
    avg_spo2                DOUBLE PRECISION,              -- %
    avg_rr                  DOUBLE PRECISION,              -- breaths/min
    avg_stress              DOUBLE PRECISION,              -- 0–100

    -- Garmin sleep score
    score                   INTEGER,
    qualifier               TEXT,                          -- e.g. 'FAIR', 'GOOD', 'EXCELLENT'

    -- metadata
    synced_at               TIMESTAMPTZ     NOT NULL DEFAULT now()
);


-- ── Access control ───────────────────────────────────────────────────────────
-- Grant read access so the Supabase JS client (anon key) can query these tables.

GRANT SELECT ON garmin_activities     TO anon, authenticated;
GRANT SELECT ON garmin_daily_summary  TO anon, authenticated;
GRANT SELECT ON garmin_sleep          TO anon, authenticated;

-- Disable RLS — consistent with existing tables in this project (no auth yet).

ALTER TABLE garmin_activities     DISABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_daily_summary  DISABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_sleep          DISABLE ROW LEVEL SECURITY;

-- Notify PostgREST to pick up the new tables immediately.
NOTIFY pgrst, 'reload schema';
