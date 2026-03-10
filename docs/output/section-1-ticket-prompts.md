# Section 1 Ticket Prompts: Data Ingestion & Storage Architecture

**Section:** 1
**Author:** Prompt Engineer
**Date:** 2026-03-10
**Source TDD:** `docs/output/section-1-tech-design.md`

These prompts correspond to ING-001 through ING-005. Each ticket section is self-contained and verbatim-ready for the Staff Engineer Lead. The Program Manager passes the entire `## Ticket N` section to the Lead without modification.

---

## Ticket 1

### Ticket ID and Title

**ING-001: Schema Migrations**
Create `activity_sources`, `activity_streams`, `daily_health` tables; add columns to `garmin_activities` and `athletes`.

### Context

This ticket establishes the full database schema for the Section 1 Data Ingestion & Storage Architecture. It is SQL-only — no Python or TypeScript changes. All subsequent ING tickets depend on these schema objects existing before any upsert logic runs.

The existing `athletes` table is created by `sql/daily_pmc_values.sql` (which must have run first). The existing `garmin_activities` table is the canonical activity store — it is extended here, not replaced.

All migrations must be idempotent. Follow the established patterns in `sql/daily_pmc_values.sql` (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) and `sql/race_detection.sql` (ALTER TABLE with IF NOT EXISTS, backfill UPDATE, NOTIFY pgrst).

### Files to Create

- `sql/activity_sources.sql`
- `sql/activity_streams.sql`
- `sql/daily_health.sql`
- `sql/garmin_activities_ingestion.sql`
- `sql/athletes_profile.sql`

### Files to Modify

None.

### Exact Implementation

**`sql/activity_sources.sql`**

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

**`sql/activity_streams.sql`**

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

**`sql/daily_health.sql`**

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

**`sql/garmin_activities_ingestion.sql`**

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

**`sql/athletes_profile.sql`**

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

**Zone JSONB shape reference (for `hr_zones`, `pace_zones`, `power_zones`):**
```json
{
  "z1": { "min": 0, "max": 115 },
  "z2": { "min": 115, "max": 152 },
  "z3": { "min": 152, "max": 171 },
  "z4": { "min": 171, "max": 190 },
  "z5": { "min": 190, "max": 999 }
}
```

### Acceptance Criteria

1. Running all five SQL files against Supabase creates the tables and adds all columns without error.
2. All migrations are idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
3. `activity_sources`: has columns `id`, `canonical_activity_id`, `source_platform`, `external_id`, `start_time`, `sport_type`, `is_preferred`, `raw_data_ref`, `created_at`. UNIQUE on `(source_platform, external_id)`. `canonical_activity_id` FK references `garmin_activities(activity_id)`.
4. `activity_streams`: has all columns listed above (`id`, `activity_id`, `timestamp`, `hr`, `pace_sec_per_km`, `power_watts`, `cadence`, `elevation_m`, `lat`, `lng`, `gct_ms`, `vertical_osc_cm`, `temperature_c`). UNIQUE on `(activity_id, timestamp)`. `activity_id` FK references `garmin_activities(activity_id)`.
5. `daily_health`: has all columns listed above (`id`, `athlete_id`, `date`, `source_platform`, `resting_hr`, `hrv_rmssd`, `hrv_status`, `sleep_total_min`, `sleep_deep_min`, `sleep_light_min`, `sleep_rem_min`, `sleep_awake_min`, `weight_kg`, `spo2_pct`, `stress_score`, `created_at`). UNIQUE on `(athlete_id, date)`. `athlete_id` FK references `athletes(id)`.
6. `garmin_activities` gains `source_platform` (TEXT NOT NULL DEFAULT 'garmin'), `normalized_power` (FLOAT), `local_timezone` (TEXT).
7. Existing `garmin_activities` rows are backfilled with `source_platform = 'garmin'`.
8. `athletes` gains `ftp_cycling`, `threshold_pace_sec_per_km`, `max_hr`, `resting_hr_baseline`, `hr_zones`, `pace_zones`, `power_zones`, `activity_streams_enabled`.

### Dependencies

`sql/daily_pmc_values.sql` must have been run first (provides the `athletes` table and its placeholder row, and the `garmin_activities` table must already exist in the project).

---

## Ticket 2

### Ticket ID and Title

**ING-002: Intervals.icu Activity Sync**
Implement Intervals.icu activity fetch, deduplication, and upsert pipeline.

### Context

