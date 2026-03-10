-- ING-001: Profile column additions to athletes
--
-- Adds FTP, threshold pace, HR/pace/power zone config columns.
-- Idempotent (uses ADD COLUMN IF NOT EXISTS).
-- Run once via the Supabase SQL editor.
-- Prerequisites: daily_pmc_values.sql must have run (creates athletes table).

ALTER TABLE athletes
    ADD COLUMN IF NOT EXISTS ftp_cycling               FLOAT,
    ADD COLUMN IF NOT EXISTS threshold_pace_sec_per_km FLOAT,
    ADD COLUMN IF NOT EXISTS max_hr                    INT,
    ADD COLUMN IF NOT EXISTS resting_hr_baseline       INT,
    ADD COLUMN IF NOT EXISTS hr_zones                  JSONB,
    ADD COLUMN IF NOT EXISTS pace_zones                JSONB,
    ADD COLUMN IF NOT EXISTS power_zones               JSONB,
    ADD COLUMN IF NOT EXISTS activity_streams_enabled  BOOLEAN  NOT NULL DEFAULT false;

GRANT SELECT, UPDATE ON athletes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
