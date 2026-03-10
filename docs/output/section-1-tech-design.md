# Section 1 Technical Design: Data Ingestion & Storage Architecture

**Section:** 1
**Author:** Staff Engineer Lead
**Date:** 2026-03-10
**Status:** Draft

---

## 1. Overview

This document describes the technical design for PRD Section 1: Data Ingestion & Storage Architecture. The goal is to establish a manufacturer-agnostic ingestion layer that brings activity and wellness data from GarminDB and Intervals.icu into a unified Supabase schema, with deduplication, normalization, and a deferred time-series store.

The existing `garmin_activities` table and GarminDB pipeline remain canonical and are extended rather than replaced. Intervals.icu is added as a first-class parallel source via a new sync adapter. Zwift data flows through Intervals.icu only. All new tables follow the established patterns in `sql/daily_pmc_values.sql` and `sql/race_detection.sql`.

All product decisions referenced below were specified by the TPM and are captured in the context for this section.

---

## 2. Schema Changes

### 2.1 New Tables

#### 2.1.1 activity_sources

Tracks every source-platform instance of an activity for deduplication. One row per (source_platform, external_id) pair. The `canonical_activity_id` FK points to the authoritative row in `garmin_activities`. A GarminDB-sourced activity has one row with `is_preferred = true`. If the same activity is also found via Intervals.icu, a second row is added with `is_preferred = false`.

**Clarification:** `activity_sources` stores only metadata and references — it does not duplicate activity data. The columns are: `id`, `canonical_activity_id` (FK to `garmin_activities`), `source_platform`, `external_id`, `start_time`, `sport_type`, `is_preferred`, and `raw_data_ref` (an optional URL or storage key to the original payload, not a copy of it). All authoritative activity fields (distance, HR, pace, etc.) live exclusively in `garmin_activities`. The "GarminDB is canonical" rule is enforced by the merge logic in Section 3.3.2: when a duplicate is detected, the GarminDB row is preserved and the Intervals.icu version is recorded in `activity_sources` only, never written as a second `garmin_activities` row.

```sql
-- ING-001: activity_sources table
--
-- Deduplication tracking. One row per source-platform instance of an activity.
-- canonical_activity_id references garmin_activities(activity_id) — the winning row.
-- is_preferred = true designates the version whose fields are authoritative.
-- GarminDB is canonical when both sources have the same activity.
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS activity_sources (
    id                   BIGSERIAL    PRIMARY KEY,
    canonical_activity_id TEXT        NOT NULL REFERENCES garmin_activities(activity_id)
                                      ON DELETE CASCADE,
    source_platform      TEXT         NOT NULL
                                      CHECK (source_platform IN (
                                          'garmin', 'intervals_icu', 'zwift',
                                          'strava', 'wahoo', 'manual'
                                      )),
    external_id          TEXT         NOT NULL,
    start_time           TIMESTAMPTZ  NOT NULL,
    sport_type           TEXT         NOT NULL,
    is_preferred         BOOLEAN      NOT NULL DEFAULT false,
    raw_data_ref         TEXT,        -- optional: URL or storage key for raw payload
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (source_platform, external_id)
);

-- Lookup by canonical activity (e.g., "what sources contributed to this row?")
CREATE INDEX IF NOT EXISTS idx_activity_sources_canonical
    ON activity_sources (canonical_activity_id);

-- Lookup by preferred source per activity
CREATE INDEX IF NOT EXISTS idx_activity_sources_preferred
    ON activity_sources (canonical_activity_id, is_preferred);

GRANT SELECT, INSERT, UPDATE ON activity_sources TO anon, authenticated;
ALTER TABLE activity_sources DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

**Notes:**
- `source_platform` CHECK constraint lists all anticipated platforms. Adding a new platform requires only a constraint extension (one `ALTER TABLE`), not a schema migration — fulfilling the PRD extensibility requirement.
- `raw_data_ref` is nullable. It may hold a reference to the original JSON payload stored in object storage, or be left NULL for sources where raw archiving is not implemented.
- `BIGSERIAL` PK (same reasoning as `daily_monotony_strain`): this table accumulates rows per-source per-activity and sequential integers are more storage-efficient than UUIDs.

#### 2.1.2 activity_streams

Per-second time-series data per activity. This table stores raw per-second telemetry — one row per second of activity — sourced from the Intervals.icu streams endpoint (`GET /athlete/{id}/activities/{activity_id}/streams`). It is not aggregated or summarized data; each row is an individual sample from the device stream. Population is deferred: the table schema is created here, but no data is written until `athletes.activity_streams_enabled = true` (see TD-004). The Intervals.icu adapter checks this flag before calling the streams endpoint. Estimated storage cost: ~150 MB for 500 activities with full per-second streams.

```sql
-- ING-002: activity_streams table
--
-- Per-second time-series data for each activity.
-- Population is DEFERRED — this table is schema-ready but no data is written
-- until explicit sync strategy is confirmed. See Section 3 / ING-002 for trigger.
--
-- activity_id references garmin_activities(activity_id) ON DELETE CASCADE.
-- All stream fields are nullable (device availability varies).
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS activity_streams (
    id                  BIGSERIAL    PRIMARY KEY,
    activity_id         TEXT         NOT NULL REFERENCES garmin_activities(activity_id)
                                     ON DELETE CASCADE,
    timestamp           TIMESTAMPTZ  NOT NULL,
    hr                  INT,                    -- beats per minute
    pace_sec_per_km     FLOAT,                  -- running pace (s/km)
    power_watts         FLOAT,                  -- cycling or running power (W)
    cadence             INT,                    -- spm (running) or rpm (cycling)
    elevation_m         FLOAT,                  -- metres above sea level
    lat                 FLOAT,                  -- decimal degrees; NULL for indoor/virtual
    lng                 FLOAT,                  -- decimal degrees; NULL for indoor/virtual
    gct_ms              INT,                    -- ground contact time (ms); running only
    vertical_osc_cm     FLOAT,                  -- vertical oscillation (cm); running only
    temperature_c       FLOAT,                  -- device or weather-backfilled
    UNIQUE (activity_id, timestamp)
);

