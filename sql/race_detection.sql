-- PMC-002: Race detection fields on garmin_activities
--
-- Adds is_race, race_detection_source, k_race_applied, effective_tss_race.
-- Migrates existing records to race_detection_source = 'none'.
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS / DO NOTHING).

ALTER TABLE garmin_activities
  ADD COLUMN IF NOT EXISTS is_race              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS race_detection_source TEXT
    CHECK (race_detection_source IN ('user', 'auto', 'none'))
    DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS k_race_applied       FLOAT,
  ADD COLUMN IF NOT EXISTS effective_tss_race   FLOAT;

-- Backfill: any existing row that has no source yet gets 'none'
UPDATE garmin_activities
SET race_detection_source = 'none'
WHERE race_detection_source IS NULL;

-- Index to support efficient auto-detection queries (unevaluated rows)
CREATE INDEX IF NOT EXISTS idx_garmin_race_detection_source
  ON garmin_activities (race_detection_source);

GRANT SELECT, UPDATE ON garmin_activities TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
