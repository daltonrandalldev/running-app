#!/usr/bin/env python3
"""
garmin_sync.py
==============

Reads activity, daily summary, and sleep data from the local GarminDB
SQLite databases (~/HealthData/DBs/) and upserts it into the Supabase
garmin_ tables.

Run this after garmin_download.py has populated the local SQLite files.

Requirements
------------
    pip install garmindb psycopg2-binary python-dotenv

Usage
-----
    python3 garmin_sync.py              # sync all data
    python3 garmin_sync.py --days 30    # sync only the last N days

What gets synced
----------------
    garmin_activities      ← GarminDB activities + steps_activities / cycle_activities
    garmin_activity_laps   ← GarminDB activity_laps (per-lap HR, pace, cadence, zone times)
    garmin_daily_summary   ← GarminDB daily_summary
    garmin_sleep           ← GarminDB sleep

Not synced (by design)
----------------------
    activity_records — per-second GPS/HR stream. At 500 activities this would be
    ~700K rows / ~150 MB in Postgres. Skipped until time-series charts or route
    maps are needed. Source data is always available in the local SQLite.
"""

import argparse
import datetime
import logging
import os
import sys
from pathlib import Path
from typing import Optional

# ── Dependency checks ────────────────────────────────────────────────────────
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("Missing dependency — run: pip install psycopg2-binary")

try:
    from dotenv import load_dotenv
except ImportError:
    sys.exit("Missing dependency — run: pip install python-dotenv")

try:
    from garmindb.garmindb import (
        ActivitiesDb,
        Activities,
        ActivityLaps,
        StepsActivities,
        CycleActivities,
        GarminDb,
        DailySummary,
        Sleep,
    )
    from garmindb.garmin_connect_config_manager import GarminConnectConfigManager
except ImportError:
    sys.exit("Missing dependency — run: pip install garmindb")

from sync.garmin_adapter import get_local_timezone, upsert_daily_health

# ── Suppress noisy urllib3 SSL warning ───────────────────────────────────────
import warnings
import urllib3
warnings.filterwarnings("ignore", category=urllib3.exceptions.NotOpenSSLWarning)

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _time_to_seconds(t) -> Optional[int]:
    """Convert a datetime.time duration to total seconds. Returns None for zero/None."""
    if t is None:
        return None
    total = t.hour * 3600 + t.minute * 60 + t.second
    return total if total > 0 else None


def _pace_to_seconds(t) -> Optional[int]:
    """
    Convert a pace stored as datetime.time (min:sec per km) to seconds per km.
    GarminDB stores pace as a time object where hour=0, minute=min/km, second=sec.
    """
    if t is None:
        return None
    total = t.minute * 60 + t.second
    return total if total > 0 else None


def _f(val):
    """Return float or None."""
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _i(val):
    """Return int or None."""
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


# ── Sync: activities ──────────────────────────────────────────────────────────

