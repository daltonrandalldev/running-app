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
    activities  — adds columns: trimp, pace_load_flat, pace_load_gap, active_load
    pmc_daily   — new table: date, daily_load, ctl, atl, tsb, updated_at

Active load priority
--------------------
    Running + elevation available  → pace_load_gap
    Running + no elevation         → pace_load_flat
    Non-running with HR            → trimp
    Otherwise                      → NULL
"""

import math
import os
import sys
from datetime import date, timedelta
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
    "ALTER TABLE activities ADD COLUMN IF NOT EXISTS trimp          DOUBLE PRECISION",
    "ALTER TABLE activities ADD COLUMN IF NOT EXISTS pace_load_flat DOUBLE PRECISION",
    "ALTER TABLE activities ADD COLUMN IF NOT EXISTS pace_load_gap  DOUBLE PRECISION",
    "ALTER TABLE activities ADD COLUMN IF NOT EXISTS active_load    DOUBLE PRECISION",
    "ALTER TABLE activities ADD COLUMN IF NOT EXISTS hr_tss         DOUBLE PRECISION",
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
                        id,
                        activity_type,
                        start_time,
                        duration_seconds,
                        distance_km,
                        avg_hr,
                        elevation_gain_m
                    FROM activities
                    WHERE duration_seconds IS NOT NULL
                      AND duration_seconds > 0
                    ORDER BY start_time ASC
                """)
                activity_rows = cur.fetchall()
                print(f"  {len(activity_rows)} activities found")

                if not activity_rows:
                    print("Nothing to process.")
                    return

                # ── 4. Compute per-activity loads ──────────────────────────────
                print("Computing per-activity load scores…")

                activity_updates = []
                daily_loads: dict = {}

                for (act_id, act_type, start_time, dur_sec,
                     dist_km, avg_hr, elev_gain) in activity_rows:

                    act_date  = (start_time.date()
                                 if hasattr(start_time, "date")
                                 else date.fromisoformat(str(start_time)[:10]))

                    dur_min   = float(dur_sec) / 60.0
                    t_type    = (act_type or "").lower()
                    is_run    = "run" in t_type

                    # TRIMP (all activity types with HR)
                    _trimp: Optional[float] = None
                    if avg_hr is not None and float(avg_hr) > 0:
                        _trimp = compute_trimp(dur_min, float(avg_hr), resting_hr, max_hr)

                    # Pace loads (running only)
                    _flat = _gap = None
                    if is_run and dist_km is not None and float(dist_km) > 0:
                        elev = float(elev_gain) if elev_gain is not None else None
                        _flat, _gap = compute_pace_loads(
                            float(dist_km), dur_min, elev, t_pace
                        )

                    # hrTSS (all activity types with HR, when LTHR is configured)
                    _hr_tss: Optional[float] = None
                    if lthr is not None and avg_hr is not None and float(avg_hr) > 0:
                        _hr_tss = compute_hr_tss(
                            float(dur_sec), float(avg_hr), resting_hr, max_hr, lthr
                        )

                    has_elev = (elev_gain is not None and float(elev_gain) > 0)
                    _active  = determine_active_load(is_run, _flat, _gap, _hr_tss, has_elev)

                    activity_updates.append({
                        "id"             : act_id,
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
                        id             BIGINT,
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
                        (u["id"], u["trimp"], u["pace_load_flat"],
                         u["pace_load_gap"], u["active_load"], u["hr_tss"])
                        for u in activity_updates
                    ],
                )

                cur.execute("""
                    UPDATE activities a
                    SET
                        trimp          = t.trimp,
                        pace_load_flat = t.pace_load_flat,
                        pace_load_gap  = t.pace_load_gap,
                        active_load    = t.active_load,
                        hr_tss         = t.hr_tss
                    FROM _tmp_loads t
                    WHERE a.id = t.id
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

                print(f"\n── PMC Summary ({latest['date']}) ────────────────")
                print(f"  Active days with load : {non_zero}")
                print(f"  Fitness (CTL)         : {latest['ctl']:.1f}")
                print(f"  Fatigue (ATL)         : {latest['atl']:.1f}")
                print(f"  Form    (TSB)         : {latest['tsb']:.1f}")
                print(f"\n✓ Pipeline complete — transaction committed")

    except Exception as exc:
        print(f"\n✗ Pipeline failed — transaction rolled back")
        print(f"  {type(exc).__name__}: {exc}")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
