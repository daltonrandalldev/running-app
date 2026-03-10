-- ING-001: Column additions to garmin_activities
--
-- Adds source_platform, normalized_power, local_timezone.
-- Idempotent (uses ADD COLUMN IF NOT EXISTS).
-- Run once via the Supabase SQL editor.

ALTER TABLE garmin_activities
    ADD COLUMN IF NOT EXISTS source_platform   TEXT    NOT NULL DEFAULT 'garmin',
    ADD COLUMN IF NOT EXISTS normalized_power  FLOAT,
    ADD COLUMN IF NOT EXISTS local_timezone    TEXT;

UPDATE garmin_activities
SET source_platform = 'garmin'
WHERE source_platform IS NULL;

CREATE INDEX IF NOT EXISTS idx_garmin_activities_source_platform
    ON garmin_activities (source_platform);

GRANT SELECT, UPDATE ON garmin_activities TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