def _build_activity_row(act, steps: Optional[object], cycle: Optional[object]) -> dict:
    """Merge a GarminDB Activities row (+ optional sport subrow) into a flat dict."""
    row = {
        "activity_id":              str(act.activity_id),
        "name":                     act.name,
        "description":              act.description,
        "sport":                    act.sport,
        "sub_sport":                act.sub_sport,
        "start_time":               act.start_time.isoformat() if act.start_time else None,
        "stop_time":                act.stop_time.isoformat() if act.stop_time else None,
        "elapsed_time_seconds":     _time_to_seconds(act.elapsed_time),
        "moving_time_seconds":      _time_to_seconds(act.moving_time),
        "distance":                 _f(act.distance),
        "avg_speed":                _f(act.avg_speed),
        "max_speed":                _f(act.max_speed),
        "avg_hr":                   _i(act.avg_hr),
        "max_hr":                   _i(act.max_hr),
        "calories":                 _i(act.calories),
        "avg_cadence":              _i(act.avg_cadence),
        "max_cadence":              _i(act.max_cadence),
        "ascent":                   _f(act.ascent),
        "descent":                  _f(act.descent),
        "avg_temperature":          _f(act.avg_temperature),
        "min_temperature":          _f(act.min_temperature),
        "max_temperature":          _f(act.max_temperature),
        "start_lat":                _f(act.start_lat),
        "start_long":               _f(act.start_long),
        "stop_lat":                 _f(act.stop_lat),
        "stop_long":                _f(act.stop_long),
        "local_timezone":           get_local_timezone(_f(act.start_lat), _f(act.start_long)),
        "training_load":            _f(act.training_load),
        "training_effect":          _f(act.training_effect),
        "anaerobic_training_effect": _f(act.anaerobic_training_effect),
        "hrz_1_seconds":            _time_to_seconds(act.hrz_1_time),
        "hrz_2_seconds":            _time_to_seconds(act.hrz_2_time),
        "hrz_3_seconds":            _time_to_seconds(act.hrz_3_time),
        "hrz_4_seconds":            _time_to_seconds(act.hrz_4_time),
        "hrz_5_seconds":            _time_to_seconds(act.hrz_5_time),
        "avg_rr":                   _f(act.avg_rr),
        "max_rr":                   _f(act.max_rr),
        # sport-specific fields default to None
        "vo2_max":                  None,
        "steps":                    None,
        "avg_pace_seconds":         None,
        "avg_moving_pace_seconds":  None,
        "max_pace_seconds":         None,
        "avg_steps_per_min":        None,
        "max_steps_per_min":        None,
        "avg_step_length":          None,
        "avg_vertical_ratio":       None,
        "avg_vertical_oscillation": None,
        "avg_gct_balance":          None,
        "avg_ground_contact_time_ms": None,
        "avg_stance_time_percent":  None,
    }

    if steps is not None:
        row["vo2_max"]                    = _f(steps.vo2_max)
        row["steps"]                      = _i(steps.steps)
        row["avg_pace_seconds"]           = _pace_to_seconds(steps.avg_pace)
        row["avg_moving_pace_seconds"]    = _pace_to_seconds(steps.avg_moving_pace)
        row["max_pace_seconds"]           = _pace_to_seconds(steps.max_pace)
        row["avg_steps_per_min"]          = _i(steps.avg_steps_per_min)
        row["max_steps_per_min"]          = _i(steps.max_steps_per_min)
        row["avg_step_length"]            = _f(steps.avg_step_length)
        row["avg_vertical_ratio"]         = _f(steps.avg_vertical_ratio)
        row["avg_vertical_oscillation"]   = _f(steps.avg_vertical_oscillation)
        row["avg_gct_balance"]            = _f(steps.avg_gct_balance)
        _gct_sec = _time_to_seconds(steps.avg_ground_contact_time)
        row["avg_ground_contact_time_ms"] = _gct_sec * 1000 if _gct_sec is not None else None
        row["avg_stance_time_percent"]    = _f(steps.avg_stance_time_percent)

    if cycle is not None:
        row["vo2_max"] = _f(cycle.vo2_max)

    return row


def sync_activities(
    act_db: ActivitiesDb,
    cur,
    since: Optional[datetime.datetime],
) -> int:
    """Upsert garmin_activities. Returns count of rows upserted."""

    with act_db.managed_session() as session:
        query = session.query(Activities)
        if since:
            query = query.filter(Activities.start_time >= since)
        all_acts = query.order_by(Activities.start_time).all()

        if not all_acts:
            return 0

        rows = []
        for act in all_acts:
            steps = session.query(StepsActivities).filter(
                StepsActivities.activity_id == act.activity_id
            ).one_or_none()

            cycle = session.query(CycleActivities).filter(
                CycleActivities.activity_id == act.activity_id
            ).one_or_none()

            rows.append(_build_activity_row(act, steps, cycle))

    columns = list(rows[0].keys())
    placeholders = ", ".join([f"%({c})s" for c in columns])
    col_list = ", ".join(columns)
    update_set = ", ".join(
        [f"{c} = EXCLUDED.{c}" for c in columns if c != "activity_id"]
    )

    sql = f"""
        INSERT INTO garmin_activities ({col_list}, synced_at)
        VALUES ({placeholders}, now())
        ON CONFLICT (activity_id) DO UPDATE SET
            {update_set},
            synced_at = now()
    """

    for row in rows:
        cur.execute(sql, row)

    return len(rows)