-- Primary query pattern: fetch all stream rows for a single activity in time order
CREATE INDEX IF NOT EXISTS idx_activity_streams_activity_time
    ON activity_streams (activity_id, timestamp);

GRANT SELECT, INSERT ON activity_streams TO anon, authenticated;
ALTER TABLE activity_streams DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

**Population deferred trigger (decision — see Section 5):** Population is enabled when the athlete explicitly opts in via a UI setting, or when a specific analytics section (e.g., Section 9 Running Dynamics, Section 10 MMP Curve) requires per-second resolution that cannot be derived from lap-level data. An `activity_streams_enabled` flag on the `athletes` table (added in ING-001) controls whether the Intervals.icu adapter fetches and upserts streams during sync.

#### 2.1.3 daily_health

Daily wellness metrics sourced from GarminDB or Intervals.icu wellness API.

```sql
-- ING-003: daily_health table
--
-- Daily wellness metrics per athlete. One row per (athlete_id, date).
-- Sources: GarminDB (via Python sync) and/or Intervals.icu wellness endpoint.
-- All metric columns are nullable — field availability depends on device and source.
-- HRV stored as two columns: hrv_rmssd (RMSSD ms) and hrv_status (Garmin 1–5 scale).
--
-- Run once via the Supabase SQL editor. Idempotent (uses IF NOT EXISTS).
-- Prerequisites: daily_pmc_values.sql must have run (provides athletes table).

CREATE TABLE IF NOT EXISTS daily_health (
    id                  BIGSERIAL    PRIMARY KEY,
    athlete_id          UUID         NOT NULL REFERENCES athletes(id),
    date                DATE         NOT NULL,
    source_platform     TEXT         NOT NULL DEFAULT 'garmin'
                                     CHECK (source_platform IN (
                                         'garmin', 'intervals_icu', 'merged'
                                     )),
    resting_hr          INT,                    -- bpm
    hrv_rmssd           FLOAT,                  -- RMSSD in ms
    hrv_status          INT                     -- Garmin proprietary 1–5 scale
                                     CHECK (hrv_status BETWEEN 1 AND 5),
    sleep_total_min     INT,
    sleep_deep_min      INT,
    sleep_light_min     INT,
    sleep_rem_min       INT,
    sleep_awake_min     INT,
    weight_kg           FLOAT,
    spo2_pct            FLOAT,
    stress_score        INT,                    -- Garmin Body Battery / stress
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (athlete_id, date)
);

-- Primary query: fetch health metrics in a date range for an athlete
CREATE INDEX IF NOT EXISTS idx_daily_health_athlete_date
    ON daily_health (athlete_id, date);

GRANT SELECT, INSERT, UPDATE ON daily_health TO anon, authenticated;
ALTER TABLE daily_health DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

**Notes:**
- `UNIQUE (athlete_id, date)` — one row per day, upserted from whatever source ran last. `source_platform = 'merged'` is used when a GarminDB row is later supplemented with Intervals.icu values (e.g., HRV RMSSD from Intervals.icu fills in a NULL from GarminDB).
- `hrv_status` CHECK enforces the Garmin 1–5 scale at the database layer; application code must pass NULL rather than 0 when the value is unavailable.

### 2.2 Column Additions to Existing Tables

#### 2.2.1 garmin_activities additions

Three columns are added. `source_platform` enables filtering by origin platform and satisfies the PRD's requirement that Intervals.icu activities are stored to `garmin_activities` with `source_platform = 'intervals_icu'`. `normalized_power` is needed by Section 12 (Cycling NP/IF/VI). `local_timezone` enables local-time queries without reprocessing UTC timestamps.

```sql
-- ING-001: Column additions to garmin_activities
--
-- Adds source_platform, normalized_power, local_timezone.
-- Idempotent (uses ADD COLUMN IF NOT EXISTS).
-- Run once via the Supabase SQL editor.

ALTER TABLE garmin_activities
    ADD COLUMN IF NOT EXISTS source_platform   TEXT    NOT NULL DEFAULT 'garmin',
    ADD COLUMN IF NOT EXISTS normalized_power  FLOAT,           -- watts; cycling only
    ADD COLUMN IF NOT EXISTS local_timezone    TEXT;            -- IANA tz, e.g. 'America/New_York'

