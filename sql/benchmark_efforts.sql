-- PMC-003: benchmark_efforts table
--
-- Stores earmarked benchmark efforts used as ground-truth performance
-- observations for adaptive PMC parameter fitting (PMC-004).
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
--
-- Prerequisites: daily_pmc_values.sql (creates the athletes table)

CREATE TABLE IF NOT EXISTS benchmark_efforts (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id        UUID        NOT NULL REFERENCES athletes(id),
    -- Garmin activity ID (TEXT, not UUID — matches garmin_activities.activity_id)
    activity_id       TEXT,
    date              DATE        NOT NULL,
    sport             TEXT        NOT NULL,
    duration_seconds  INT         NOT NULL,
    -- Normalized performance metric:
    --   Running  → VDOT (Jack Daniels, ~30–85 scale, comparable across distances)
    --   Cycling  → normalized power in watts/kg (manually entered)
    performance_score FLOAT       NOT NULL,
    effort_level      TEXT        CHECK (effort_level IN ('user_confirmed', 'auto_detected')),
    ctl_on_date       FLOAT,       -- CTL at time of benchmark (from daily_pmc_values)
    atl_on_date       FLOAT,       -- ATL at time of benchmark (from daily_pmc_values)
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index so each Garmin activity maps to at most one benchmark row.
-- Partial (WHERE activity_id IS NOT NULL) allows NULL for manually entered benchmarks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_efforts_activity
    ON benchmark_efforts (activity_id)
    WHERE activity_id IS NOT NULL;

-- Indexes for common query patterns (R1)
CREATE INDEX IF NOT EXISTS idx_benchmark_efforts_athlete_date
    ON benchmark_efforts (athlete_id, date);

CREATE INDEX IF NOT EXISTS idx_benchmark_efforts_athlete_sport
    ON benchmark_efforts (athlete_id, sport);

-- Grant access (RLS disabled for now, matching other tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON benchmark_efforts TO anon, authenticated;

ALTER TABLE benchmark_efforts DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
