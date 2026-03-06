-- PMC-006: parameter_change_log table
--
-- Full audit log of every parameter change: automated refits, user overrides,
-- and physiological-bound clamp events. One row per changed parameter per refit.
--
-- Designed to support PMC-006's history endpoint:
--   GET /athletes/:id/parameter-history → full log sorted by created_at DESC
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
--
-- Prerequisites: athlete_parameters.sql (creates the athletes table reference)

CREATE TABLE IF NOT EXISTS parameter_change_log (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id       UUID        NOT NULL REFERENCES athletes(id),
    sport            TEXT        NOT NULL,

    -- Which parameter changed (e.g. 'tc_fitness', 'tc_fatigue', 'k_race')
    parameter_name   TEXT        NOT NULL,

    -- What it was before (NULL on first personalization)
    old_value        FLOAT,

    -- What it changed to
    new_value        FLOAT       NOT NULL,

    -- Event type:
    --   'auto_fit'      → optimizer converged to this value
    --   'user_override' → athlete manually set the value (PMC-006)
    --   'clamped'       → optimizer output exceeded physiological bounds;
    --                     new_value is the clamped result, raw optimizer
    --                     output is recoverable via plain_english
    change_source    TEXT        CHECK (change_source IN ('auto_fit', 'user_override', 'clamped')),

    -- Model quality at time of change
    r_squared        FLOAT,
    n_data_points    INT,

    -- 95% CI bounds for this specific parameter (from bootstrap)
    ci_low           FLOAT,
    ci_high          FLOAT,

    -- Human-readable interpretation (required — surfaced in PMC-007 UI)
    plain_english    TEXT        NOT NULL,

    -- True when new_value differs from raw optimizer output due to clamping
    was_clamped      BOOLEAN     NOT NULL DEFAULT false,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for per-athlete history queries (R5)
CREATE INDEX IF NOT EXISTS idx_parameter_change_log_athlete_created
    ON parameter_change_log (athlete_id, created_at DESC);

-- Grant access (RLS disabled, matching other tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON parameter_change_log TO anon, authenticated;

ALTER TABLE parameter_change_log DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