-- Backfill existing rows: all pre-existing rows are GarminDB-sourced
UPDATE garmin_activities
SET source_platform = 'garmin'
WHERE source_platform IS NULL;

-- Index to support per-source queries (e.g., "all Intervals.icu activities")
CREATE INDEX IF NOT EXISTS idx_garmin_activities_source_platform
    ON garmin_activities (source_platform);

GRANT SELECT, UPDATE ON garmin_activities TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
```

#### 2.2.2 athletes table profile extension

Profile fields are added as columns to the existing `athletes` table. A separate `athlete_profile` table is not needed (per PRD Section 1.4).

```sql
-- ING-001: Profile column additions to athletes
--
-- Adds FTP, threshold pace, HR/pace/power zone config columns.
-- Idempotent (uses ADD COLUMN IF NOT EXISTS).
-- Run once via the Supabase SQL editor.
-- Prerequisites: daily_pmc_values.sql must have run (creates athletes table).

ALTER TABLE athletes
    ADD COLUMN IF NOT EXISTS ftp_cycling               FLOAT,   -- functional threshold power (W)
    ADD COLUMN IF NOT EXISTS threshold_pace_sec_per_km FLOAT,   -- threshold running pace (s/km)
    ADD COLUMN IF NOT EXISTS max_hr                    INT,     -- bpm
    ADD COLUMN IF NOT EXISTS resting_hr_baseline       INT,     -- bpm
    ADD COLUMN IF NOT EXISTS hr_zones                  JSONB,   -- zone boundaries keyed by zone name
    ADD COLUMN IF NOT EXISTS pace_zones                JSONB,   -- zone boundaries in s/km
    ADD COLUMN IF NOT EXISTS power_zones               JSONB,   -- zone boundaries in watts
    ADD COLUMN IF NOT EXISTS activity_streams_enabled  BOOLEAN  NOT NULL DEFAULT false;

-- activity_streams_enabled controls whether the sync adapter fetches per-second streams

GRANT SELECT, UPDATE ON athletes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
```

**Zone JSONB shape (reference):**
```json
{
  "z1": { "min": 0, "max": 115 },
  "z2": { "min": 115, "max": 152 },
  "z3": { "min": 152, "max": 171 },
  "z4": { "min": 171, "max": 190 },
  "z5": { "min": 190, "max": 999 }
}
```

---

## 3. Ingestion Architecture

### 3.1 GarminDB Pipeline (existing, minimal changes)

The existing Python-based GarminDB sync writes to `garmin_activities`. The changes required are:

1. **Set `source_platform = 'garmin'`** on all new rows (default value handles this; no code change needed for new rows).
2. **Populate `local_timezone`:** Extract the IANA timezone string from GarminDB's fit file metadata or from the GPS coordinates via a reverse-geocode lookup (e.g., `timezonefinder` Python library). Store as `local_timezone` TEXT.
3. **Populate `normalized_power`** for cycling activities if the FIT file contains `normalized_power` in the session record. This is a pass-through; no calculation required here (Section 12 performs the full NP calculation if raw power streams are available).
4. **Populate `daily_health`** from GarminDB's monitoring database: resting HR, HRV RMSSD (if available from device), sleep metrics, body weight, SpO2, stress score. These fields exist in GarminDB's `monitoring_hr`, `sleep`, and `body_composition` tables.

No structural changes to the Python sync script are required beyond these additions. The sync server continues to expose `POST /sync` on port 5001.

### 3.2 Intervals.icu Sync Adapter (new)

A new Python module (`sync/intervals_adapter.py`) handles all Intervals.icu API communication. It is called from the sync server as a new endpoint.

#### 3.2.1 Authentication

Intervals.icu uses HTTP Basic Authentication. The athlete ID and API key are read from environment variables.

```python
import os, requests
from requests.auth import HTTPBasicAuth

INTERVALS_BASE = "https://intervals.icu/api/v1"
ATHLETE_ID = os.environ["INTERVALS_ICU_ATHLETE_ID"]   # e.g. "i12345"
API_KEY    = os.environ["INTERVALS_ICU_API_KEY"]

_auth = HTTPBasicAuth("API_KEY", API_KEY)

def _get(path: str, params: dict = None) -> dict | list:
    url = f"{INTERVALS_BASE}/athlete/{ATHLETE_ID}/{path}"
    r = requests.get(url, auth=_auth, params=params, timeout=30)
    r.raise_for_status()
    return r.json()
```

Env vars added to `.env` (and documented in `.env.example`):
```
INTERVALS_ICU_ATHLETE_ID=i12345
INTERVALS_ICU_API_KEY=your_api_key_here
```

#### 3.2.2 Activity Sync Endpoint

**Endpoint:** `GET /athlete/{id}/activities`

**Parameters:**
- `oldest` (ISO date string) — fetch activities on or after this date
- `newest` (ISO date string) — fetch activities up to and including this date
- `limit` — max rows per page; use `200` (Intervals.icu maximum)

**Pagination strategy:** Intervals.icu returns activities sorted newest-first. Fetch pages of 200 until the oldest returned `start_date_local` is before the cutoff date, or an empty page is returned. The adapter tracks the oldest synced date in memory per-run; on first run, it syncs the last 365 days.

**Call sequence:**
```python
def fetch_activities(oldest_date: str, newest_date: str) -> list[dict]:
    """Returns all activities between oldest_date and newest_date (inclusive)."""
    results = []
    params = {
        "oldest": oldest_date,
        "newest": newest_date,
        "limit": 200,
    }
    # Intervals.icu /activities does not use cursor pagination;
    # the date range fully constrains the result set.
    data = _get("activities", params=params)
    results.extend(data)
    return results
