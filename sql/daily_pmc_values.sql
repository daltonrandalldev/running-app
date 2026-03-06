-- PMC-001: daily_pmc_values table
--
-- Stores per-athlete, per-day PMC snapshots (CTL / ATL / TSB).
-- Upsert key: (athlete_id, date, sport)
--
-- Run once against your Supabase project via the SQL editor or psql.
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS / DO NOTHING).

-- Placeholder single-athlete row (used until authentication is implemented).
-- Replace with a real athletes table + FK when auth is added.
CREATE TABLE IF NOT EXISTS athletes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO athletes (id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- Daily PMC snapshot table
CREATE TABLE IF NOT EXISTS daily_pmc_values (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id       UUID        NOT NULL REFERENCES athletes(id),
    date             DATE        NOT NULL,
    sport            TEXT        NOT NULL DEFAULT 'combined',
    ctl              FLOAT       NOT NULL,
    atl              FLOAT       NOT NULL,
    tsb              FLOAT       NOT NULL,
    tc_fitness_used  FLOAT       NOT NULL DEFAULT 42,
    tc_fatigue_used  FLOAT       NOT NULL DEFAULT 7,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, date, sport)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_daily_pmc_athlete_date
    ON daily_pmc_values (athlete_id, date);

CREATE INDEX IF NOT EXISTS idx_daily_pmc_athlete_sport_date
    ON daily_pmc_values (athlete_id, sport, date);

-- Grant access to Supabase anon/authenticated roles (RLS disabled for now)
GRANT SELECT, INSERT, UPDATE ON daily_pmc_values TO anon, authenticated;
GRANT SELECT, INSERT ON athletes TO anon, authenticated;

ALTER TABLE daily_pmc_values DISABLE ROW LEVEL SECURITY;
ALTER TABLE athletes         DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