This ticket creates the Intervals.icu sync adapter and wires it into the sync server. It implements the full activity ingestion pipeline: fetch from the Intervals.icu REST API, run two-stage deduplication against `activity_sources` and `garmin_activities`, upsert to `garmin_activities`, and record all source provenance in `activity_sources`.

Key architectural decisions already made:
- A dedicated `POST /sync/intervals` endpoint is used (not an extension of `POST /sync`) to allow independent triggering of GarminDB vs. Intervals.icu sync.
- Intervals.icu activity IDs are stored with an `"icu_"` prefix in `garmin_activities.activity_id` to prevent collision with Garmin device IDs.
- GarminDB is canonical: when the same activity exists in both sources, the GarminDB row is preserved as-is (except `normalized_power` and `local_timezone` fill-in). The Intervals.icu version is recorded in `activity_sources` only.
- `sync_server.py` binds to `127.0.0.1:5001` and is a localhost-only personal sync server. HTTP Basic Auth reading from environment variables is the correct and sufficient security model here.

The existing `lib/syncApi.ts` exports `triggerSync()` (for GarminDB). This ticket adds `triggerIntervalsSync()` alongside it without modifying the existing function.

### Files to Create

- `sync/intervals_adapter.py`

### Files to Modify

- `sync_server.py` — add `POST /sync/intervals` endpoint
- `lib/syncApi.ts` — add `triggerIntervalsSync()` function
- `.env.example` — add `INTERVALS_ICU_ATHLETE_ID` and `INTERVALS_ICU_API_KEY`

### Exact Implementation

**`sync/intervals_adapter.py` — Authentication and HTTP client**

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

**`sync/intervals_adapter.py` — Activity fetch**

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

**Intervals.icu activity response shape (key fields used):**

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

**Field mapping from Intervals.icu response to `garmin_activities` columns:**

| Intervals.icu field | garmin_activities column | Transformation |
|---|---|---|
| `id` | `activity_id` | Prefix with `"icu_"` → `"icu_A12345678"` |
| `type` | `sport_type` | Direct mapping |
| `start_date_local` + `tz` | `start_time` | Convert to UTC using `tz` field |
| `tz` | `local_timezone` | IANA string direct |
| `distance` | `distance` | metres, direct |
| `moving_time` | `duration` | seconds, direct |
| `total_elevation_gain` | `ascent` | metres, direct |
| `total_elevation_loss` | `descent` | metres, direct |
| `average_heartrate` | `avg_hr` | bpm, direct |
| `max_heartrate` | `max_hr` | bpm, direct |
| `average_speed` | `avg_pace` | Convert m/s → sec/km: `1000 / speed` |
| `average_cadence` | `avg_cadence` | spm or rpm, direct |
| `normalized_power` | `normalized_power` | watts; NULL for non-power activities |
| `icu_training_load` | `active_load` | Intervals.icu TSS equivalent |
| `start_latlng[0]` | `start_lat` | NULL if `start_latlng` absent (indoor/Zwift) |
| `start_latlng[1]` | `start_lng` | NULL if `start_latlng` absent |
| `"intervals_icu"` | `source_platform` | Hardcoded string |

**Zwift-specific handling:** When `source == "ZWIFT"` in the Intervals.icu response, `start_latlng` will be absent or null — store `start_lat = NULL`, `start_lng = NULL`.

**`sync/intervals_adapter.py` — Two-stage deduplication**

Stage 1 — External ID pre-check (idempotency guard). Check whether `activity_sources` already has a row for this Intervals.icu external ID. If yes, the activity was already processed on a previous sync run — skip it. This is the fast path.

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

Stage 2 — Time-window + sport_type match (cross-source duplicate detection). Only reached if Stage 1 returns False. Checks whether a GarminDB activity exists within ±5 minutes with the same sport type.

SQL executed:
```sql
SELECT activity_id, source_platform
FROM garmin_activities
WHERE sport_type = :sport_type
  AND start_time BETWEEN (:start_time::timestamptz - INTERVAL '5 minutes')
                     AND (:start_time::timestamptz + INTERVAL '5 minutes')
LIMIT 1;
```

Python implementation:
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

**`sync/intervals_adapter.py` — Merge rules when duplicate detected**

When `find_duplicate()` returns a canonical GarminDB activity ID:

1. Do NOT upsert the Intervals.icu data as a new `garmin_activities` row.
2. If `normalized_power` from Intervals.icu is non-NULL and the existing GarminDB row has `normalized_power IS NULL`: update the existing row's `normalized_power` with the Intervals.icu value.
3. If `local_timezone` from Intervals.icu is non-NULL and the existing row has `local_timezone IS NULL`: update the existing row's `local_timezone` with the Intervals.icu value.
4. Insert a row into `activity_sources` with `is_preferred = false`:

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

