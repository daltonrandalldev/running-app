"""
garmin_adapter.py
=================

GarminDB-specific helpers for ING-004:
  - get_local_timezone(): derive IANA tz string from GPS coords
  - sync_daily_health(): read GarminDB monitoring tables → upsert daily_health
"""

import os
from timezonefinder import TimezoneFinder
from supabase import create_client, Client

_tf = TimezoneFinder()

ATHLETE_UUID = "00000000-0000-0000-0000-000000000001"  # placeholder until auth


def _get_supabase() -> Client:
    url = os.environ["EXPO_PUBLIC_SUPABASE_URL"]
    key = os.environ["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    return create_client(url, key)


def get_local_timezone(lat: float | None, lng: float | None) -> str | None:
    """Returns IANA timezone string for the given coordinates, or None if absent."""
    if lat is None or lng is None:
        return None
    return _tf.timezone_at(lat=lat, lng=lng)


def sync_daily_health(garmindb_conn, date_str: str) -> None:
    """
    Read wellness metrics from GarminDB monitoring tables for date_str
    and upsert a row into daily_health with source_platform='garmin'.

    garmindb_conn: a sqlite3.Connection to the GarminDB monitoring database.
    date_str: ISO date string, e.g. '2025-06-15'.
    """
    supabase = _get_supabase()

    # Read resting HR (minimum HR for the day from monitoring_hr)
    resting_hr = _query_scalar(
        garmindb_conn,
        "SELECT MIN(heart_rate) FROM monitoring_hr WHERE timestamp LIKE ?",
        (f"{date_str}%",),
    )

    # Read sleep metrics
    sleep_row = _query_row(
        garmindb_conn,
        """SELECT total_sleep, deep_sleep, light_sleep, rem_sleep, awake_time
           FROM sleep WHERE day = ?""",
        (date_str,),
    )
    sleep_total_min  = _minutes(sleep_row, "total_sleep")  if sleep_row else None
    sleep_deep_min   = _minutes(sleep_row, "deep_sleep")   if sleep_row else None
    sleep_light_min  = _minutes(sleep_row, "light_sleep")  if sleep_row else None
    sleep_rem_min    = _minutes(sleep_row, "rem_sleep")    if sleep_row else None
    sleep_awake_min  = _minutes(sleep_row, "awake_time")   if sleep_row else None

    # Read body weight
    weight_row = _query_row(
        garmindb_conn,
        "SELECT weight FROM body_composition WHERE day = ?",
        (date_str,),
    )
    weight_kg = weight_row["weight"] if weight_row else None

    # Read SpO2
    spo2 = _query_scalar(
        garmindb_conn,
        "SELECT AVG(spo2) FROM monitoring_spo2 WHERE timestamp LIKE ?",
        (f"{date_str}%",),
    )

    # Read stress score (Body Battery)
    stress_score = _query_scalar(
        garmindb_conn,
        "SELECT AVG(stress_level) FROM stress WHERE timestamp LIKE ?",
        (f"{date_str}%",),
    )
    if stress_score is not None:
        stress_score = int(stress_score)

    supabase.table("daily_health").upsert({
        "athlete_id": ATHLETE_UUID,
        "date": date_str,
        "source_platform": "garmin",
        "resting_hr": int(resting_hr) if resting_hr is not None else None,
        "hrv_rmssd": None,     # GarminDB HRV RMSSD availability is device-specific; NULL until confirmed
        "hrv_status": None,    # same
        "sleep_total_min": sleep_total_min,
        "sleep_deep_min": sleep_deep_min,
        "sleep_light_min": sleep_light_min,
        "sleep_rem_min": sleep_rem_min,
        "sleep_awake_min": sleep_awake_min,
        "weight_kg": float(weight_kg) if weight_kg is not None else None,
        "spo2_pct": float(spo2) if spo2 is not None else None,
        "stress_score": stress_score,
    }, on_conflict="athlete_id,date").execute()


# ── Private helpers ────────────────────────────────────────────────────────────

def _query_scalar(conn, sql: str, params: tuple):
    """Execute a scalar query; return the first column of the first row or None."""
    try:
        cur = conn.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row else None
    except Exception:
        return None


def _query_row(conn, sql: str, params: tuple) -> dict | None:
    """Execute a query; return the first row as a dict or None."""
    try:
        cur = conn.execute(sql, params)
        cur.row_factory = None
        row = cur.fetchone()
        if row is None:
            return None
        cols = [d[0] for d in cur.description]
        return dict(zip(cols, row))
    except Exception:
        return None


def _minutes(row: dict, col: str) -> int | None:
    """Return integer minutes from a row column; None if absent or zero."""
    val = row.get(col)
    if val is None:
        return None
    minutes = int(val)
    return minutes if minutes > 0 else None
