-- Add avg_power column to garmin_activities
--
-- Stores average power (watts) per activity, sourced from Intervals.icu
-- average_watts field. Distinct from normalized_power (NP), which already exists.
-- Idempotent (uses ADD COLUMN IF NOT EXISTS).
-- Run once via the Supabase SQL editor.

ALTER TABLE garmin_activities
    ADD COLUMN IF NOT EXISTS avg_power FLOAT;

NOTIFY pgrst, 'reload schema';
