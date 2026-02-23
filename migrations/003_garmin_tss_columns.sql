-- migrations/003_garmin_tss_columns.sql
-- ============================================================
-- Adds computed training-load columns to garmin_activities.
--
-- These are written by pmc_backend.py after each sync and
-- replace the equivalent columns on the now-deprecated
-- `activities` table (which was a static one-time download).
--
-- Safe to re-run — uses ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS trimp          DOUBLE PRECISION;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS pace_load_flat DOUBLE PRECISION;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS pace_load_gap  DOUBLE PRECISION;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS active_load    DOUBLE PRECISION;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS hr_tss         DOUBLE PRECISION;

NOTIFY pgrst, 'reload schema';