**`sync/intervals_adapter.py` — No-duplicate path (new activity, not in GarminDB)**

When `find_duplicate()` returns None:

```python
new_id = f"icu_{intervals_activity_id}"
# Insert garmin_activities row first
supabase.table("garmin_activities").upsert({
    "activity_id": new_id,
    "source_platform": "intervals_icu",
    ...  # all mapped fields per the field mapping table above
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

**`sync/intervals_adapter.py` — `upsert_activities()` return value**

`upsert_activities(activities: list[dict]) -> dict` must return `{"count": N}` where N is the number of rows inserted or updated in `garmin_activities`.

**`sync_server.py` — New `POST /sync/intervals` endpoint**

Add this route to `sync_server.py`. The server already binds to `127.0.0.1:5001`. The helper functions `_default_oldest()` (returns ISO date string 365 days ago) and `_today_iso()` (returns today's ISO date string) must be implemented or already exist.

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

Note: Missing env vars (`INTERVALS_ICU_ATHLETE_ID`, `INTERVALS_ICU_API_KEY`) must return `{"ok": false, "error": "Missing Intervals.icu credentials"}` rather than a 500. Add a guard at module load time or at the top of `sync_intervals()` that checks for these vars and returns the structured error response if absent.

**`lib/syncApi.ts` — Add `triggerIntervalsSync()`**

Add the following function to `lib/syncApi.ts`. Do not modify the existing `SYNC_SERVER_URL` constant or `triggerSync()` function.

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

**`.env.example` — Add Intervals.icu credentials**

Add these two lines to `.env.example` alongside the existing Supabase keys:

```
INTERVALS_ICU_ATHLETE_ID=i12345
INTERVALS_ICU_API_KEY=your_api_key_here
```

### Acceptance Criteria

1. `POST /sync/intervals` with no body fetches the last 365 days of activities from Intervals.icu.
2. A response of `{ ok: true, activities_upserted: N }` is returned; N is the count of inserted or updated rows.
3. For an Intervals.icu activity that matches a GarminDB activity (start_time ±5 min, same sport_type): no new `garmin_activities` row is created; an `activity_sources` row is inserted with `is_preferred = false`.
4. For an Intervals.icu activity with no GarminDB match: a new `garmin_activities` row is inserted with `source_platform = 'intervals_icu'`; an `activity_sources` row is inserted with `is_preferred = true`.
5. Running the sync twice does not produce duplicate rows (upsert idempotency via Stage 1 external ID pre-check).
6. Zwift activities (Intervals.icu `source = 'ZWIFT'`) are stored with `start_lat = NULL`, `start_lng = NULL`.
7. `triggerIntervalsSync()` in TypeScript hits `POST /sync/intervals` and returns the parsed JSON response.
8. Missing env vars (`INTERVALS_ICU_ATHLETE_ID`, `INTERVALS_ICU_API_KEY`) cause the endpoint to return `{ ok: false, error: 'Missing Intervals.icu credentials' }` rather than a 500.

### Dependencies

ING-001 must be complete (requires `activity_sources` table, `garmin_activities.source_platform`, `garmin_activities.normalized_power`, `garmin_activities.local_timezone`, and `athletes.activity_streams_enabled` column to exist before any upsert).

---

## Ticket 3

### Ticket ID and Title

**ING-003: Intervals.icu Wellness Sync**
Implement Intervals.icu wellness fetch and `daily_health` upsert pipeline.

### Context

This ticket extends `sync/intervals_adapter.py` (created in ING-002) with wellness data ingestion. It adds `fetch_wellness()` and `upsert_wellness()` functions to the adapter, and the `POST /sync/intervals` endpoint (added in ING-002) is already written to call both activity and wellness sync together — `well_result = upsert_wellness(wellness)` is already in the endpoint body.

The `daily_health` table was created in ING-001. The upsert strategy is a partial-update merge: if a GarminDB row already exists for a date, only the Intervals.icu-exclusive non-NULL fields are updated and `source_platform` is set to `'merged'`. If no row exists, a full insert is performed with `source_platform = 'intervals_icu'`.

Intervals.icu does not expose sleep stage breakdown (deep/light/REM/awake) — those columns are NULL for Intervals.icu-sourced rows. GarminDB is the source for sleep stage breakdown (populated in ING-004).

### Files to Create

None.

### Files to Modify

- `sync/intervals_adapter.py` — add `fetch_wellness()` and `upsert_wellness()`
- `sync_server.py` — the `POST /sync/intervals` endpoint added in ING-002 already calls `upsert_wellness(wellness)`; no endpoint change required unless `fetch_wellness` or `upsert_wellness` are not yet imported

### Exact Implementation

**`sync/intervals_adapter.py` — `fetch_wellness()`**

```python
def fetch_wellness(oldest_date: str, newest_date: str) -> list[dict]:
    params = {"oldest": oldest_date, "newest": newest_date}
    return _get("wellness", params=params)
