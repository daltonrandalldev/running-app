"""
garmin_adapter.py
=================

GarminDB-specific helpers for ING-004:

1. get_local_timezone(lat, lng) — derives IANA timezone string from GPS coords.
2. upsert_daily_health(garmin_db, since_date) — reads DailySummary, Sleep, and
   BodyComposition from GarminDB monitoring tables and upserts into daily_health
   via the Supabase Python client.

ING-004: GarminDB Pipeline Extension
"""

import logging
import os
from datetime import date
from typing import Optional

from supabase import create_client, Client
from timezonefinder import TimezoneFinder

logger = logging.getLogger(__name__)

ATHLETE_UUID = "00000000-0000-0000-0000-000000000001"  # placeholder until auth

_tf = TimezoneFinder()


# ── Timezone derivation ────────────────────────────────────────────────────────

def get_local_timezone(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    """Returns IANA timezone string for the given coordinates, or None if coordinates absent."""
    if lat is None or lng is None:
        return None
    return _tf.timezone_at(lat=lat, lng=lng)


# ── Supabase client ────────────────────────────────────────────────────────────

def _get_supabase() -> Client:
    url = os.environ["EXPO_PUBLIC_SUPABASE_URL"]
    key = os.environ["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    return create_client(url, key)


# ── Conversion helpers ─────────────────────────────────────────────────────────

def _time_to_minutes(t) -> Optional[int]:
    """Convert a datetime.time duration to total minutes. Returns None for zero/None."""
    if t is None:
        return None
    total = (t.hour * 3600 + t.minute * 60 + t.second) // 60
    return total if total > 0 else None


def _i(val) -> Optional[int]:
    """Return int or None."""
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _f(val) -> Optional[float]:
    """Return float or None."""
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


# ── daily_health upsert ────────────────────────────────────────────────────────

def upsert_daily_health(garmin_db, since_date: Optional[date]) -> int:
    """
    Reads DailySummary, Sleep, and BodyComposition from GarminDB and upserts
    into daily_health with source_platform = 'garmin'.

    Returns the number of rows upserted.
    """
    from garmindb.garmindb import DailySummary, Sleep

    supabase = _get_supabase()
    count = 0

    with garmin_db.managed_session() as session:
        query = session.query(DailySummary)
        if since_date:
            query = query.filter(DailySummary.day >= since_date)
        daily_rows = query.order_by(DailySummary.day).all()

        if not daily_rows:
            return 0

        # Build a lookup of sleep rows keyed by day for O(1) access
        sleep_query = session.query(Sleep)
        if since_date:
            sleep_query = sleep_query.filter(Sleep.day >= since_date)
        sleep_by_day = {s.day: s for s in sleep_query.all()}

        # Attempt to load BodyComposition — not available in all GarminDB versions
        body_comp_by_day = {}
        try:
            from garmindb.garmindb import BodyComposition
            bc_query = session.query(BodyComposition)
            if since_date:
                bc_query = bc_query.filter(BodyComposition.day >= since_date)
            body_comp_by_day = {bc.day: bc for bc in bc_query.all()}
        except Exception:
            logger.debug("BodyComposition table not available in this GarminDB version — weight will be NULL")

        for d in daily_rows:
            day_str = d.day.isoformat()

            # Resting HR from DailySummary.rhr
            resting_hr = _i(d.rhr)

            # HRV: GarminDB does not reliably export HRV RMSSD or status
            hrv_rmssd: Optional[float] = None
            hrv_status: Optional[int] = None

            # SpO2 from DailySummary.spo2_avg
            spo2_pct = _f(d.spo2_avg)

            # Stress from DailySummary.stress_avg
            stress_score = _i(d.stress_avg)

            # Sleep fields
            sleep_total_min = None
            sleep_deep_min = None
            sleep_light_min = None
            sleep_rem_min = None
            sleep_awake_min = None

            sleep_row = sleep_by_day.get(d.day)
            if sleep_row is not None:
                sleep_total_min = _time_to_minutes(sleep_row.total_sleep)
                sleep_deep_min = _time_to_minutes(sleep_row.deep_sleep)
                sleep_light_min = _time_to_minutes(sleep_row.light_sleep)
                sleep_rem_min = _time_to_minutes(sleep_row.rem_sleep)
                sleep_awake_min = _time_to_minutes(sleep_row.awake)

            # Weight from BodyComposition if available
            weight_kg = None
            bc_row = body_comp_by_day.get(d.day)
            if bc_row is not None:
                try:
                    weight_kg = _f(bc_row.weight)
                except Exception:
                    weight_kg = None

            supabase.table("daily_health").upsert({
                "athlete_id":       ATHLETE_UUID,
                "date":             day_str,
                "source_platform":  "garmin",
                "resting_hr":       resting_hr,
                "hrv_rmssd":        hrv_rmssd,
                "hrv_status":       hrv_status,
                "sleep_total_min":  sleep_total_min,
                "sleep_deep_min":   sleep_deep_min,
                "sleep_light_min":  sleep_light_min,
                "sleep_rem_min":    sleep_rem_min,
                "sleep_awake_min":  sleep_awake_min,
                "weight_kg":        weight_kg,
                "spo2_pct":         spo2_pct,
                "stress_score":     stress_score,
            }, on_conflict="athlete_id,date").execute()
            count += 1

    return count