# ── Sync: activity laps ──────────────────────────────────────────────────────

def sync_activity_laps(
    act_db: ActivitiesDb,
    cur,
    since: Optional[datetime.datetime],
) -> int:
    """Upsert garmin_activity_laps. Returns count of rows upserted."""

    with act_db.managed_session() as session:
        if since:
            # Join through Activities to filter by start_time
            laps_raw = (
                session.query(ActivityLaps)
                .join(Activities, ActivityLaps.activity_id == Activities.activity_id)
                .filter(Activities.start_time >= since)
                .all()
            )
        else:
            laps_raw = session.query(ActivityLaps).all()

    if not laps_raw:
        return 0

    rows = []
    for lap in laps_raw:
        rows.append({
            "activity_id":          str(lap.activity_id),
            "lap":                  lap.lap,
            "start_time":           lap.start_time.isoformat() if lap.start_time else None,
            "stop_time":            lap.stop_time.isoformat() if lap.stop_time else None,
            "elapsed_time_seconds": _time_to_seconds(lap.elapsed_time),
            "moving_time_seconds":  _time_to_seconds(lap.moving_time),
            "distance":             _f(lap.distance),
            "cycles":               _f(lap.cycles),
            "avg_hr":               _i(lap.avg_hr),
            "max_hr":               _i(lap.max_hr),
            "calories":             _i(lap.calories),
            "avg_cadence":          _i(lap.avg_cadence),
            "max_cadence":          _i(lap.max_cadence),
            "ascent":               _f(lap.ascent),
            "descent":              _f(lap.descent),
            "avg_temperature":      _f(lap.avg_temperature),
            "min_temperature":      _f(lap.min_temperature),
            "max_temperature":      _f(lap.max_temperature),
            "avg_speed":            _f(lap.avg_speed),
            "max_speed":            _f(lap.max_speed),
            "avg_rr":               _f(lap.avg_rr),
            "max_rr":               _f(lap.max_rr),
            "start_lat":            _f(lap.start_lat),
            "start_long":           _f(lap.start_long),
            "stop_lat":             _f(lap.stop_lat),
            "stop_long":            _f(lap.stop_long),
            "hr_zones_method":      str(lap.hr_zones_method) if lap.hr_zones_method else None,
            "hrz_1_hr":             _i(lap.hrz_1_hr),
            "hrz_2_hr":             _i(lap.hrz_2_hr),
            "hrz_3_hr":             _i(lap.hrz_3_hr),
            "hrz_4_hr":             _i(lap.hrz_4_hr),
            "hrz_5_hr":             _i(lap.hrz_5_hr),
            "hrz_1_seconds":        _time_to_seconds(lap.hrz_1_time),
            "hrz_2_seconds":        _time_to_seconds(lap.hrz_2_time),
            "hrz_3_seconds":        _time_to_seconds(lap.hrz_3_time),
            "hrz_4_seconds":        _time_to_seconds(lap.hrz_4_time),
            "hrz_5_seconds":        _time_to_seconds(lap.hrz_5_time),
        })

    sql = """
        INSERT INTO garmin_activity_laps (
            activity_id, lap, start_time, stop_time,
            elapsed_time_seconds, moving_time_seconds,
            distance, cycles, avg_hr, max_hr, calories,
            avg_cadence, max_cadence, ascent, descent,
            avg_temperature, min_temperature, max_temperature,
            avg_speed, max_speed, avg_rr, max_rr,
            start_lat, start_long, stop_lat, stop_long,
            hr_zones_method,
            hrz_1_hr, hrz_2_hr, hrz_3_hr, hrz_4_hr, hrz_5_hr,
            hrz_1_seconds, hrz_2_seconds, hrz_3_seconds, hrz_4_seconds, hrz_5_seconds,
            synced_at
        ) VALUES (
            %(activity_id)s, %(lap)s, %(start_time)s, %(stop_time)s,
            %(elapsed_time_seconds)s, %(moving_time_seconds)s,
            %(distance)s, %(cycles)s, %(avg_hr)s, %(max_hr)s, %(calories)s,
            %(avg_cadence)s, %(max_cadence)s, %(ascent)s, %(descent)s,
            %(avg_temperature)s, %(min_temperature)s, %(max_temperature)s,
            %(avg_speed)s, %(max_speed)s, %(avg_rr)s, %(max_rr)s,
            %(start_lat)s, %(start_long)s, %(stop_lat)s, %(stop_long)s,
            %(hr_zones_method)s,
            %(hrz_1_hr)s, %(hrz_2_hr)s, %(hrz_3_hr)s, %(hrz_4_hr)s, %(hrz_5_hr)s,
            %(hrz_1_seconds)s, %(hrz_2_seconds)s, %(hrz_3_seconds)s,
            %(hrz_4_seconds)s, %(hrz_5_seconds)s,
            now()
        )
        ON CONFLICT (activity_id, lap) DO UPDATE SET
            start_time = EXCLUDED.start_time,
            stop_time = EXCLUDED.stop_time,
            elapsed_time_seconds = EXCLUDED.elapsed_time_seconds,
            moving_time_seconds = EXCLUDED.moving_time_seconds,
            distance = EXCLUDED.distance,
            cycles = EXCLUDED.cycles,
            avg_hr = EXCLUDED.avg_hr,
            max_hr = EXCLUDED.max_hr,
            calories = EXCLUDED.calories,
            avg_cadence = EXCLUDED.avg_cadence,
            max_cadence = EXCLUDED.max_cadence,
            ascent = EXCLUDED.ascent,
            descent = EXCLUDED.descent,
            avg_temperature = EXCLUDED.avg_temperature,
            min_temperature = EXCLUDED.min_temperature,
            max_temperature = EXCLUDED.max_temperature,
            avg_speed = EXCLUDED.avg_speed,
            max_speed = EXCLUDED.max_speed,
            avg_rr = EXCLUDED.avg_rr,
            max_rr = EXCLUDED.max_rr,
            start_lat = EXCLUDED.start_lat,
            start_long = EXCLUDED.start_long,
            stop_lat = EXCLUDED.stop_lat,
            stop_long = EXCLUDED.stop_long,
            hr_zones_method = EXCLUDED.hr_zones_method,
            hrz_1_hr = EXCLUDED.hrz_1_hr,
            hrz_2_hr = EXCLUDED.hrz_2_hr,
            hrz_3_hr = EXCLUDED.hrz_3_hr,
            hrz_4_hr = EXCLUDED.hrz_4_hr,
            hrz_5_hr = EXCLUDED.hrz_5_hr,
            hrz_1_seconds = EXCLUDED.hrz_1_seconds,
            hrz_2_seconds = EXCLUDED.hrz_2_seconds,
            hrz_3_seconds = EXCLUDED.hrz_3_seconds,
            hrz_4_seconds = EXCLUDED.hrz_4_seconds,
            hrz_5_seconds = EXCLUDED.hrz_5_seconds,
            synced_at = now()
    """

    for row in rows:
        cur.execute(sql, row)

    return len(rows)


