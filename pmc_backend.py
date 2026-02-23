#!/usr/bin/env python3
"""
pmc_backend.py
==============

Reads activity data from Supabase Postgres, computes per-activity training
load scores (TRIMP, pace load), persists them, then builds and persists daily
PMC values (CTL / ATL / TSB).

  Idempotent  — safe to re-run; always recomputes from scratch.
  Transactional — a single BEGIN/COMMIT wraps all writes; any error triggers a
                  full ROLLBACK so the DB is never left in a partial state.

Requirements
------------
    pip install psycopg2-binary python-dotenv

.env — add alongside your existing Supabase keys
-------------------------------------------------------
    SUPABASE_DB_URL=postgresql://postgres:<password>@db.alplxcjrxpkpoizfdjda.supabase.co:5432/postgres

    Find the password:
      Supabase Dashboard → Settings → Database → Connection string (URI tab)
      Copy the URI and replace [YOUR-PASSWORD] with your actual password.

Schema changes (auto-applied on first run via IF NOT EXISTS)
------------------------------------------------------------
    garmin_activities — adds columns: trimp, hr_tss, pace_load_flat, pace_load_gap, active_load
    pmc_daily         — new table: date, daily_load, ctl, atl, tsb, updated_at

Active load priority
--------------------
    Running + elevation available  → pace_load_gap
    Running + no elevation         → pace_load_flat
    Non-running with HR            → trimp
    Otherwise                      → NULL
"""

import math
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

# ── Dependency checks ──────────────────────────────────────────────────────────
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit(
        "Missing dependency — run:\n"
        "    pip install psycopg2-binary python-dotenv"
    )

try:
    from dotenv import load_dotenv
except ImportError:
    sys.exit(
        "Missing dependency — run:\n"
        "    pip install psycopg2-binary python-dotenv"
    )

# ─── CONFIGURATION ────────────────────────────────────────────────────────────

CONFIG = {
    "max_hr"         : 190,   # REQUIRED — your maximum heart rate
    "resting_hr"     : 42,    # None = fallback to 55 bpm
    "lthr"           : 168,  # Lactate Threshold HR (bpm) — match the value set in the app
                               # None = hr_tss will be NULL for all activities
    "reference_vdot" : 60,  # None = read latest vdot from race_entries table
    "ctl_tc"         : 42,    # Fitness time constant (days)
    "atl_tc"         : 7,     # Fatigue time constant (days)
}

# ─── SCHEMA MIGRATIONS (idempotent DDL) ───────────────────────────────────────

MIGRATIONS = [
    "ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS trimp          DOUBLE PRECISION",
    "ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS pace_load_flat DOUBLE PRECISION",
    "ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS pace_load_gap  DOUBLE PRECISION",
    "ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS active_load    DOUBLE PRECISION",
    "ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS hr_tss         DOUBLE PRECISION",
    """
    CREATE TABLE IF NOT EXISTS lthr_settings (
        id         INTEGER      PRIMARY KEY DEFAULT 1,
        bpm        DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CHECK (id = 1)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pmc_daily (
        date        DATE             PRIMARY KEY,
        daily_load  DOUBLE PRECISION NOT NULL DEFAULT 0,
        ctl         DOUBLE PRECISION NOT NULL DEFAULT 0,
        atl         DOUBLE PRECISION NOT NULL DEFAULT 0,
        tsb         DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
    )
    """,
    # Grant SELECT to anon + authenticated so the Supabase JS client can read these tables
    "GRANT SELECT ON pmc_daily    TO anon, authenticated",
    "GRANT SELECT ON lthr_settings TO anon, authenticated",
    # Disable RLS — no auth yet, consistent with existing tables in this project
    "ALTER TABLE pmc_daily     DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE lthr_settings DISABLE ROW LEVEL SECURITY",
]

# ─── MATH ─────────────────────────────────────────────────────────────────────

def compute_trimp(
    duration_min: float,
    avg_hr: float,
    resting_hr: float,
    max_hr: float,
) -> float:
    """Banister TRIMP (male coefficient b = 1.92)."""
    if duration_min <= 0 or avg_hr <= 0:
        return 0.0
    hrr = (avg_hr - resting_hr) / (max_hr - resting_hr)
    hrr = max(0.0, min(1.0, hrr))
    return duration_min * hrr * 0.64 * math.exp(1.92 * hrr)