```

**Intervals.icu wellness response shape (per day, key fields used):**

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
  "sportInfo": [],
  "weight": 72.5,
  "spO2": 97.1,
  "mentalLoad": null
}
```

**Field mapping from Intervals.icu wellness response to `daily_health` columns:**

| Intervals.icu field | daily_health column | Transformation |
|---|---|---|
| `id` (date string) | `date` | ISO date, direct |
| `restingHR` | `resting_hr` | bpm; NULL if absent |
| `hrv` | `hrv_rmssd` | RMSSD in ms; NULL if absent |
| `hrvScore` | `hrv_status` | Garmin 1–5 scale proxy; NULL if absent or outside 1–5 |
| `sleepSecs` / 60 | `sleep_total_min` | Convert seconds → minutes (integer, floor); NULL if `sleepSecs` absent |
| `weight` | `weight_kg` | kg; NULL if absent |
| `spO2` | `spo2_pct` | percentage; NULL if absent |
| `"intervals_icu"` | `source_platform` | Hardcoded; set to `'merged'` if a GarminDB row already exists for that date |

Sleep breakdown columns (`sleep_deep_min`, `sleep_light_min`, `sleep_rem_min`, `sleep_awake_min`) are always NULL for Intervals.icu-sourced rows — Intervals.icu does not expose this data.

**`sync/intervals_adapter.py` — `upsert_wellness()`**

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

`upsert_wellness(wellness: list[dict]) -> dict` must return `{"count": N}` where N is the number of rows inserted or updated in `daily_health`.

**`hrv_status` guard:** Before passing `hrvScore` to the upsert, apply a guard:
```python
hrv_status_raw = day.get("hrvScore")
hrv_status = hrv_status_raw if hrv_status_raw is not None and 1 <= hrv_status_raw <= 5 else None
```

**Merge strategy for `source_platform`:** The upsert above always passes `"intervals_icu"` for `source_platform`. When a GarminDB row already exists for that date, the Supabase upsert's `ON CONFLICT` behavior will overwrite `source_platform` with `"intervals_icu"`. To correctly set `source_platform = 'merged'` when a GarminDB row pre-exists, the `upsert_wellness` function must check for an existing row before upserting:

```python
def upsert_wellness(wellness: list[dict]) -> dict:
    count = 0
    for day in wellness:
        # Check if a GarminDB row already exists for this date
        existing = (
            supabase.table("daily_health")
            .select("source_platform")
            .eq("athlete_id", ATHLETE_ID)
            .eq("date", day["id"])
            .limit(1)
            .execute()
        )
        existing_rows = existing.data
        platform = "merged" if existing_rows and existing_rows[0]["source_platform"] == "garmin" else "intervals_icu"

        hrv_status_raw = day.get("hrvScore")
        hrv_status = hrv_status_raw if hrv_status_raw is not None and 1 <= hrv_status_raw <= 5 else None

        supabase.table("daily_health").upsert({
            "athlete_id": ATHLETE_ID,
            "date": day["id"],
            "resting_hr": day.get("restingHR"),
            "hrv_rmssd": day.get("hrv"),
            "hrv_status": hrv_status,
            "sleep_total_min": int(day["sleepSecs"] / 60) if day.get("sleepSecs") is not None else None,
            "weight_kg": day.get("weight"),
            "spo2_pct": day.get("spO2"),
            "source_platform": platform,
        }, on_conflict="athlete_id,date").execute()
        count += 1
    return {"count": count}
```

### Acceptance Criteria

