-- ING-005: activity_sources backfill for existing GarminDB activities
--
-- Inserts a row into activity_sources for every garmin_activities row
-- that has source_platform = 'garmin' and no existing activity_sources row.
--
-- is_preferred = true: GarminDB rows are always the canonical/preferred version.
-- external_id = activity_id: for GarminDB activities, the external ID is the activity's own ID.
--
-- Safe to re-run: ON CONFLICT DO NOTHING on (source_platform, external_id).
-- Prerequisites: ING-001 must have run (activity_sources table must exist,
--                garmin_activities.source_platform column must exist).

INSERT INTO activity_sources (
    canonical_activity_id,
    source_platform,
    external_id,
    start_time,
    sport_type,
    is_preferred
)
SELECT
    ga.activity_id       AS canonical_activity_id,
    'garmin'             AS source_platform,
    ga.activity_id       AS external_id,
    ga.start_time        AS start_time,
    ga.sport             AS sport_type,
    true                 AS is_preferred
FROM garmin_activities ga
WHERE ga.source_platform = 'garmin'
  AND NOT EXISTS (
      SELECT 1
      FROM activity_sources asrc
      WHERE asrc.source_platform = 'garmin'
        AND asrc.external_id = ga.activity_id
  )
ON CONFLICT (source_platform, external_id) DO NOTHING;

-- Verification query (run manually to confirm row counts match):
-- SELECT COUNT(*) FROM activity_sources WHERE source_platform = 'garmin';
-- Should equal: SELECT COUNT(*) FROM garmin_activities WHERE source_platform = 'garmin';