def threshold_pace_from_vdot(vdot: float) -> float:
    """
    Jack Daniels T-pace derived from VDOT.
    Returns threshold pace in min/km.
    """
    t_vo2  = 0.88 * vdot
    disc   = 0.182258 ** 2 + 4 * 0.000104 * (t_vo2 + 4.60)
    v_thresh_m_per_min = (-0.182258 + math.sqrt(disc)) / (2 * 0.000104)
    return 1000.0 / v_thresh_m_per_min  # min/km


def compute_pace_loads(
    distance_km: float,
    duration_min: float,
    elevation_gain_m: Optional[float],
    threshold_pace: float,          # min/km
) -> tuple[Optional[float], Optional[float]]:
    """
    Computes (pace_load_flat, pace_load_gap).

    pace_load = distance_km * intensity_factor²
    where intensity_factor = threshold_pace / effective_pace

    GAP variant adjusts effective pace downward (~10 s/km per 1 % average grade)
    so uphill efforts are fairly penalised.
    """
    if distance_km <= 0 or duration_min <= 0:
        return None, None

    avg_pace = duration_min / distance_km   # min/km

    # Flat load
    if_flat   = threshold_pace / avg_pace
    flat_load = distance_km * if_flat ** 2

    # GAP load (only when elevation is available and positive)
    gap_load: Optional[float] = None
    if elevation_gain_m is not None and elevation_gain_m > 0:
        grade_pct      = (elevation_gain_m / (distance_km * 1000.0)) * 100.0
        gap_adjustment = grade_pct * (10.0 / 60.0)          # convert s → min
        effective_pace = avg_pace - gap_adjustment           # faster equiv. flat pace
        effective_pace = max(effective_pace, avg_pace * 0.5) # clamp: never > 2× effort
        if_gap         = threshold_pace / effective_pace
        gap_load       = distance_km * if_gap ** 2

    return flat_load, gap_load


def compute_hr_tss(
    duration_sec: float,
    avg_hr: float,
    resting_hr: float,
    max_hr: float,
    lthr: float,
) -> Optional[float]:
    """
    HR-based TSS using LTHR as the intensity reference.

    hrr      = clamp((avg_hr  - resting_hr) / (max_hr - resting_hr), 0, 1)
    LTHR_hrr = clamp((LTHR    - resting_hr) / (max_hr - resting_hr), 0, 1)
    hrTSS    = (duration_sec * (hrr / LTHR_hrr)² * 100) / 3600

    Returns None when inputs are invalid or LTHR_hrr is zero.
    """
    if duration_sec <= 0 or avg_hr <= 0:
        return None
    hrr      = max(0.0, min(1.0, (avg_hr - resting_hr) / (max_hr - resting_hr)))
    lthr_hrr = max(0.0, min(1.0, (lthr   - resting_hr) / (max_hr - resting_hr)))
    if lthr_hrr == 0:
        return None
    return (duration_sec * (hrr / lthr_hrr) ** 2 * 100.0) / 3600.0


# ─── GRANULAR TSS FROM GARMIN RECORDS ────────────────────────────────────────
#
# When the local GarminDB SQLite is present, per-record HR data (~3 s intervals)
# is used instead of avg_hr for TRIMP and hrTSS.  This matters because both
# formulas apply a non-linear weighting to HR (exponential for TRIMP, quadratic
# for hrTSS).  f(avg_hr) systematically underestimates load for activities with
# HR variability — interval sessions, trail runs, surges — because high-HR
# spikes contribute disproportionately to actual training stress.
#
# Granular approach: sum f(hr_i) × Δt_i over every record interval.
# Avg-HR fallback:   compute f(avg_hr) × total_duration  (existing behaviour).
#
# Activities not present in the SQLite (e.g. older activities not yet
# downloaded with garmin_download.py --all) fall back automatically.

GARMIN_SQLITE = Path.home() / "HealthData" / "DBs" / "garmin_activities.db"