1. `POST /sync/intervals` also fetches wellness data and upserts to `daily_health`.
2. Response includes `wellness_upserted` count.
3. A day where a GarminDB row already exists: the upsert updates `hrv_rmssd`, `hrv_status`, `weight_kg`, `spo2_pct` from Intervals.icu data (non-NULL values only) and sets `source_platform = 'merged'`.
4. A day with no existing row: a new `daily_health` row is inserted with `source_platform = 'intervals_icu'`. Sleep breakdown columns (`sleep_deep_min`, `sleep_light_min`, `sleep_rem_min`, `sleep_awake_min`) are NULL.
5. `sleep_total_min` is populated from `sleepSecs / 60` (integer), rounded down.
6. Running the wellness sync twice does not produce duplicate rows.
7. If `hrv_status` from Intervals.icu is outside 1–5: the value is stored as NULL (DB constraint guard applied in Python before upsert).

### Dependencies

ING-001 (requires `daily_health` table to exist). ING-002 (shares `sync/intervals_adapter.py` — `_get()`, `_auth`, `ATHLETE_ID`, and the supabase client must already be initialized in that module).

---

## Ticket 4

### Ticket ID and Title

**ING-004: GarminDB Pipeline Extension**
Extend GarminDB sync to populate `local_timezone` on activities and `daily_health` from GarminDB monitoring data.

### Context

This ticket extends the existing GarminDB sync pipeline. The existing Python sync (`sync_server.py` or a dedicated `sync/garmin_adapter.py`) writes activity records to `garmin_activities`. Two new behaviors are added:

1. **`local_timezone` population:** For each activity with GPS coordinates, derive the IANA timezone string from the GPS coordinates using the `timezonefinder` Python library and store it in `garmin_activities.local_timezone`. For indoor activities without GPS, `local_timezone` remains NULL.

2. **`daily_health` population from GarminDB monitoring tables:** After processing activities, read daily wellness metrics from GarminDB's monitoring database tables (`monitoring_hr`, `sleep`, `body_composition`) and upsert into `daily_health` with `source_platform = 'garmin'`.

`local_timezone` and `daily_health` columns were added in ING-001. The `daily_health` table's UNIQUE constraint is `(athlete_id, date)` — use upsert on that key. Missing health fields must be stored as NULL, never as 0.

The implementation may live in `sync_server.py` directly or be extracted to a new `sync/garmin_adapter.py` module — either is acceptable. Follow the existing code style of the file being modified.

### Files to Create

- `sync/garmin_adapter.py` (new module, if the Lead chooses to extract the logic; otherwise extend `sync_server.py` directly)

### Files to Modify

- `sync_server.py` — extend GarminDB sync path to call `local_timezone` derivation and `daily_health` upsert
- (optionally) `sync/garmin_adapter.py` if extracted as a module

### Exact Implementation

**`local_timezone` derivation using `timezonefinder`**

Install dependency (add to `requirements.txt` or equivalent):
```
timezonefinder
```

```python
from timezonefinder import TimezoneFinder

_tf = TimezoneFinder()

def get_local_timezone(lat: float | None, lng: float | None) -> str | None:
    """Returns IANA timezone string for the given coordinates, or None if coordinates absent."""
    if lat is None or lng is None:
        return None
    return _tf.timezone_at(lat=lat, lng=lng)
```

Call `get_local_timezone(start_lat, start_lng)` for each activity being written to `garmin_activities` and set `local_timezone` on the row. If the function returns None (coordinates absent or unrecognized), store `local_timezone = NULL`.

**GarminDB monitoring tables — field sources for `daily_health`**

Read from GarminDB's monitoring database. The following fields are sourced per the TDD:

| GarminDB table/field | daily_health column | Notes |
|---|---|---|
| `monitoring_hr` — resting HR for the day | `resting_hr` | bpm; NULL if not available |
| HRV RMSSD (if exported by device) | `hrv_rmssd` | ms; NULL if device does not export |
| Garmin HRV status (1–5) | `hrv_status` | NULL if not available |
| `sleep` — total sleep duration | `sleep_total_min` | Convert to minutes |
| `sleep` — deep sleep | `sleep_deep_min` | minutes; NULL if not available |
| `sleep` — light sleep | `sleep_light_min` | minutes; NULL if not available |
| `sleep` — REM sleep | `sleep_rem_min` | minutes; NULL if not available |
| `sleep` — awake time | `sleep_awake_min` | minutes; NULL if not available |
| `body_composition` — weight | `weight_kg` | kg; NULL if not available |
| SpO2 monitoring | `spo2_pct` | percentage; NULL if not available |
| Body Battery / stress score | `stress_score` | integer; NULL if not available |

**`daily_health` upsert from GarminDB (Python)**

