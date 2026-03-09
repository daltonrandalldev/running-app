-- MON-003: Extend athlete_notifications type CHECK to include 'high_monotony_strain'
--
-- Idempotent — safe to run multiple times (DROP CONSTRAINT IF EXISTS).
-- Prerequisites:
--   - athlete_notifications table must exist (created by athlete_notifications.sql)
--   - activity_ef.sql must have run (establishes 'ef_alert' in the constraint)

ALTER TABLE athlete_notifications
    DROP CONSTRAINT IF EXISTS athlete_notifications_type_check;

ALTER TABLE athlete_notifications
    ADD CONSTRAINT athlete_notifications_type_check
    CHECK (type IN (
        'personalization_available',
        'model_updated',
        'more_data_needed',
        'decoupling_anomaly',
        'gap_anomaly',
        'ef_alert',
        'high_monotony_strain'
    ));

NOTIFY pgrst, 'reload schema';