def load_garmin_records() -> dict:
    """
    Load HR records from the local GarminDB SQLite into memory.

    Returns {activity_id_str: [(datetime, hr_int), ...]} sorted by timestamp.
    Returns {} if the file doesn't exist — all activities will use avg_hr.
    """
    if not GARMIN_SQLITE.exists():
        return {}
    try:
        conn = sqlite3.connect(str(GARMIN_SQLITE))
        rows = conn.execute(
            "SELECT activity_id, timestamp, hr "
            "FROM activity_records "
            "WHERE hr IS NOT NULL "
            "ORDER BY activity_id, record"
        ).fetchall()
        conn.close()
    except Exception as exc:
        print(f"  ⚠  Could not read GarminDB SQLite ({exc}); using avg_hr for all activities")
        return {}

    records: dict = {}
    for activity_id, ts_str, hr in rows:
        # Strip microseconds — fromisoformat on Python 3.9 doesn't handle 6-digit µs
        ts = datetime.fromisoformat(ts_str[:19])
        records.setdefault(str(activity_id), []).append((ts, int(hr)))
    return records


def compute_trimp_granular(
    records: list,
    resting_hr: float,
    max_hr: float,
) -> Optional[float]:
    """
    Banister TRIMP summed over per-record intervals.

    Uses midpoint HR for each interval.  Skips gaps > 5 min (auto-pause,
    GPS loss) so paused time doesn't silently inflate the score.
    """
    if len(records) < 2:
        return None
    total = 0.0
    for i in range(1, len(records)):
        ts_prev, hr_prev = records[i - 1]
        ts_curr, hr_curr = records[i]
        dt_sec = (ts_curr - ts_prev).total_seconds()
        if dt_sec <= 0 or dt_sec > 300:
            continue
        hr = (hr_prev + hr_curr) / 2.0
        hrr = max(0.0, min(1.0, (hr - resting_hr) / (max_hr - resting_hr)))
        dt_min = dt_sec / 60.0
        total += dt_min * hrr * 0.64 * math.exp(1.92 * hrr)
    return total if total > 0 else None


def compute_hr_tss_granular(
    records: list,
    resting_hr: float,
    max_hr: float,
    lthr: float,
) -> Optional[float]:
    """
    hrTSS summed over per-record intervals.

    Each interval contributes (Δt_sec × (hrr / lthr_hrr)² × 100) / 3600.
    Pauses > 5 min are skipped; midpoint HR is used for each interval.
    """
    lthr_hrr = max(0.0, min(1.0, (lthr - resting_hr) / (max_hr - resting_hr)))
    if lthr_hrr == 0 or len(records) < 2:
        return None
    total = 0.0
    for i in range(1, len(records)):
        ts_prev, hr_prev = records[i - 1]
        ts_curr, hr_curr = records[i]
        dt_sec = (ts_curr - ts_prev).total_seconds()
        if dt_sec <= 0 or dt_sec > 300:
            continue
        hr = (hr_prev + hr_curr) / 2.0
        hrr = max(0.0, min(1.0, (hr - resting_hr) / (max_hr - resting_hr)))
        total += dt_sec * (hrr / lthr_hrr) ** 2 * 100.0 / 3600.0
    return total if total > 0 else None


def determine_active_load(
    is_run: bool,
    pace_load_flat: Optional[float],
    pace_load_gap: Optional[float],
    hr_tss_score: Optional[float],
    has_elevation: bool,
) -> Optional[float]:
    """
    Priority (highest to lowest):
      1. Any activity with HR → hr_tss
      2. Running + elevation  → pace_load_gap  (fallback when no HR)
      3. Running              → pace_load_flat (fallback when no HR)
      4. Otherwise            → None (NULL in DB)
    """
    if hr_tss_score is not None and hr_tss_score > 0:
        return hr_tss_score
    if is_run and has_elevation and pace_load_gap is not None:
        return pace_load_gap
    if is_run and pace_load_flat is not None:
        return pace_load_flat
    return None


# ─── PMC ──────────────────────────────────────────────────────────────────────