```

**Request example:**
```
GET https://intervals.icu/api/v1/athlete/i12345/activities
    ?oldest=2025-01-01&newest=2026-03-10&limit=200
Authorization: Basic QVBJX0tFWTo8YXBpX2tleT4=
```

**Response shape (per activity, key fields used):**
```json
{
  "id": "A12345678",
  "type": "Run",
  "start_date_local": "2025-06-15T07:30:00",
  "tz": "Europe/London",
  "distance": 10234.5,
  "moving_time": 3600,
  "elapsed_time": 3720,
  "total_elevation_gain": 85.3,
  "total_elevation_loss": 82.1,
  "average_heartrate": 148.2,
  "max_heartrate": 172,
  "average_speed": 2.843,
  "average_cadence": 88,
  "normalized_power": null,
  "icu_training_load": 62.4,
  "start_latlng": [51.5074, -0.1278],
  "source": "GARMIN"
}
```

**Field mapping to `garmin_activities`:**

| Intervals.icu field | garmin_activities column | Notes |
|---|---|---|
| `id` | `activity_id` | Prefixed: `"icu_" + id` to avoid collision with Garmin activity IDs |
| `type` | `sport_type` | Direct mapping |
| `start_date_local` + `tz` | `start_time` | Convert to UTC using `tz` field |
| `tz` | `local_timezone` | IANA string direct |
| `distance` | `distance` | metres |
| `moving_time` | `duration` | seconds |
| `total_elevation_gain` | `ascent` | metres |
| `total_elevation_loss` | `descent` | metres |
| `average_heartrate` | `avg_hr` | bpm |
| `max_heartrate` | `max_hr` | bpm |
| `average_speed` | `avg_pace` | Convert m/s → sec/km: `1000 / speed` |
| `average_cadence` | `avg_cadence` | spm or rpm |
| `normalized_power` | `normalized_power` | watts; NULL for non-power activities |
| `icu_training_load` | `active_load` | Intervals.icu TSS equivalent |
| `start_latlng[0]` | `start_lat` | NULL if absent (indoor/Zwift) |
| `start_latlng[1]` | `start_lng` | NULL if absent |
| `"intervals_icu"` | `source_platform` | Hardcoded |

**Zwift-specific handling:**
- `source` field in the Intervals.icu response will be `"ZWIFT"` for Zwift activities.
- `start_latlng` will be absent or `null` — store `start_lat = NULL`, `start_lng = NULL`.
- `total_elevation_gain`/`loss` are virtual (trainer road gradient). These are stored as-is but a future flag column (`is_virtual_elevation`) can be added if needed. Not in scope for Section 1.

#### 3.2.3 Wellness Sync Endpoint

**Endpoint:** `GET /athlete/{id}/wellness`

**Parameters:**
- `oldest` (ISO date string)
- `newest` (ISO date string)

**Call sequence:**
```python
def fetch_wellness(oldest_date: str, newest_date: str) -> list[dict]:
    params = {"oldest": oldest_date, "newest": newest_date}
    return _get("wellness", params=params)
