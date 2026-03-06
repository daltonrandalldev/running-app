-- PMC-004: athlete_parameters table
--
-- Stores fitted (or default) PMC decay constants per athlete/sport.
-- One row per (athlete_id, sport) — upserted on each refit.
-- is_personalized = false until the optimizer has run successfully.
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
--
-- Prerequisites: daily_pmc_values.sql (creates the athletes table)

CREATE TABLE IF NOT EXISTS athlete_parameters (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id       UUID        NOT NULL REFERENCES athletes(id),
    sport            TEXT        NOT NULL DEFAULT 'combined',

    -- Fitted decay constants (defaults until personalized)
    tc_fitness       FLOAT       NOT NULL DEFAULT 42,
    tc_fatigue       FLOAT       NOT NULL DEFAULT 7,

    -- Linear model coefficients: predicted_perf = k1*CTL - k2*ATL + intercept
    k1               FLOAT,
    k2               FLOAT,
    intercept        FLOAT,

    -- Personalization state
    is_personalized  BOOLEAN     NOT NULL DEFAULT false,

    -- Fit quality
    r_squared        FLOAT,
    n_benchmarks     INT,

    -- 95% confidence intervals from bootstrap (1000 resamples)
    ci_tc_fitness_low  FLOAT,
    ci_tc_fitness_high FLOAT,
    ci_tc_fatigue_low  FLOAT,
    ci_tc_fatigue_high FLOAT,

    fitted_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (athlete_id, sport)
);

-- Index for per-athlete lookups
CREATE INDEX IF NOT EXISTS idx_athlete_parameters_athlete
    ON athlete_parameters (athlete_id);

-- Grant access (RLS disabled, matching other tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON athlete_parameters TO anon, authenticated;

ALTER TABLE athlete_parameters DISABLE ROW LEVEL SECURITY;

-- ── benchmark_efforts: add param_version column ───────────────────────────────
--
-- Tags each benchmark row with which parameter version was in use when it was
-- recorded. Value is 'default' before personalization, or the ISO timestamp of
-- the athlete_parameters.fitted_at at time of recording.
--
-- This preserves the original CTL/ATL snapshot while enabling a full audit
-- trail of "what did the model see at the time" (Gap 2 resolution).

ALTER TABLE benchmark_efforts
    ADD COLUMN IF NOT EXISTS param_version TEXT;

NOTIFY pgrst, 'reload schema';