def compute_pmc(
    daily_loads: dict,    # date → float
    start: date,
    end: date,
    ctl_tc: int,
    atl_tc: int,
) -> list:
    """
    Walk forward from start to end computing CTL, ATL, TSB.

    TSB(t) = CTL(t-1) - ATL(t-1)   — form going INTO the day
    CTL(t) = CTL(t-1) + (load(t) - CTL(t-1)) * k_CTL
    ATL(t) = ATL(t-1) + (load(t) - ATL(t-1)) * k_ATL

    Days with no activities contribute load = 0 (CTL/ATL still decay).
    """
    k_ctl   = 1.0 - math.exp(-1.0 / ctl_tc)
    k_atl   = 1.0 - math.exp(-1.0 / atl_tc)
    ctl = atl = 0.0
    rows = []
    current = start
    while current <= end:
        tsb  = ctl - atl
        load = daily_loads.get(current, 0.0)
        ctl  = ctl + (load - ctl) * k_ctl
        atl  = atl + (load - atl) * k_atl
        rows.append({
            "date"       : current,
            "daily_load" : load,
            "ctl"        : ctl,
            "atl"        : atl,
            "tsb"        : tsb,
        })
        current += timedelta(days=1)
    return rows


# ─── HELPERS ──────────────────────────────────────────────────────────────────

