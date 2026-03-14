-- icu_units_backfill.sql
-- One-time fix: normalise existing Intervals.icu activity rows to match
-- GarminDB convention (distance in km, avg_speed in kph).
--
-- ICU API returns distance in metres and speed in m/s; the adapter
-- originally stored raw values. Garmin activities use km and kph, so
-- all display code assumes those units.
--
-- Safe to re-run: the WHERE guard (distance > 100) ensures only rows
-- that still carry raw-metre values are updated. After the fix,
-- distance will be ~0.04–200 km — well below the 100 threshold.

UPDATE garmin_activities
SET
    distance  = distance  / 1000.0,
    avg_speed = avg_speed * 3.6
WHERE source_platform = 'intervals_icu'
  AND distance > 100;   -- raw metres are always >> 100; km values never are