# ── Sync: daily summary ───────────────────────────────────────────────────────

def sync_daily_summary(
    garmin_db: GarminDb,
    cur,
    since: Optional[datetime.date],
) -> int:
    """Upsert garmin_daily_summary. Returns count of rows upserted."""

    with garmin_db.managed_session() as session:
        query = session.query(DailySummary)
        if since:
            query = query.filter(DailySummary.day >= since)
        rows_raw = query.order_by(DailySummary.day).all()

    if not rows_raw:
        return 0

    rows = []
    for d in rows_raw:
        rows.append({
            "day":                       d.day.isoformat(),
            "hr_min":                    _i(d.hr_min),
            "hr_max":                    _i(d.hr_max),
            "rhr":                       _i(d.rhr),
            "stress_avg":                _i(d.stress_avg),
            "step_goal":                 _i(d.step_goal),
            "steps":                     _i(d.steps),
            "distance":                  _f(d.distance),
            "floors_up":                 _f(d.floors_up),
            "floors_down":               _f(d.floors_down),
            "calories_total":            _i(d.calories_total),
            "calories_active":           _i(d.calories_active),
            "calories_bmr":              _i(d.calories_bmr),
            "calories_goal":             _i(d.calories_goal),
            "moderate_activity_seconds": _time_to_seconds(d.moderate_activity_time),
            "vigorous_activity_seconds": _time_to_seconds(d.vigorous_activity_time),
            "spo2_avg":                  _f(d.spo2_avg),
            "spo2_min":                  _f(d.spo2_min),
            "rr_waking_avg":             _f(d.rr_waking_avg),
            "rr_max":                    _f(d.rr_max),
            "rr_min":                    _f(d.rr_min),
            "bb_max":                    _i(d.bb_max),
            "bb_min":                    _i(d.bb_min),
        })

    sql = """
        INSERT INTO garmin_daily_summary (
            day, hr_min, hr_max, rhr, stress_avg, step_goal, steps, distance,
            floors_up, floors_down, calories_total, calories_active, calories_bmr,
            calories_goal, moderate_activity_seconds, vigorous_activity_seconds,
            spo2_avg, spo2_min, rr_waking_avg, rr_max, rr_min, bb_max, bb_min,
            synced_at
        ) VALUES (
            %(day)s, %(hr_min)s, %(hr_max)s, %(rhr)s, %(stress_avg)s,
            %(step_goal)s, %(steps)s, %(distance)s, %(floors_up)s, %(floors_down)s,
            %(calories_total)s, %(calories_active)s, %(calories_bmr)s,
            %(calories_goal)s, %(moderate_activity_seconds)s,
            %(vigorous_activity_seconds)s, %(spo2_avg)s, %(spo2_min)s,
            %(rr_waking_avg)s, %(rr_max)s, %(rr_min)s, %(bb_max)s, %(bb_min)s,
            now()
        )
        ON CONFLICT (day) DO UPDATE SET
            hr_min = EXCLUDED.hr_min,
            hr_max = EXCLUDED.hr_max,
            rhr = EXCLUDED.rhr,
            stress_avg = EXCLUDED.stress_avg,
            step_goal = EXCLUDED.step_goal,
            steps = EXCLUDED.steps,
            distance = EXCLUDED.distance,
            floors_up = EXCLUDED.floors_up,
            floors_down = EXCLUDED.floors_down,
            calories_total = EXCLUDED.calories_total,
            calories_active = EXCLUDED.calories_active,
            calories_bmr = EXCLUDED.calories_bmr,
            calories_goal = EXCLUDED.calories_goal,
            moderate_activity_seconds = EXCLUDED.moderate_activity_seconds,
            vigorous_activity_seconds = EXCLUDED.vigorous_activity_seconds,
            spo2_avg = EXCLUDED.spo2_avg,
            spo2_min = EXCLUDED.spo2_min,
            rr_waking_avg = EXCLUDED.rr_waking_avg,
            rr_max = EXCLUDED.rr_max,
            rr_min = EXCLUDED.rr_min,
            bb_max = EXCLUDED.bb_max,
            bb_min = EXCLUDED.bb_min,
            synced_at = now()
    """

    for row in rows:
        cur.execute(sql, row)

    return len(rows)