```

**Response shape (per day, key fields used):**
```json
{
  "id": "2025-06-15",
  "ctl": 62.4,
  "atl": 68.1,
  "rampRate": -0.8,
  "restingHR": 44,
  "hrv": 68.2,
  "hrvScore": 3,
  "sleepSecs": 27000,
  "sleepScore": 72,
  "sportInfo": [...],
  "weight": 72.5,
  "spO2": 97.1,
  "mentalLoad": null
}
```

**Field mapping to `daily_health`:**

| Intervals.icu field | daily_health column | Notes |
|---|---|---|
| `id` (date string) | `date` | ISO date |
| `restingHR` | `resting_hr` | bpm; may be NULL |
| `hrv` | `hrv_rmssd` | RMSSD in ms; NULL if absent |
| `hrvScore` | `hrv_status` | Garmin 1–5 scale proxy; NULL if absent |
| `sleepSecs` / 60 | `sleep_total_min` | Convert seconds to minutes |
| `weight` | `weight_kg` | kg |
| `spO2` | `spo2_pct` | percentage |
| `"intervals_icu"` | `source_platform` | Hardcoded |

**Sleep breakdown:** Intervals.icu does not expose deep/light/REM breakdown in the wellness endpoint. `sleep_deep_min`, `sleep_light_min`, `sleep_rem_min`, `sleep_awake_min` will be NULL for Intervals.icu-sourced rows. GarminDB is the source for sleep stage breakdown.

**Upsert strategy for `daily_health`:** Upsert on `(athlete_id, date)`. If a GarminDB row already exists for that date, the Intervals.icu upsert merges in only the non-NULL fields it provides (HRV RMSSD, HRV score, weight, SpO2) and sets `source_platform = 'merged'`. If no GarminDB row exists, the full Intervals.icu row is inserted with `source_platform = 'intervals_icu'`.

The merge upsert uses a partial-update pattern in the Python adapter:
```python
# Only update columns that Intervals.icu provides and that are non-NULL
supabase.table("daily_health").upsert({
    "athlete_id": ATHLETE_ID,
    "date": day["id"],
    "resting_hr": day.get("restingHR"),
    "hrv_rmssd": day.get("hrv"),
    "hrv_status": day.get("hrvScore"),
    "sleep_total_min": day.get("sleepSecs") and int(day["sleepSecs"] / 60),
    "weight_kg": day.get("weight"),
    "spo2_pct": day.get("spO2"),
    "source_platform": "intervals_icu",
}, on_conflict="athlete_id,date").execute()
```

#### 3.2.4 Sync Server Extension

The sync server (`sync_server.py`, port 5001) is extended with a dedicated endpoint for Intervals.icu sync. A separate endpoint is used rather than extending `POST /sync` to keep GarminDB and Intervals.icu sync independent and separately triggerable.

**Security scope note:** `sync_server.py` is a localhost-only personal sync server. It binds to `127.0.0.1:5001` and is never exposed to the public internet. It is called from the Expo app on the same device or local network. In this context, HTTP Basic Auth for Intervals.icu API credentials (read from environment variables) is the appropriate and sufficient security boundary. No webhook ingress, token rotation, or production-grade auth middleware is required or planned for this personal-use server.

**New endpoint:** `POST /sync/intervals`

```python
@app.route("/sync/intervals", methods=["POST"])
def sync_intervals():
    body = request.get_json(silent=True) or {}
    oldest = body.get("oldest", _default_oldest())   # default: 365 days ago
    newest = body.get("newest", _today_iso())
    try:
        activities = fetch_activities(oldest, newest)
        wellness   = fetch_wellness(oldest, newest)
        act_result = upsert_activities(activities)   # dedup check included
        well_result = upsert_wellness(wellness)
        return jsonify({
            "ok": True,
            "activities_upserted": act_result["count"],
            "wellness_upserted":   well_result["count"],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
```

**Corresponding TypeScript client function** (added to `lib/syncApi.ts`):

```typescript
export async function triggerIntervalsSync(
  oldest?: string,
  newest?: string,
): Promise<{ ok: boolean; activities_upserted?: number; wellness_upserted?: number; error?: string }> {
  try {
    const body: Record<string, string> = {};
    if (oldest) body.oldest = oldest;
    if (newest) body.newest = newest;
    const res = await fetch(`${SYNC_SERVER_URL}/sync/intervals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Sync server not reachable' };
  }
}
```

### 3.3 Deduplication Logic

#### 3.3.1 Detection Query

When the Intervals.icu adapter prepares to upsert an activity, deduplication proceeds in two stages:

**Stage 1 — External ID pre-check (idempotency guard):**

Before doing any time-window scan, check whether `activity_sources` already has a row for the Intervals.icu external ID. If it does, the activity was already ingested on a previous sync run — skip it entirely. This is the fast path and prevents duplicate processing on re-runs.

```python
def already_ingested(intervals_activity_id: str) -> bool:
    """Returns True if this Intervals.icu activity has already been processed."""
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
```

**Stage 2 — Time-window + sport_type match (cross-source duplicate detection):**

Only reached if Stage 1 returns False (activity not yet recorded in `activity_sources`). Checks whether a GarminDB activity exists for the same start window:

```sql
SELECT activity_id, source_platform
FROM garmin_activities
WHERE sport_type = :sport_type
  AND start_time BETWEEN (:start_time::timestamptz - INTERVAL '5 minutes')
                     AND (:start_time::timestamptz + INTERVAL '5 minutes')
LIMIT 1;
```

In Python:
```python
def find_duplicate(sport_type: str, start_time_utc: str) -> str | None:
    """Returns the canonical activity_id if a GarminDB duplicate exists, else None."""
    result = (
        supabase.table("garmin_activities")
        .select("activity_id")
        .eq("sport_type", sport_type)
        .gte("start_time", _subtract_minutes(start_time_utc, 5))
        .lte("start_time", _add_minutes(start_time_utc, 5))
        .limit(1)
        .execute()
    )
    rows = result.data
    return rows[0]["activity_id"] if rows else None
```

**On false-positive risk:** Back-to-back same-sport activities within a 5-minute window are extremely rare in endurance sports — the minimum transition time between two separate efforts (cool-down, equipment change, re-start) reliably exceeds 5 minutes. The ±5-minute heuristic is therefore sufficient for the target sport set (running, cycling, swimming, Zwift). If a future sport type has shorter inter-activity gaps, the window can be narrowed or sport-type-specific overrides can be added without schema changes.

#### 3.3.2 Merge Rules

When a duplicate is detected (GarminDB activity already exists, Intervals.icu has the same activity):

| Field | Winner | Rationale |
|---|---|---|
| `activity_id` | GarminDB | GarminDB ID is canonical; Intervals.icu ID goes in `activity_sources.external_id` only |
| `start_time` | GarminDB | Garmin device timestamp is more precise |
| `duration` | GarminDB | Garmin elapsed/moving time from FIT file |
| `distance` | GarminDB | Garmin GPS distance |
| `avg_hr`, `max_hr` | GarminDB | Garmin device HR is primary |
| `avg_pace`, `avg_cadence` | GarminDB | Garmin device data |
| `ascent`, `descent` | GarminDB | Garmin barometric altimeter |
| `active_load` (TSS) | GarminDB | Garmin's `active_load` from FIT file |
| `normalized_power` | Intervals.icu | Garmin rarely populates NP; Intervals.icu calculates it if power stream present |
| `local_timezone` | GarminDB if non-NULL, else Intervals.icu | GarminDB derives from GPS; Intervals.icu `tz` field is a fallback |
| `start_lat`, `start_lng` | GarminDB | GPS from device |
| `source_platform` | `'garmin'` | Canonical row remains GarminDB-attributed |

**Merge action for a detected duplicate:**
1. Do NOT upsert the Intervals.icu data as a new `garmin_activities` row.
2. If `normalized_power` from Intervals.icu is non-NULL and the existing GarminDB row has `normalized_power IS NULL`: update the existing row with the Intervals.icu NP value.
3. If `local_timezone` from Intervals.icu is non-NULL and the existing row has `local_timezone IS NULL`: update with the Intervals.icu timezone.
4. Insert a row into `activity_sources` with `is_preferred = false` (see 3.3.3).

**No-duplicate path (Intervals.icu activity not in GarminDB):**
- Insert the Intervals.icu activity as a new row in `garmin_activities` with `source_platform = 'intervals_icu'`.
- Insert a row into `activity_sources` with `is_preferred = true`.

#### 3.3.3 activity_sources Population

`activity_sources` is populated for every ingested activity, from both pipelines.

**GarminDB path** (on initial activity insert or backfill):
```python
supabase.table("activity_sources").upsert({
    "canonical_activity_id": garmin_activity_id,
    "source_platform": "garmin",
    "external_id": garmin_activity_id,
    "start_time": start_time_utc,
    "sport_type": sport_type,
    "is_preferred": True,
}, on_conflict="source_platform,external_id").execute()
```

**Intervals.icu path — duplicate detected:**
```python
supabase.table("activity_sources").upsert({
    "canonical_activity_id": canonical_activity_id,  # existing GarminDB ID
    "source_platform": "intervals_icu",
    "external_id": f"icu_{intervals_activity_id}",
    "start_time": start_time_utc,
    "sport_type": sport_type,
    "is_preferred": False,
}, on_conflict="source_platform,external_id").execute()
```

**Intervals.icu path — no duplicate (new activity):**
```python
new_id = f"icu_{intervals_activity_id}"
# Insert garmin_activities row first
supabase.table("garmin_activities").upsert({
    "activity_id": new_id,
    "source_platform": "intervals_icu",
    ...
}).execute()
# Then insert activity_sources
supabase.table("activity_sources").upsert({
    "canonical_activity_id": new_id,
    "source_platform": "intervals_icu",
    "external_id": new_id,
    "start_time": start_time_utc,
    "sport_type": sport_type,
    "is_preferred": True,
}, on_conflict="source_platform,external_id").execute()
```

---

## 4. Ticket Breakdown

### ING-001: Schema Migrations (SQL only)

**Title:** Create activity_sources, activity_streams, daily_health tables; add columns to garmin_activities and athletes

**Files to create:**
- `sql/activity_sources.sql`
- `sql/activity_streams.sql`
- `sql/daily_health.sql`
- `sql/garmin_activities_ingestion.sql`  — ALTER TABLE additions for source_platform, normalized_power, local_timezone
- `sql/athletes_profile.sql`  — ALTER TABLE additions for FTP, zones, streams flag

**Files to modify:**
- None

**Acceptance Criteria:**
1. Running all five SQL files against Supabase creates the tables and adds all columns without error.
2. All migrations are idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
3. `activity_sources`: has columns `id`, `canonical_activity_id`, `source_platform`, `external_id`, `start_time`, `sport_type`, `is_preferred`, `raw_data_ref`, `created_at`. UNIQUE on `(source_platform, external_id)`. `canonical_activity_id` FK references `garmin_activities(activity_id)`.
4. `activity_streams`: has all columns listed in Section 2.1.2. UNIQUE on `(activity_id, timestamp)`. `activity_id` FK references `garmin_activities(activity_id)`.
5. `daily_health`: has all columns listed in Section 2.1.3. UNIQUE on `(athlete_id, date)`. `athlete_id` FK references `athletes(id)`.
6. `garmin_activities` gains `source_platform` (TEXT NOT NULL DEFAULT 'garmin'), `normalized_power` (FLOAT), `local_timezone` (TEXT).
7. Existing `garmin_activities` rows are backfilled with `source_platform = 'garmin'`.
8. `athletes` gains `ftp_cycling`, `threshold_pace_sec_per_km`, `max_hr`, `resting_hr_baseline`, `hr_zones`, `pace_zones`, `power_zones`, `activity_streams_enabled`.

**Dependencies:** `daily_pmc_values.sql` must have run (provides `athletes` table and placeholder row).

---

### ING-002: Intervals.icu Sync Adapter — Activity Ingestion

**Title:** Implement Intervals.icu activity fetch, deduplication, and upsert pipeline

**Files to create:**
- `sync/intervals_adapter.py`

**Files to modify:**
- `sync_server.py` — add `POST /sync/intervals` endpoint
- `lib/syncApi.ts` — add `triggerIntervalsSync()` function
- `.env.example` — add `INTERVALS_ICU_ATHLETE_ID`, `INTERVALS_ICU_API_KEY`

**Acceptance Criteria:**
1. `POST /sync/intervals` with no body fetches the last 365 days of activities from Intervals.icu.
2. A response of `{ ok: true, activities_upserted: N }` is returned; N is the count of inserted or updated rows.
3. For an Intervals.icu activity that matches a GarminDB activity (start_time ±5 min, same sport_type): no new `garmin_activities` row is created; an `activity_sources` row is inserted with `is_preferred = false`.
4. For an Intervals.icu activity with no GarminDB match: a new `garmin_activities` row is inserted with `source_platform = 'intervals_icu'`; an `activity_sources` row is inserted with `is_preferred = true`.
5. Running the sync twice does not produce duplicate rows (upsert idempotency).
6. Zwift activities (Intervals.icu `source = 'ZWIFT'`) are stored with `start_lat = NULL`, `start_lng = NULL`.
7. `triggerIntervalsSync()` in TypeScript hits `POST /sync/intervals` and returns the parsed JSON response.
8. Missing env vars (`INTERVALS_ICU_ATHLETE_ID`, `INTERVALS_ICU_API_KEY`) cause the endpoint to return `{ ok: false, error: 'Missing Intervals.icu credentials' }` rather than a 500.

**Dependencies:** ING-001 (requires schema columns to exist before upsert).

---

### ING-003: Wellness Sync (daily_health population from Intervals.icu)

**Title:** Implement Intervals.icu wellness fetch and daily_health upsert pipeline

**Files to modify:**
- `sync/intervals_adapter.py` — add `fetch_wellness()`, `upsert_wellness()`
- `sync_server.py` — extend `/sync/intervals` to call wellness sync in addition to activity sync

**Acceptance Criteria:**
1. `POST /sync/intervals` also fetches wellness data and upserts to `daily_health`.
2. Response includes `wellness_upserted` count.
3. A day where a GarminDB row already exists: the upsert updates `hrv_rmssd`, `hrv_status`, `weight_kg`, `spo2_pct` from Intervals.icu data (non-NULL values only) and sets `source_platform = 'merged'`.
4. A day with no existing row: a new `daily_health` row is inserted with `source_platform = 'intervals_icu'`. Sleep breakdown columns (`sleep_deep_min`, etc.) are NULL.
5. `sleep_total_min` is populated from `sleepSecs / 60` (integer), rounded down.
6. Running the wellness sync twice does not produce duplicate rows.
7. If `hrv_status` from Intervals.icu is outside 1–5: the value is stored as NULL (DB constraint guard).

**Dependencies:** ING-001 (requires `daily_health` table), ING-002 (shares `intervals_adapter.py` module).

---

### ING-004: GarminDB Pipeline Extension (local_timezone + daily_health)

**Title:** Extend GarminDB sync to populate local_timezone on activities and daily_health from monitoring data

**Files to modify:**
- `sync_server.py` (or a new `sync/garmin_adapter.py` module) — extend GarminDB sync to populate new columns

**Acceptance Criteria:**
1. After sync, all newly-ingested `garmin_activities` rows have `local_timezone` set to a valid IANA timezone string (e.g., `'America/New_York'`). Rows where GPS coordinates are absent (indoor activities) have `local_timezone = NULL`.
2. After sync, new rows are inserted into `daily_health` with resting HR, sleep totals (including deep/light/REM/awake breakdown), body weight, SpO2, and stress score where available from GarminDB monitoring tables.
3. Missing health fields are stored as NULL (never as 0).
4. Running the sync twice is idempotent (upsert on `athlete_id, date`).
5. The `source_platform` on GarminDB-inserted `daily_health` rows is `'garmin'`.

**Dependencies:** ING-001 (requires `daily_health` table and `local_timezone` column on `garmin_activities`).

---

### ING-005: activity_sources Backfill for Existing GarminDB Activities

**Title:** Backfill activity_sources for all existing garmin_activities rows

**Files to create:**
- `sql/activity_sources_backfill.sql` — one-time backfill migration

**Acceptance Criteria:**
1. After running the migration, every row in `garmin_activities` with `source_platform = 'garmin'` has a corresponding row in `activity_sources` with `source_platform = 'garmin'` and `is_preferred = true`.
2. No duplicate `activity_sources` rows are created if the migration is re-run (INSERT ... ON CONFLICT DO NOTHING).
3. `external_id` in `activity_sources` equals `activity_id` from `garmin_activities` for GarminDB rows.
4. Row count in `activity_sources` after migration equals the number of `garmin_activities` rows with `source_platform = 'garmin'`.

**Dependencies:** ING-001 (requires `activity_sources` table to exist).

---

## 5. Technical Decisions Log

### TD-001: Separate /sync/intervals endpoint vs. extending /sync

**Decision:** Add `POST /sync/intervals` as a new endpoint rather than extending the existing `POST /sync`.

**Rationale:** GarminDB sync requires a local GarminDB installation and runs differently from Intervals.icu (which is a remote HTTP call). Keeping them as separate endpoints allows independent triggering (e.g., run Intervals.icu sync more frequently without re-running the slow local GarminDB process), independent error handling, and independent scheduling. The two endpoints can be composed by a caller that wants both.

**Impact on syncApi.ts:** A new `triggerIntervalsSync()` function is added alongside the existing `triggerSync()`. Both are exported and independently callable.

---

### TD-002: activity_id prefix for Intervals.icu activities

**Decision:** Intervals.icu activity IDs are stored in `garmin_activities.activity_id` with a `"icu_"` prefix (e.g., `"icu_A12345678"`).

**Rationale:** `garmin_activities.activity_id` is TEXT and has no format constraint. Without a prefix, an Intervals.icu numeric ID could theoretically collide with a Garmin numeric ID. The prefix makes the source unambiguous from the ID alone, without requiring a schema change or a separate table for non-Garmin activities.

---

### TD-003: GarminDB is canonical when both sources have the same activity

**Decision:** When the deduplication query finds a match, the GarminDB row is preserved as-is (except for `normalized_power` and `local_timezone` fill-in). The Intervals.icu version is recorded only in `activity_sources` with `is_preferred = false`.

**Rationale:** GarminDB reads data directly from the Garmin FIT file, which is the ground-truth record from the device. Intervals.icu re-processes this data and may apply its own smoothing or rounding. The FIT-file-derived values are more precise and should be canonical. The exception for `normalized_power` is because GarminDB rarely exposes NP in its schema and Intervals.icu calculates it from the power stream.

---

### TD-004: activity_streams population gated by athlete flag

**Decision:** Per-second stream population to `activity_streams` is controlled by `athletes.activity_streams_enabled` (BOOLEAN, default false). The Intervals.icu adapter checks this flag before calling the streams endpoint.

**Rationale:** The Intervals.icu streams endpoint (`GET /athlete/{id}/activities/{id}/streams`) returns per-second data for each activity. At ~150 MB for 500 activities, population should be opt-in. Gating on a per-athlete flag in the database (rather than a hardcoded constant or env var) allows it to be enabled per-athlete without a code deployment. When the flag is false, the adapter fetches only activity summary data.

**Intervals.icu streams endpoint (for reference, not implemented in Section 1):**
```
GET /athlete/{id}/activities/{activity_id}/streams
```
Returns a JSON array of per-second records with fields: `time`, `heartrate`, `watts`, `cadence`, `altitude`, `distance`, `velocity_smooth`, `lat`, `lng`.

---

### TD-005: daily_health merge strategy for dual-source days

**Decision:** When both GarminDB and Intervals.icu have data for the same date, the upsert sets `source_platform = 'merged'` and updates only the Intervals.icu-exclusive fields (hrv_rmssd, hrv_status, weight_kg, spo2_pct) from Intervals.icu. Sleep stage breakdown comes from GarminDB only.

**Rationale:** GarminDB has superior sleep stage granularity (deep/light/REM breakdown) because it reads Garmin's proprietary sleep algorithm output from the monitoring database. Intervals.icu only exposes total sleep in the wellness API. For fields present in both sources, GarminDB wins. For fields only in Intervals.icu (HRV RMSSD in ms where Garmin doesn't export it, weight, SpO2), Intervals.icu fills in NULL gaps.

---

### TD-006: activity_streams deferred population trigger condition

**Decision:** Stream population for `activity_streams` is deferred and enabled by setting `athletes.activity_streams_enabled = true`. This flag is the sole gate; no time-based or activity-count-based trigger is defined. The actual stream-fetch-and-upsert code is implemented in ING-002 but guarded by the flag check.

**Rationale:** The PRD states population is deferred until "explicit sync decisions are made." Making the trigger an athlete-record flag rather than a code constant means the system is ready to start populating streams on demand without a new deployment. The specific analytics sections that will consume streams (Sections 9, 10) will document any additional preconditions.

---

## 6. Open Items / Deferred Scope

| Item | Status | Future ticket |
|---|---|---|
| Weather backfill for outdoor activities (Open-Meteo API) | Out of scope for Section 1; `activity_weather` table already exists | Future |
| Strava, Wahoo adapter implementations | `source_platform` CHECK constraint includes them; adapters deferred | Future |
| Per-second stream population (`activity_streams`) | Schema created; population deferred behind flag | Future (Sections 9, 10) |
| Manual entry UI for activities | Schema supports it (`source_platform = 'manual'`); no adapter needed | Future |
| Reverse-geocode for `local_timezone` (GarminDB path) | Recommended via `timezonefinder` library; implementation detail left to ING-004 | ING-004 |
| GarminDB `normalized_power` from FIT session record | Pass-through if available; device-specific field availability to be confirmed | ING-004 |
