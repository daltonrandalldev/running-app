-- MON-002: daily_monotony_strain table
--
-- Stores per-athlete, per-day rolling 7-day monotony and strain values.
-- One row per athlete × date × sport. Upsert key: (athlete_id, date, sport).
--
-- monotony is nullable: NULL when stdev = 0 (degenerate case) or when fewer
-- than 7 days of history exist (days 1–6 from the earliest activity date).
--
-- strain is nullable for the same partial-window reason (days 1–6).
-- When monotony is NULL but a full window exists, strain = weekly TSS sum.
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
-- Prerequisites: athletes table must exist (created by daily_pmc_values.sql).

CREATE TABLE IF NOT EXISTS daily_monotony_strain (
    id           BIGSERIAL    PRIMARY KEY,
    athlete_id   UUID         NOT NULL REFERENCES athletes(id),
    date         DATE         NOT NULL,
    sport        TEXT         NOT NULL
                              CHECK (sport IN ('run', 'cycle', 'combined')),
    monotony     NUMERIC,     -- nullable: stdev=0 case or partial window
    strain       NUMERIC,     -- nullable: partial window only (days 1-6)
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, date, sport)
);

-- Primary query pattern: fetch all values for an athlete in a date range
CREATE INDEX IF NOT EXISTS idx_daily_monotony_strain_athlete_date
    ON daily_monotony_strain (athlete_id, date);

-- Sport-filtered date range queries (per-sport trend analysis)
CREATE INDEX IF NOT EXISTS idx_daily_monotony_strain_athlete_sport_date
    ON daily_monotony_strain (athlete_id, sport, date);

-- Access control (RLS disabled -- consistent with all other tables in this project)
GRANT SELECT, INSERT, UPDATE ON daily_monotony_strain TO anon, authenticated;

ALTER TABLE daily_monotony_strain DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