# ── Sync: sleep ───────────────────────────────────────────────────────────────

def sync_sleep(
    garmin_db: GarminDb,
    cur,
    since: Optional[datetime.date],
) -> int:
    """Upsert garmin_sleep. Returns count of rows upserted."""

    with garmin_db.managed_session() as session:
        query = session.query(Sleep)
        if since:
            query = query.filter(Sleep.day >= since)
        rows_raw = query.order_by(Sleep.day).all()

    if not rows_raw:
        return 0

    rows = []
    for s in rows_raw:
        rows.append({
            "day":                  s.day.isoformat(),
            "start_time":           s.start.isoformat() if s.start else None,
            "end_time":             s.end.isoformat() if s.end else None,
            "total_sleep_seconds":  _time_to_seconds(s.total_sleep),
            "deep_sleep_seconds":   _time_to_seconds(s.deep_sleep),
            "light_sleep_seconds":  _time_to_seconds(s.light_sleep),
            "rem_sleep_seconds":    _time_to_seconds(s.rem_sleep),
            "awake_seconds":        _time_to_seconds(s.awake),
            "avg_spo2":             _f(s.avg_spo2),
            "avg_rr":               _f(s.avg_rr),
            "avg_stress":           _f(s.avg_stress),
            "score":                _i(s.score),
            "qualifier":            s.qualifier,
        })

    sql = """
        INSERT INTO garmin_sleep (
            day, start_time, end_time,
            total_sleep_seconds, deep_sleep_seconds, light_sleep_seconds,
            rem_sleep_seconds, awake_seconds,
            avg_spo2, avg_rr, avg_stress, score, qualifier,
            synced_at
        ) VALUES (
            %(day)s, %(start_time)s, %(end_time)s,
            %(total_sleep_seconds)s, %(deep_sleep_seconds)s, %(light_sleep_seconds)s,
            %(rem_sleep_seconds)s, %(awake_seconds)s,
            %(avg_spo2)s, %(avg_rr)s, %(avg_stress)s, %(score)s, %(qualifier)s,
            now()
        )
        ON CONFLICT (day) DO UPDATE SET
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            total_sleep_seconds = EXCLUDED.total_sleep_seconds,
            deep_sleep_seconds = EXCLUDED.deep_sleep_seconds,
            light_sleep_seconds = EXCLUDED.light_sleep_seconds,
            rem_sleep_seconds = EXCLUDED.rem_sleep_seconds,
            awake_seconds = EXCLUDED.awake_seconds,
            avg_spo2 = EXCLUDED.avg_spo2,
            avg_rr = EXCLUDED.avg_rr,
            avg_stress = EXCLUDED.avg_stress,
            score = EXCLUDED.score,
            qualifier = EXCLUDED.qualifier,
            synced_at = now()
    """

    for row in rows:
        cur.execute(sql, row)

    return len(rows)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sync GarminDB SQLite → Supabase garmin_ tables")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Force a full sync of all data, ignoring the latest-date watermark",
    )
    args = parser.parse_args()

    # ── Load .env ─────────────────────────────────────────────────────────────
    script_dir = Path(__file__).parent
    load_dotenv(script_dir / ".env")

    db_url = os.getenv("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("SUPABASE_DB_URL not set in .env")

    # ── Locate GarminDB SQLite files ──────────────────────────────────────────
    try:
        gc_config = GarminConnectConfigManager()
    except SystemExit:
        sys.exit(
            "GarminDB config not found. Run first:\n"
            "    python3 garmin_setup.py\n"
            "    python3 garmin_download.py"
        )

    db_params = gc_config.get_db_params()
    db_dir = gc_config.get_db_dir()
    logger.info("GarminDB SQLite directory: %s", db_dir)

    # ── Verify SQLite files exist ─────────────────────────────────────────────
    garmin_db_path = Path(db_dir) / "garmin.db"
    activities_db_path = Path(db_dir) / "garmin_activities.db"

    if not garmin_db_path.exists():
        sys.exit(
            f"SQLite file not found: {garmin_db_path}\n"
            "Run garmin_download.py first to populate the local database."
        )
    if not activities_db_path.exists():
        sys.exit(
            f"SQLite file not found: {activities_db_path}\n"
            "Run garmin_download.py first to populate the local database."
        )

    # ── Open GarminDB sessions ────────────────────────────────────────────────
    garmin_db = GarminDb(db_params)
    act_db = ActivitiesDb(db_params)

    # ── Connect to Supabase ───────────────────────────────────────────────────
    logger.info("Connecting to Supabase…")
    conn = psycopg2.connect(db_url)

    # ── Determine since watermarks from what's already in Supabase ───────────
    since_dt: Optional[datetime.datetime] = None
    since_date: Optional[datetime.date] = None

    if args.all:
        logger.info("--all flag set: syncing all data")
    else:
        with conn.cursor() as cur:
            cur.execute("SELECT MAX(start_time) FROM garmin_activities")
            row = cur.fetchone()
            latest_activity = row[0] if row and row[0] else None

        if latest_activity is not None:
            # Strip timezone info for comparison with naive SQLite datetimes
            since_dt = latest_activity.replace(tzinfo=None)
            since_date = since_dt.date()
            logger.info("Latest activity in Supabase: %s — syncing from that date onward", since_dt)
        else:
            logger.info("No existing data in Supabase — syncing all data")

    total_activities = total_laps = total_summaries = total_sleep = total_health = 0

    try:
        with conn:
            with conn.cursor() as cur:

                # ── Activities ────────────────────────────────────────────────
                logger.info("Syncing garmin_activities…")
                total_activities = sync_activities(act_db, cur, since_dt)
                logger.info("  ✓ %d activities upserted", total_activities)

                # ── Laps (must follow activities — FK constraint) ─────────────
                logger.info("Syncing garmin_activity_laps…")
                total_laps = sync_activity_laps(act_db, cur, since_dt)
                logger.info("  ✓ %d laps upserted", total_laps)

                # ── Daily summaries ───────────────────────────────────────────
                logger.info("Syncing garmin_daily_summary…")
                total_summaries = sync_daily_summary(garmin_db, cur, since_date)
                logger.info("  ✓ %d daily summaries upserted", total_summaries)

                # ── Sleep ─────────────────────────────────────────────────────
                logger.info("Syncing garmin_sleep…")
                total_sleep = sync_sleep(garmin_db, cur, since_date)
                logger.info("  ✓ %d sleep records upserted", total_sleep)

                # ── Notify PostgREST ──────────────────────────────────────────
                cur.execute("NOTIFY pgrst, 'reload schema'")

        # ── daily_health upsert (uses Supabase client, outside psycopg2 tx) ───
        logger.info("Syncing daily_health from GarminDB monitoring tables…")
        total_health = upsert_daily_health(garmin_db, since_date)
        logger.info("  ✓ %d daily_health rows upserted", total_health)

        logger.info("")
        logger.info("── Sync complete ────────────────────────────────────────")
        logger.info("  Activities:      %d", total_activities)
        logger.info("  Laps:            %d", total_laps)
        logger.info("  Daily summaries: %d", total_summaries)
        logger.info("  Sleep records:   %d", total_sleep)
        logger.info("  Daily health:    %d", total_health)

    except Exception as exc:
        logger.error("Sync failed — transaction rolled back")
        logger.error("  %s: %s", type(exc).__name__, exc)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