def fmt_pace(min_per_km: float) -> str:
    mins = int(min_per_km)
    secs = int(round((min_per_km - mins) * 60))
    return f"{mins}:{secs:02d}/km"


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main() -> None:
    # ── Load .env ──────────────────────────────────────────────────────────────
    script_dir  = os.path.dirname(os.path.abspath(__file__))
    dotenv_path = os.path.join(script_dir, ".env")
    load_dotenv(dotenv_path)

    db_url = os.getenv("SUPABASE_DB_URL")
    if not db_url:
        sys.exit(
            "SUPABASE_DB_URL not found in .env\n\n"
            "Add this line to your .env file:\n"
            "  SUPABASE_DB_URL=postgresql://postgres:<password>"
            "@db.alplxcjrxpkpoizfdjda.supabase.co:5432/postgres\n\n"
            "Find your password:\n"
            "  Supabase Dashboard → Settings → Database → Connection string (URI tab)"
        )

    cfg = dict(CONFIG)   # shallow copy so we can mutate reference_vdot

    print("Connecting to Supabase Postgres…")
    conn = psycopg2.connect(db_url)

    try:
        # psycopg2 `with conn:` context manager → COMMIT on success, ROLLBACK on exception
        with conn:
            with conn.cursor() as cur:

                # ── 1. Schema migrations ───────────────────────────────────────
                print("Applying schema migrations…")
                for stmt in MIGRATIONS:
                    cur.execute(stmt)
                print("  ✓ Schema up to date")

                # ── 2. Resolve VDOT → threshold pace ──────────────────────────
                if cfg["reference_vdot"] is None:
                    cur.execute(
                        "SELECT vdot FROM race_entries "
                        "ORDER BY created_at DESC LIMIT 1"
                    )
                    row = cur.fetchone()
                    if row and row[0] is not None:
                        cfg["reference_vdot"] = float(row[0])
                        print(f"  ✓ VDOT from race_entries: {cfg['reference_vdot']:.1f}")
                    else:
                        print("  ⚠  No race_entries found; using default threshold pace 4:30/km")

                if cfg["reference_vdot"] is not None:
                    t_pace = threshold_pace_from_vdot(cfg["reference_vdot"])
                    print(f"  Threshold pace: {fmt_pace(t_pace)}")
                else:
                    t_pace = 4.50   # ~VDOT 45 default

                resting_hr = float(cfg["resting_hr"]) if cfg["resting_hr"] is not None else 55.0
                max_hr     = float(cfg["max_hr"])

                # ── Resolve LTHR (CONFIG overrides and seeds DB; None reads from DB) ──
                lthr: Optional[float] = None
                if cfg["lthr"] is not None:
                    lthr = float(cfg["lthr"])
                    cur.execute("""
                        INSERT INTO lthr_settings (id, bpm, updated_at)
                        VALUES (1, %s, now())
                        ON CONFLICT (id) DO UPDATE
                            SET bpm        = EXCLUDED.bpm,
                                updated_at = now()
                    """, (lthr,))
                    print(f"  ✓ LTHR: {lthr:.0f} bpm (from CONFIG — seeded to lthr_settings)")
                else:
                    cur.execute("SELECT bpm FROM lthr_settings WHERE id = 1")
                    row = cur.fetchone()
                    if row:
                        lthr = float(row[0])
                        print(f"  ✓ LTHR: {lthr:.0f} bpm (from lthr_settings table)")
                    else:
                        print("  ⚠  LTHR not set — hr_tss will be NULL")

                print(f"  HR params: resting={resting_hr:.0f}  max={max_hr:.0f}  LTHR={f'{lthr:.0f} bpm' if lthr else 'not set'}")

                # ── 3. Fetch all activities ────────────────────────────────────
                print("\nFetching activities…")
                cur.execute("""
                    SELECT
                        activity_id,
                        sport,
                        start_time,
                        COALESCE(moving_time_seconds, elapsed_time_seconds) AS duration_seconds,
                        distance,
                        avg_hr,
                        ascent
                    FROM garmin_activities
                    WHERE COALESCE(moving_time_seconds, elapsed_time_seconds) IS NOT NULL
                      AND COALESCE(moving_time_seconds, elapsed_time_seconds) > 0
                    ORDER BY start_time ASC
                """)
                activity_rows = cur.fetchall()
                print(f"  {len(activity_rows)} activities found")

                if not activity_rows:
                    print("Nothing to process.")
                    return

                # ── 4. Load per-record HR data from local GarminDB SQLite ──────
                print("Loading per-record HR data from GarminDB SQLite…")
                garmin_records = load_garmin_records()
                if garmin_records:
                    n_with_records = sum(
                        1 for (act_id, *_) in activity_rows
                        if str(act_id) in garmin_records
                    )
                    print(f"  ✓ Records found for {n_with_records}/{len(activity_rows)} activities "
                          f"— granular TRIMP/hrTSS will be used for those")
                else:
                    print("  ⚠  SQLite not found or empty — using avg_hr for all activities")
                    n_with_records = 0

                # ── 5. Compute per-activity loads ──────────────────────────────
                print("Computing per-activity load scores…")

                activity_updates = []
                daily_loads: dict = {}
                n_granular = 0

                for (act_id, act_type, start_time, dur_sec,
                     dist_km, avg_hr, elev_gain) in activity_rows:

                    act_date  = (start_time.date()
                                 if hasattr(start_time, "date")
                                 else date.fromisoformat(str(start_time)[:10]))

                    dur_min   = float(dur_sec) / 60.0
                    t_type    = (act_type or "").lower()
                    is_run    = "run" in t_type

                    # Per-record HR data for this activity (empty list = fallback to avg_hr)
                    act_records = garmin_records.get(str(act_id), [])
                    used_granular = bool(act_records)
                    if used_granular:
                        n_granular += 1

                    # TRIMP — granular when records available, avg_hr otherwise
                    _trimp: Optional[float] = None
                    if act_records:
                        _trimp = compute_trimp_granular(act_records, resting_hr, max_hr)
                    elif avg_hr is not None and float(avg_hr) > 0:
                        _trimp = compute_trimp(dur_min, float(avg_hr), resting_hr, max_hr)

                    # Pace loads (running only — unchanged, uses activity-level aggregates)
                    _flat = _gap = None
                    if is_run and dist_km is not None and float(dist_km) > 0:
                        elev = float(elev_gain) if elev_gain is not None else None
                        _flat, _gap = compute_pace_loads(
                            float(dist_km), dur_min, elev, t_pace
                        )

                    # hrTSS — granular when records available, avg_hr otherwise
                    _hr_tss: Optional[float] = None
                    if lthr is not None:
                        if act_records:
                            _hr_tss = compute_hr_tss_granular(act_records, resting_hr, max_hr, lthr)
                        elif avg_hr is not None and float(avg_hr) > 0:
                            _hr_tss = compute_hr_tss(
                                float(dur_sec), float(avg_hr), resting_hr, max_hr, lthr
                            )

                    has_elev = (elev_gain is not None and float(elev_gain) > 0)
                    _active  = determine_active_load(is_run, _flat, _gap, _hr_tss, has_elev)

                    activity_updates.append({
                        "activity_id"    : act_id,
                        "trimp"          : round(_trimp,   4) if _trimp   is not None else None,
                        "pace_load_flat" : round(_flat,    4) if _flat    is not None else None,
                        "pace_load_gap"  : round(_gap,     4) if _gap     is not None else None,
                        "active_load"    : round(_active,  4) if _active  is not None else None,
                        "hr_tss"         : round(_hr_tss,  4) if _hr_tss  is not None else None,
                    })

                    if _active is not None:
                        daily_loads[act_date] = daily_loads.get(act_date, 0.0) + _active

                # ── 5. Bulk-update activities with load scores ─────────────────
                # Use a temp table + single UPDATE FROM for efficiency.
                print(f"  Writing {len(activity_updates)} activity load scores…")

                cur.execute("""
                    CREATE TEMP TABLE _tmp_loads (
                        activity_id    TEXT,
                        trimp          DOUBLE PRECISION,
                        pace_load_flat DOUBLE PRECISION,
                        pace_load_gap  DOUBLE PRECISION,
                        active_load    DOUBLE PRECISION,
                        hr_tss         DOUBLE PRECISION
                    ) ON COMMIT DROP
                """)

                psycopg2.extras.execute_values(
                    cur,
                    "INSERT INTO _tmp_loads VALUES %s",
                    [
                        (u["activity_id"], u["trimp"], u["pace_load_flat"],
                         u["pace_load_gap"], u["active_load"], u["hr_tss"])
                        for u in activity_updates
                    ],
                )

                cur.execute("""
                    UPDATE garmin_activities a
                    SET
                        trimp          = t.trimp,
                        pace_load_flat = t.pace_load_flat,
                        pace_load_gap  = t.pace_load_gap,
                        active_load    = t.active_load,
                        hr_tss         = t.hr_tss
                    FROM _tmp_loads t
                    WHERE a.activity_id = t.activity_id
                """)
                updated = cur.rowcount
                print(f"  ✓ Updated {updated} activities")

                # ── 6. Compute PMC ─────────────────────────────────────────────
                if not daily_loads:
                    print("\n⚠  No activities produced an active_load; PMC not computed.")
                    return

                start_date = min(daily_loads.keys())
                end_date   = date.today()
                print(f"\nComputing PMC from {start_date} to {end_date}…")

                pmc_rows = compute_pmc(
                    daily_loads, start_date, end_date,
                    cfg["ctl_tc"], cfg["atl_tc"],
                )

                # ── 7. Upsert pmc_daily ────────────────────────────────────────
                print(f"  Upserting {len(pmc_rows)} pmc_daily rows…")

                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO pmc_daily (date, daily_load, ctl, atl, tsb)
                    VALUES %s
                    ON CONFLICT (date) DO UPDATE SET
                        daily_load = EXCLUDED.daily_load,
                        ctl        = EXCLUDED.ctl,
                        atl        = EXCLUDED.atl,
                        tsb        = EXCLUDED.tsb,
                        updated_at = now()
                    """,
                    [
                        (r["date"], r["daily_load"], r["ctl"], r["atl"], r["tsb"])
                        for r in pmc_rows
                    ],
                )
                print(f"  ✓ {len(pmc_rows)} PMC rows upserted")

                # ── 8. Summary ─────────────────────────────────────────────────
                latest   = pmc_rows[-1]
                non_zero = sum(1 for v in daily_loads.values() if v > 0)
                n_avg_hr = len(activity_rows) - n_granular

                print(f"\n── PMC Summary ({latest['date']}) ────────────────")
                print(f"  Active days with load : {non_zero}")
                print(f"  Fitness (CTL)         : {latest['ctl']:.1f}")
                print(f"  Fatigue (ATL)         : {latest['atl']:.1f}")
                print(f"  Form    (TSB)         : {latest['tsb']:.1f}")
                print(f"\n── TSS method ────────────────────────────────────")
                print(f"  Granular (per-record) : {n_granular} activities")
                print(f"  Avg-HR fallback       : {n_avg_hr} activities")
                if n_avg_hr > 0 and n_granular == 0:
                    print(f"  ↳ Run 'python3 garmin_download.py --all' to download")
                    print(f"    records for all activities and enable granular TSS")
                print(f"\n✓ Pipeline complete — transaction committed")

                # ── 9. Notify PostgREST to reload schema cache ─────────────────
                # Picks up any new GRANTs so the Supabase JS client can immediately
                # read pmc_daily and lthr_settings without waiting for auto-reload.
                cur.execute("NOTIFY pgrst, 'reload schema'")

    except Exception as exc:
        print(f"\n✗ Pipeline failed — transaction rolled back")
        print(f"  {type(exc).__name__}: {exc}")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
