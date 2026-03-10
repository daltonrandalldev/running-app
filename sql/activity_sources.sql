-- ING-001: activity_sources table
--
-- Deduplication tracking. One row per source-platform instance of an activity.
-- canonical_activity_id references garmin_activities(activity_id) — the winning row.
-- is_preferred = true designates the version whose fields are authoritative.
-- GarminDB is canonical when both sources have the same activity.
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS activity_sources (
    id                   BIGSERIAL    PRIMARY KEY,
    canonical_activity_id TEXT        NOT NULL REFERENCES garmin_activities(activity_id)
                                      ON DELETE CASCADE,
    source_platform      TEXT         NOT NULL
                                      CHECK (source_platform IN (
                                          'garmin', 'intervals_icu', 'zwift',
                                          'strava', 'wahoo', 'manual'
                                      )),
    external_id          TEXT         NOT NULL,
    start_time           TIMESTAMPTZ  NOT NULL,
    sport_type           TEXT         NOT NULL,
    is_preferred         BOOLEAN      NOT NULL DEFAULT false,
    raw_data_ref         TEXT,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_sources_canonical
    ON activity_sources (canonical_activity_id);

CREATE INDEX IF NOT EXISTS idx_activity_sources_preferred
    ON activity_sources (canonical_activity_id, is_preferred);

GRANT SELECT, INSERT, UPDATE ON activity_sources TO anon, authenticated;
ALTER TABLE activity_sources DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