```python
supabase.table("daily_health").upsert({
    "athlete_id": ATHLETE_UUID,   # the fixed athlete UUID (e.g. '00000000-0000-0000-0000-000000000001')
    "date": date_str,             # ISO date string, e.g. "2025-06-15"
    "source_platform": "garmin",
    "resting_hr": resting_hr,     # int or None
    "hrv_rmssd": hrv_rmssd,       # float or None
    "hrv_status": hrv_status,     # int 1–5 or None
    "sleep_total_min": sleep_total_min,
    "sleep_deep_min": sleep_deep_min,
    "sleep_light_min": sleep_light_min,
    "sleep_rem_min": sleep_rem_min,
    "sleep_awake_min": sleep_awake_min,
    "weight_kg": weight_kg,
    "spo2_pct": spo2_pct,
    "stress_score": stress_score,
}, on_conflict="athlete_id,date").execute()
```

All values must be Python `None` (not `0`) when the metric is unavailable.

### Acceptance Criteria

1. After sync, all newly-ingested `garmin_activities` rows have `local_timezone` set to a valid IANA timezone string (e.g., `'America/New_York'`). Rows where GPS coordinates are absent (indoor activities) have `local_timezone = NULL`.
2. After sync, new rows are inserted into `daily_health` with resting HR, sleep totals (including deep/light/REM/awake breakdown), body weight, SpO2, and stress score where available from GarminDB monitoring tables.
3. Missing health fields are stored as NULL (never as 0).
4. Running the sync twice is idempotent (upsert on `athlete_id, date`).
5. The `source_platform` on GarminDB-inserted `daily_health` rows is `'garmin'`.

### Dependencies

ING-001 must be complete (requires `daily_health` table and `local_timezone` column on `garmin_activities` to exist before upsert).

---

## Ticket 5

### Ticket ID and Title

**ING-005: activity_sources Backfill for Existing GarminDB Activities**
Backfill `activity_sources` for all existing `garmin_activities` rows.

### Context

The `activity_sources` table was created in ING-001. Going forward, the GarminDB and Intervals.icu sync pipelines populate it on every new activity insert. However, all pre-existing `garmin_activities` rows written before ING-001 have no corresponding `activity_sources` row.

This ticket creates a one-time SQL backfill migration that inserts a row into `activity_sources` for every existing `garmin_activities` row where `source_platform = 'garmin'`. Each backfilled row gets `is_preferred = true` and `external_id = activity_id` (the GarminDB row's own activity ID is its external ID).

The migration must be safe to re-run: use `INSERT ... ON CONFLICT DO NOTHING` on the `(source_platform, external_id)` unique constraint.

### Files to Create

- `sql/activity_sources_backfill.sql`

### Files to Modify

None.

### Exact Implementation

**`sql/activity_sources_backfill.sql`**

```sql
-- ING-005: activity_sources backfill for existing GarminDB activities
--
-- Inserts a row into activity_sources for every garmin_activities row
-- that has source_platform = 'garmin' and no existing activity_sources row.
--
-- is_preferred = true: GarminDB rows are always the canonical/preferred version.
-- external_id = activity_id: for GarminDB activities, the external ID is the activity's own ID.
--
-- Safe to re-run: ON CONFLICT DO NOTHING on (source_platform, external_id).
-- Prerequisites: ING-001 must have run (activity_sources table must exist).

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
    ga.sport_type        AS sport_type,
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

-- Verification query (run manually to confirm):
-- SELECT COUNT(*) FROM activity_sources WHERE source_platform = 'garmin';
-- Should equal: SELECT COUNT(*) FROM garmin_activities WHERE source_platform = 'garmin';
```

**GarminDB `activity_sources` upsert pattern (for reference — used in the forward-path sync, not in this backfill):**

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

### Acceptance Criteria

1. After running the migration, every row in `garmin_activities` with `source_platform = 'garmin'` has a corresponding row in `activity_sources` with `source_platform = 'garmin'` and `is_preferred = true`.
2. No duplicate `activity_sources` rows are created if the migration is re-run (`INSERT ... ON CONFLICT DO NOTHING`).
3. `external_id` in `activity_sources` equals `activity_id` from `garmin_activities` for all GarminDB rows.
4. Row count in `activity_sources` (where `source_platform = 'garmin'`) after migration equals the number of `garmin_activities` rows with `source_platform = 'garmin'`.

### Dependencies

ING-001 must be complete (requires `activity_sources` table to exist, and `garmin_activities.source_platform` column to exist and be backfilled to `'garmin'` for pre-existing rows).
