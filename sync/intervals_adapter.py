"""
intervals_adapter.py
====================

Fetches activities and wellness data from the Intervals.icu API and upserts
them into Supabase.

ING-002: Activity Sync
ING-003: Wellness Sync
"""

import os
from datetime import date, timedelta, datetime
from zoneinfo import ZoneInfo

import requests
from requests.auth import HTTPBasicAuth
from supabase import create_client, Client

INTERVALS_BASE = "https://intervals.icu/api/v1"

ATHLETE_UUID = "00000000-0000-0000-0000-000000000001"  # placeholder until auth


# ── Credentials & client helpers ──────────────────────────────────────────────

def _get_credentials():
    """Returns (athlete_id, api_key) or raises ValueError if missing."""
    athlete_id = os.environ.get("INTERVALS_ICU_ATHLETE_ID")
    api_key = os.environ.get("INTERVALS_ICU_API_KEY")
    if not athlete_id or not api_key:
        raise ValueError("Missing Intervals.icu credentials")
    return athlete_id, api_key


def _get_supabase() -> Client:
    url = os.environ["EXPO_PUBLIC_SUPABASE_URL"]
    key = os.environ["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    return create_client(url, key)


def _default_oldest() -> str:
    return (date.today() - timedelta(days=365)).isoformat()


def _today_iso() -> str:
    return date.today().isoformat()


# ── HTTP helper ────────────────────────────────────────────────────────────────

def _get(path: str, params: dict = None):
    athlete_id, api_key = _get_credentials()
    url = f"{INTERVALS_BASE}/athlete/{athlete_id}/{path}"
    auth = HTTPBasicAuth("API_KEY", api_key)
    r = requests.get(url, auth=auth, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


# ── ING-002: Activity Sync ─────────────────────────────────────────────────────

def fetch_activities(oldest_date: str, newest_date: str) -> list[dict]:
    params = {"oldest": oldest_date, "newest": newest_date, "limit": 200}
    data = _get("activities", params=params)
    return data if isinstance(data, list) else []


def already_ingested(intervals_activity_id: str, supabase: Client) -> bool:
    external_id = f"icu_{intervals_activity_id}"
    result = (
        supabase.table("activity_sources")
        .select("id")
        .eq("source_platform", "intervals_icu")
        .eq("external_id", external_id)
        .limit(1)
        .execute()
    )
    return len(result.data) > 0


def find_duplicate(sport_type: str, start_time_utc: str, supabase: Client):
    from dateutil import parser as dtparser
    dt = dtparser.parse(start_time_utc)
    minus5 = (dt - timedelta(minutes=5)).isoformat()
    plus5  = (dt + timedelta(minutes=5)).isoformat()
    result = (
        supabase.table("garmin_activities")
        .select("activity_id")
        .eq("sport", sport_type)
        .gte("start_time", minus5)
        .lte("start_time", plus5)
        .limit(1)
        .execute()
    )
    rows = result.data
    return rows[0]["activity_id"] if rows else None


def _to_int(v):
    """Cast float to int for integer DB columns; pass through None."""
    return int(v) if v is not None else None


def _to_utc(start_date_local: str, tz: str) -> str:
    """Convert a local datetime string + IANA tz to UTC ISO string."""
    try:
        dt_local = datetime.fromisoformat(start_date_local)
        tz_obj = ZoneInfo(tz)
        dt_aware = dt_local.replace(tzinfo=tz_obj)
        return dt_aware.astimezone(ZoneInfo("UTC")).isoformat()
    except Exception:
        return start_date_local  # fallback: return as-is if conversion fails


def upsert_activities(activities: list[dict]) -> dict:
    supabase = _get_supabase()
    count = 0
    for act in activities:
        icu_id = str(act.get("id", ""))

        # Stage 1: idempotency guard
        if already_ingested(icu_id, supabase):
            continue

        sport_type = act.get("type", "Unknown")
        tz = act.get("tz", "UTC")
        start_local = act.get("start_date_local", "")
        start_utc = _to_utc(start_local, tz)

        # Stage 2: cross-source duplicate detection
        canonical_id = find_duplicate(sport_type, start_utc, supabase)

        latlng = act.get("start_latlng") or []
        start_lat = latlng[0] if len(latlng) >= 2 else None
        start_long = latlng[1] if len(latlng) >= 2 else None

        # Normalise units to match GarminDB convention (km, kph)
        raw_dist_m = act.get("distance")
        distance_km = raw_dist_m / 1000.0 if raw_dist_m is not None else None

        raw_speed_ms = act.get("average_speed")
        avg_speed_kph = raw_speed_ms * 3.6 if raw_speed_ms is not None else None

        if canonical_id:
            # Duplicate path: fill in normalized_power and local_timezone ONLY if
            # the existing GarminDB row has NULL values for those fields.
            existing_row = (
                supabase.table("garmin_activities")
                .select("normalized_power, local_timezone")
                .eq("activity_id", canonical_id)
                .limit(1)
                .execute()
            ).data
            updates = {}
            if existing_row:
                if existing_row[0].get("normalized_power") is None and act.get("normalized_power") is not None:
                    updates["normalized_power"] = act["normalized_power"]
                if existing_row[0].get("local_timezone") is None and tz:
                    updates["local_timezone"] = tz
            if updates:
                supabase.table("garmin_activities").update(updates).eq("activity_id", canonical_id).execute()

            # Record in activity_sources with is_preferred=False
            supabase.table("activity_sources").upsert({
                "canonical_activity_id": canonical_id,
                "source_platform": "intervals_icu",
                "external_id": f"icu_{icu_id}",
                "start_time": start_utc,
                "sport_type": sport_type,
                "is_preferred": False,
            }, on_conflict="source_platform,external_id").execute()
        else:
            # New activity path
            new_id = f"icu_{icu_id}"
            supabase.table("garmin_activities").upsert({
                "activity_id": new_id,
                "source_platform": "intervals_icu",
                "sport": sport_type,
                "start_time": start_utc,
                "local_timezone": tz,
                "distance": distance_km,
                "moving_time_seconds": _to_int(act.get("moving_time")),
                "elapsed_time_seconds": _to_int(act.get("elapsed_time")),
                "ascent": _to_int(act.get("total_elevation_gain")),
                "descent": _to_int(act.get("total_elevation_loss")),
                "avg_hr": _to_int(act.get("average_heartrate")),
                "max_hr": _to_int(act.get("max_heartrate")),
                "avg_speed": avg_speed_kph,
                "avg_cadence": _to_int(act.get("average_cadence")),
                "normalized_power": act.get("normalized_power"),
                "training_load": act.get("icu_training_load"),
                "start_lat": start_lat,
                "start_long": start_long,
            }, on_conflict="activity_id").execute()

            supabase.table("activity_sources").upsert({
                "canonical_activity_id": new_id,
                "source_platform": "intervals_icu",
                "external_id": new_id,
                "start_time": start_utc,
                "sport_type": sport_type,
                "is_preferred": True,
            }, on_conflict="source_platform,external_id").execute()
            count += 1

    return {"count": count}


# ── ING-003: Wellness Sync ─────────────────────────────────────────────────────

def fetch_wellness(oldest_date: str, newest_date: str) -> list[dict]:
    params = {"oldest": oldest_date, "newest": newest_date}
    data = _get("wellness", params=params)
    return data if isinstance(data, list) else []


def upsert_wellness(wellness: list[dict]) -> dict:
    supabase = _get_supabase()
    count = 0
    for day in wellness:
        existing = (
            supabase.table("daily_health")
            .select("source_platform")
            .eq("athlete_id", ATHLETE_UUID)
            .eq("date", day["id"])
            .limit(1)
            .execute()
        )
        existing_rows = existing.data
        platform = "merged" if existing_rows and existing_rows[0]["source_platform"] == "garmin" else "intervals_icu"

        hrv_status_raw = day.get("hrvScore")
        hrv_status = hrv_status_raw if hrv_status_raw is not None and 1 <= hrv_status_raw <= 5 else None

        sleep_secs = day.get("sleepSecs")
        sleep_total_min = int(sleep_secs / 60) if sleep_secs is not None else None

        supabase.table("daily_health").upsert({
            "athlete_id": ATHLETE_UUID,
            "date": day["id"],
            "resting_hr": day.get("restingHR"),
            "hrv_rmssd": day.get("hrv"),
            "hrv_status": hrv_status,
            "sleep_total_min": sleep_total_min,
            "weight_kg": day.get("weight"),
            "spo2_pct": day.get("spO2"),
            "source_platform": platform,
        }, on_conflict="athlete_id,date").execute()
        count += 1
    return {"count": count}
