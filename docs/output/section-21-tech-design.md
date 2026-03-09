# Section 21 -- Environmental Adjustment (Heat, Humidity, Altitude): Technical Design Document

**Author:** Staff Engineer Lead
**Date:** 2026-03-08
**PRD Section:** 21 (Environmental Adjustment)
**Status:** Draft -- revised after Staff Engineer 2 review (round 1)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Pure Calculation Library (`lib/envAdjust.ts`)](#3-pure-calculation-library-libenvadJustts)
4. [Open-Meteo API Client (`lib/weatherApi.ts`)](#4-open-meteo-api-client-libweatherapits)
5. [Database Schema (`sql/activity_weather.sql`)](#5-database-schema-sqlactivity_weathersql)
6. [Weather Recalc Pipeline (`lib/weatherRecalc.ts`)](#6-weather-recalc-pipeline-libweatherrecalcts)
7. [Updates to `lib/ef.ts`](#7-updates-to-libefts)
8. [Updates to `lib/efRecalc.ts`](#8-updates-to-libefrecalcts)
9. [Ticket Breakdown](#9-ticket-breakdown)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Edge Cases and Error Handling](#11-edge-cases-and-error-handling)
12. [Key Risks and Mitigations](#12-key-risks-and-mitigations)
13. [Design Decisions](#13-design-decisions)

---

## 1. Overview

### What This Implements

Section 21 delivers environmental normalization for the Efficiency Factor (EF) pipeline. Raw EF values absorb heat stress — a run at 28°C with 80% humidity suppresses true physiological output, making fitness appear lower than it is. Section 21 strips out this environmental signal so that `ef_temp_adjusted` reflects the athlete's aerobic fitness rather than the weather on a given day.

Three correction layers are applied in sequence:

1. **Temperature** — linear performance factor relative to 15°C baseline (Ely et al. 2007)
2. **Humidity** — Steadman (1979) effective temperature substitution when humidity > 60% AND temp > 20°C
3. **Altitude** — DEM-based elevation factor for elevations above 1,500 m

Weather data is fetched from the Open-Meteo historical archive API (free, no API key) and stored in a new `activity_weather` table. This decouples the weather fetch pipeline from the EF recalculation pipeline, allowing each to be triggered independently.

### What Was Stubbed in Section 7

Section 7 shipped two stubs that this section implements:

- `normalizeTempEF()` in `lib/ef.ts` — returns `ef` unchanged; upserts `temp_adjusted: false, ef_temp_adjusted: null`
- `backfillEFWithTempAdjustment()` in `lib/efRecalc.ts` — a no-op returning `{ ok: true, count: 0 }`

Both stubs are replaced in this section. The `normalizeTempEF` stub in `lib/ef.ts` is removed and replaced with a delegation call to `lib/envAdjust.ts`. The full backfill implementation lands in `lib/efRecalc.ts`.

### How It Fits the Codebase

Section 21 adds one new computation layer and one new I/O layer, following the identical two-layer pattern established across all prior sections:

| Layer | Precedent | Section 21 |
|---|---|---|
| Pure calculation | `lib/ef.ts`, `lib/gap.ts`, `lib/pmc.ts` | `lib/envAdjust.ts` |
| API client | (new pattern) | `lib/weatherApi.ts` |
| Supabase I/O | `lib/efRecalc.ts`, `lib/gapRecalc.ts` | `lib/weatherRecalc.ts` |
| SQL migration | `sql/activity_ef.sql`, `sql/activity_gap.sql` | `sql/activity_weather.sql` |

---

## 2. Architecture

### 2.1 New Files

```
lib/
  envAdjust.ts      -- Pure TS: all environmental factor computations (no I/O)
  weatherApi.ts     -- Open-Meteo fetch + in-memory cache (no Supabase)
  weatherRecalc.ts  -- Supabase I/O: fetch weather, upsert activity_weather, trigger EF backfill

sql/
  activity_weather.sql   -- Migration: activity_weather table

__tests__/
  envAdjust.test.ts      -- Unit tests for all pure functions in lib/envAdjust.ts
  weatherApi.test.ts     -- Unit tests for URL construction, response parsing, caching
```

### 2.2 Modified Files

```
lib/ef.ts           -- Remove normalizeTempEF stub; add delegation import from envAdjust.ts
lib/efRecalc.ts     -- Update step 3f in recalculateEF(); implement backfillEFWithTempAdjustment()
```

### 2.3 Module Responsibilities

**`lib/envAdjust.ts` (pure — zero I/O)**
- Implements all environmental factor calculations: humidity partial pressure, effective temperature, performance factor, altitude factor, full EF normalization
- Implements OLS `fitHeatSensitivityK()` for personal coefficient fitting
- Accepts and returns plain TypeScript numbers and objects
- No imports from Supabase, AsyncStorage, or React Native

**`lib/weatherApi.ts` (pure async — no Supabase)**
- Constructs Open-Meteo archive API URLs
- Fetches and parses hourly weather data
- Maintains an in-memory cache keyed by `"${lat},${lng},${date}"` to avoid redundant HTTP calls across the pipeline run
- Returns `null` on any error; never throws to callers

**`lib/weatherRecalc.ts` (Supabase I/O layer)**
- Fetches all outdoor activities (start_lat IS NOT NULL) from `garmin_activities`
- Calls `fetchActivityWeather()` for each activity
- Upserts results to `activity_weather`
- Calls `backfillEFWithTempAdjustment()` to complete the normalization chain
- Implements `fitAndStoreHeatSensitivityK()` for quarterly personal coefficient updates

**`sql/activity_weather.sql`**
- Creates `activity_weather` table (one row per activity)
- RLS disabled, anon/authenticated granted SELECT, INSERT, UPDATE

### 2.4 Data Flow

```
sync trigger
    │
    ▼
recalculateWeather()        [weatherRecalc.ts]   ← new
    │
    ├── garmin_activities   [Supabase — fetch outdoor activities]
    │
    ├── fetchActivityWeather()   [weatherApi.ts] ← new (per activity, sequential)
    │       └── Open-Meteo archive API (HTTP GET, in-memory cache)
    │
    ├── activity_weather    [Supabase — upsert]
    │
    └── backfillEFWithTempAdjustment()   [efRecalc.ts]  ← stub replaced
            │
            ├── activity_ef       [Supabase — query temp_adjusted = false]
            ├── activity_weather  [Supabase — join for humidity + elevation]
            ├── normalizeTempEF() [envAdjust.ts — pure calculation]
            └── activity_ef       [Supabase — update ef_temp_adjusted]
```

**Post-GAP call chain (existing, extended):**

`computeGAPBatch()` in `gapRecalc.ts` currently ends with:
```
triggerDecouplingBackfill() → triggerEFRecalc()
```

Section 21 adds a third call after EF:
```
triggerDecouplingBackfill() → triggerEFRecalc() → triggerWeatherRecalc()
```

`triggerWeatherRecalc()` is a thin wrapper in `gapRecalc.ts` delegating to `recalculateWeather()` and then `backfillEFWithTempAdjustment()`, following the exact same thin-wrapper pattern as `triggerDecouplingBackfill()` and `triggerEFRecalc()`.

---

## 3. Pure Calculation Library (`lib/envAdjust.ts`)

`lib/envAdjust.ts` is pure TypeScript — zero I/O, zero external dependencies. All functions are exported and unit-testable in isolation. The file header must state: "Pure TypeScript module — zero I/O, zero external dependencies."

### 3.1 Types

```typescript
export interface EnvNormalizationResult {
  efTempAdj: number;          // EF after temperature + humidity correction
  efAltAdj: number;           // EF after all corrections (temperature + humidity + altitude)
  performanceFactor: number;  // Factor applied for temp/humidity (< 1.0 means heat penalty)
  altitudeFactor: number;     // Factor applied for altitude (> 1.0 means altitude penalty)
}
```

### 3.2 `computeHumidityPartialPressure`

```typescript
/**
 * Compute the vapor pressure (hPa) using the August-Roche-Magnus approximation
 * as used in Steadman (1979).
 *
 * Formula: humidity_partial_pressure = (humidityPct / 100) * 6.105 * exp(17.27 * T / (237.7 + T))
 *
 * @param tempC       Ambient temperature in degrees Celsius
 * @param humidityPct Relative humidity as a percentage (0–100)
 * @returns           Vapor pressure in hPa
 */
export function computeHumidityPartialPressure(
  tempC: number,
  humidityPct: number,
): number
```

**Implementation:**
```
(humidityPct / 100) * 6.105 * Math.exp(17.27 * tempC / (237.7 + tempC))
```

### 3.3 `computeEffectiveTemperature`

```typescript
/**
 * Compute effective temperature using Steadman (1979).
 *
 * Only applied when humidity > 60 AND temp > 20. Outside these bounds,
 * returns tempC unchanged (no humidity correction).
 *
 * Steadman formula: effective_temperature = temperature + (0.33 * humidity_partial_pressure) - 4.0
 *
 * @param tempC       Ambient temperature in degrees Celsius
 * @param humidityPct Relative humidity as a percentage (0–100)
 * @returns           Effective temperature in degrees Celsius
 */
export function computeEffectiveTemperature(
  tempC: number,
  humidityPct: number,
): number
```

**Implementation:**
- If `humidityPct <= 60` OR `tempC <= 20`: return `tempC` (no correction)
- Otherwise: return `tempC + (0.33 * computeHumidityPartialPressure(tempC, humidityPct)) - 4.0`

**Note on guard conditions:** The PRD specifies the Steadman correction applies "when humidity > 60% AND temp > 20°C". Strictly greater-than on both sides — exactly 60% humidity or exactly 20°C does not trigger the correction.

### 3.4 `computePerformanceFactor`

```typescript
/**
 * Compute the performance factor for a given temperature and humidity.
 *
 * The performance factor represents how much physiological output is suppressed
 * relative to the 15°C baseline. A factor of 0.98 means the athlete is running
 * at 98% of their true fitness capability due to heat stress.
 *
 * Formula: performance_factor = 1 - k * (T_eff - 15) / 10
 * where T_eff is the effective temperature (Steadman-adjusted if applicable).
 *
 * At or below 15°C: performance_factor = 1.0 (no heat penalty).
 * k defaults to 0.02 (PRD-specified default; replaced by personal coefficient
 * after fitHeatSensitivityK() runs with 30+ qualifying outdoor runs).
 *
 * @param tempC       Ambient temperature in degrees Celsius
 * @param humidityPct Relative humidity as a percentage, or null if unavailable
 * @param k           Heat sensitivity coefficient (default: 0.02)
 * @returns           Performance factor in range (0, 1.0]
 */
export function computePerformanceFactor(
  tempC: number,
  humidityPct: number | null,
  k = 0.02,
): number
```

**Implementation:**
1. Compute `T_eff`:
   - If `humidityPct` is non-null: `T_eff = computeEffectiveTemperature(tempC, humidityPct)`
   - If `humidityPct` is null: `T_eff = tempC` (skip humidity correction)
2. If `T_eff <= 15`: return `1.0`
3. Otherwise: `return Math.max(0.5, 1 - k * (T_eff - 15) / 10)`

**Clamping:** The result is clamped to a minimum of `0.5`. While the default `k = 0.02` produces physiologically plausible values for all real-world temperatures, `fitHeatSensitivityK()` can return larger k values from OLS regression on individual athlete data. A high k (e.g., k = 0.5) with a high T_eff produces a negative factor (e.g., `1 - 0.5 * 25/10 = -0.25`), which would cause `ef / performanceFactor` to return a large negative `ef_temp_adjusted`. The `0.5` floor is physiologically grounded: even in extreme heat conditions, an athlete's aerobic output is not reduced by more than 50% of their fitness baseline. Using `Math.max(0.5, factor)` prevents nonsensical negative (or near-zero) factors from producing astronomically large or negative adjusted EF values.

### 3.5 `computeAltitudeFactor`

```typescript
/**
 * Compute the altitude correction factor for a given elevation.
 *
 * Altitude degrades aerobic performance due to reduced oxygen partial pressure.
 * The correction factor adjusts EF upward to reflect sea-level equivalent fitness.
 *
 * Formula (for elevationM > 1500):
 *   altitude_factor = 1 - 0.065 * ((elevationM - 1500) / 1000)
 *   ef_altitude_adjusted = ef_temp_adjusted * (1 / altitude_factor)
 *
 * At or below 1500m: altitude_factor = 1.0 (no correction).
 * At exactly 1500m: altitude_factor = 1.0 (boundary is inclusive — no correction).
 *
 * @param elevationM  Elevation in meters (from Open-Meteo DEM response)
 * @returns           Altitude factor; values < 1.0 indicate altitude penalty applied
 */
export function computeAltitudeFactor(elevationM: number): number
```

**Implementation:**
- If `elevationM <= 1500`: return `1.0`
- Otherwise: return `1 - 0.065 * ((elevationM - 1500) / 1000)`

**Division-by-zero guard:** altitude_factor can theoretically reach 0 at extreme elevations (~23,000m). This is not a real-world concern for running activities. No clamping specified.

### 3.6 `normalizeTempEF`

```typescript
/**
 * Apply all environmental corrections to a raw EF value.
 *
 * Correction order:
 *   1. Temperature + humidity correction → efTempAdj
 *   2. Altitude correction → efAltAdj
 *
 * Formula:
 *   efTempAdj = ef / performanceFactor
 *   efAltAdj  = efTempAdj * (1 / altitudeFactor)
 *
 * Returns the raw ef value in all adjusted fields when performanceFactor = 1.0
 * and altitudeFactor = 1.0 (no-op correction for cool, low-elevation activities).
 *
 * @param ef           Raw EF value from calculateEFFromLaps() (m/s/bpm)
 * @param tempC        Ambient temperature in degrees Celsius
 * @param humidityPct  Relative humidity as a percentage, or null if unavailable
 * @param elevationM   Elevation in meters, or null if unavailable
 * @param k            Heat sensitivity coefficient (default: 0.02)
 * @returns            EnvNormalizationResult with all four derived values
 */
export function normalizeTempEF(
  ef: number,
  tempC: number,
  humidityPct: number | null,
  elevationM: number | null,
  k = 0.02,
): EnvNormalizationResult
```

**Implementation:**
```typescript
const performanceFactor = computePerformanceFactor(tempC, humidityPct, k);
const altitudeFactor = computeAltitudeFactor(elevationM ?? 0);
const efTempAdj = ef / performanceFactor;
const efAltAdj = efTempAdj * (1 / altitudeFactor);
return { efTempAdj, efAltAdj, performanceFactor, altitudeFactor };
```

**Guard for altitudeFactor = 0:** If `computeAltitudeFactor` returns 0 (hypothetically), `1 / altitudeFactor` would be `Infinity`. This is not a real-world concern (would require elevation > ~16,000m for k=0.065). No special handling required.

**Note on `ef.ts` delegation:** This function has the same name as the stub in `lib/ef.ts`. The resolution of this naming conflict is documented in Section 7.

### 3.7 `fitHeatSensitivityK`

```typescript
/**
 * Fit a personal heat sensitivity coefficient k via OLS regression.
 *
 * Regresses the difference (ef_raw - ef_expected_flat) against (tempC - 15)
 * to derive the per-athlete k coefficient that best explains the observed
 * EF suppression at elevated temperatures.
 *
 * Returns null when:
 *   - Fewer than 30 qualifying outdoor runs are provided
 *   - The temperature range across provided runs is < 15°C
 *     (insufficient range to distinguish heat effect from noise)
 *
 * OLS formula: k = -Σ[(tempC_i - 15) * (efValue_i - efMean)] / Σ[(tempC_i - 15)^2]
 * (negative because higher temperature → lower EF, so slope of EF vs. temp is negative)
 *
 * @param runs  Array of qualifying run records with raw EF and actual temperature
 * @returns     Fitted k coefficient, or null if insufficient data
 */
export function fitHeatSensitivityK(
  runs: Array<{ efValue: number; tempC: number }>,
): number | null
```

**Implementation:**
1. Check `runs.length < 30` → return `null`
2. Compute temp range: `max(tempC) - min(tempC)`. If `< 15` → return `null`
3. Compute `efMean = mean(efValue)`
4. For each run, compute `x_i = tempC_i - 15`
5. OLS slope: `slope = Σ(x_i * (efValue_i - efMean)) / Σ(x_i^2)`
6. `k = -slope` (negative because heat reduces EF, so the slope of EF vs. temp is negative, but k is defined as positive in the performance factor formula)
7. Return `Math.max(0, k)` — k must be non-negative by definition (heat cannot improve performance in this model)

**Note on OLS formulation:** The regression is of EF against temperature. The k coefficient is derived from this relationship. A negative correlation (EF decreases with temperature) yields a positive k. If an athlete shows no heat sensitivity (slope ≈ 0) or anomalous improvement with heat (positive slope), k is clamped to 0.

---

## 4. Open-Meteo API Client (`lib/weatherApi.ts`)

`lib/weatherApi.ts` is an async module with no Supabase dependency. It is the sole source of HTTP communication in the Section 21 pipeline. File header: "Open-Meteo API client — no Supabase, no I/O side effects beyond HTTP fetch."

### 4.1 Types

```typescript
export interface WeatherResult {
  temperatureCelsius: number | null;
  humidityPct: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  elevationM: number | null;            // From Open-Meteo DEM response root
  midRunTempDelta: number | null;       // Max - min temp over activity duration (hourly)
  usedSegmentAdjustment: boolean;       // True when mid-run delta > 3°C
  hourlyTemps: number[];                // Full array of temps for the activity's hour range
}
```

### 4.2 URL Construction

Open-Meteo historical archive endpoint:

```
https://archive-api.open-meteo.com/v1/archive
  ?latitude={lat}
  &longitude={lng}
  &start_date={YYYY-MM-DD}
  &end_date={YYYY-MM-DD}
  &hourly=temperature_2m,relativehumidity_2m,windspeed_10m,winddirection_10m
  &timezone=UTC
```

`start_date` and `end_date` are both set to the activity's **UTC date** (single-day query). The API returns the full day's hourly data (24 entries) with timestamps in UTC.

**Why `timezone=UTC` (not `timezone=auto`):** Open-Meteo with `timezone=auto` returns local times in `hourly.time`. The hour-index extraction logic uses `new Date(startTimeISO).toISOString().slice(0, 13)` which produces a UTC prefix. If local times were returned, this prefix match would fail for any activity outside UTC, producing `startHourIndex = -1` and a null result for every non-UTC activity. Using `timezone=UTC` causes Open-Meteo to return UTC timestamps, making the prefix match correct for all activities regardless of the local timezone at the activity location.

**UTC date consistency:** `start_date` and `end_date` are derived by `new Date(startTimeISO).toISOString().slice(0, 10)` — the UTC calendar date. For late-night local runs (e.g., a 22:00 UTC-4 run whose UTC start is 02:00Z the next day), the UTC date correctly identifies the UTC day whose hourly data contains the activity's UTC start hour. The entire pipeline is self-consistent in UTC.

```typescript
/**
 * Build the Open-Meteo archive API URL for a given coordinate and date.
 * Exported for unit testing.
 */
export function buildOpenMeteoUrl(
  lat: number,
  lng: number,
  date: string,  // ISO YYYY-MM-DD
): string
```

### 4.3 Response Parsing

The Open-Meteo response structure:

```json
{
  "elevation": 245.3,
  "hourly": {
    "time": ["2024-06-15T00:00", "2024-06-15T01:00", ...],
    "temperature_2m": [18.2, 17.9, ...],
    "relativehumidity_2m": [72, 75, ...],
    "windspeed_10m": [8.4, 7.1, ...],
    "winddirection_10m": [215, 220, ...]
  }
}
```

Hour index extraction: Given `startTimeISO` (e.g., `"2024-06-15T07:30:00Z"`), extract the UTC hour by matching against the `hourly.time` array. Because `timezone=UTC` is used, Open-Meteo returns UTC timestamps in `hourly.time`, so a direct string prefix match on `"YYYY-MM-DDTHH"` in UTC is used to find the starting hour index.

```typescript
/**
 * Parse an Open-Meteo archive API response into a structured record.
 * Returns null if the response is malformed or missing required fields.
 * Exported for unit testing.
 */
export function parseOpenMeteoResponse(
  responseJson: unknown,
  startTimeISO: string,
  durationSeconds: number,
): WeatherResult | null
```

**Hour index logic:**
1. Extract UTC date + hour prefix from `startTimeISO`: `"2024-06-15T07"` — use `new Date(startTimeISO).toISOString().slice(0, 13)`. This produces a UTC prefix that matches the UTC timestamps returned by Open-Meteo when `timezone=UTC` is used.
2. Find `startHourIndex = hourly.time.findIndex(t => t.startsWith(dateHourPrefix))`
3. If not found: return `null`
4. Compute `durationHours = Math.ceil(durationSeconds / 3600)`
5. Slice `hourly.temperature_2m[startHourIndex .. startHourIndex + durationHours]` for `hourlyTemps`
6. Activity temperature = `hourly.temperature_2m[startHourIndex]` (start-of-activity hour)
7. `midRunTempDelta = max(hourlyTemps) - min(hourlyTemps)` if `hourlyTemps.length >= 2`, else `null`
8. `usedSegmentAdjustment = midRunTempDelta !== null && midRunTempDelta > 3`

**Mid-run segment adjustment:** When `usedSegmentAdjustment = true`, the temperature stored in `activity_weather.temperature_celsius` is still the start-of-activity hour temperature. The segment adjustment flag is stored for audit purposes. The EF normalization in `lib/envAdjust.ts` uses the start temperature for a single-activity normalization. A per-segment normalization (which would require lap-level timestamps) is out of scope for this implementation.

**Rationale for single-temperature approximation:** The PRD specifies "if hourly temp delta > 3°C, apply per-segment temperature adjustments." However, lap-level timestamps are not available in the current schema (`garmin_activity_laps` does not include absolute start timestamps, only `elapsed_time_seconds` relative to the activity). Implementing per-segment adjustment would require backfilling absolute timestamps into the lap schema, which is a schema change outside the Section 21 scope. The `usedSegmentAdjustment` boolean is stored to flag these activities for future refinement. This is documented as a scope decision in Section 13.

### 4.4 In-Memory Cache

```typescript
// Module-level cache (lives for the duration of a single pipeline run)
const weatherCache = new Map<string, WeatherResult | null>();

function cacheKey(lat: number, lng: number, date: string): string {
  return `${lat},${lng},${date}`;
}
```

Cache behavior:
- Before fetching: check `weatherCache.get(cacheKey(...))`. If present (including `null` sentinel), return cached value.
- After fetching: store result (or `null` on error) in cache.
- Cache is not persisted across process restarts. It exists only to prevent redundant API calls within a single `recalculateWeather()` invocation (e.g., multiple activities at the same location on the same day — common for track workouts).

### 4.5 `fetchActivityWeather`

```typescript
/**
 * Fetch weather conditions for a single activity from the Open-Meteo archive API.
 *
 * Returns null on any error (API unavailable, network failure, parse error,
 * or missing hourly data for the activity's time slot). Never throws.
 *
 * Uses in-memory cache keyed by (lat, lng, date) to avoid redundant API calls.
 *
 * @param lat             Activity start latitude (from garmin_activities.start_lat)
 * @param lng             Activity start longitude (from garmin_activities.start_lng)
 * @param startTimeISO    Activity start time as ISO 8601 string
 * @param durationSeconds Activity duration in seconds (for mid-run delta calculation)
 * @returns               WeatherResult or null on any error
 */
export async function fetchActivityWeather(
  lat: number,
  lng: number,
  startTimeISO: string,
  durationSeconds: number,
): Promise<WeatherResult | null>
```

**Implementation:**
1. Derive `date` from `startTimeISO` (slice to `YYYY-MM-DD`)
2. Check cache; return cached value if present
3. Build URL via `buildOpenMeteoUrl(lat, lng, date)`
4. `fetch(url)` — use the global `fetch` (available in React Native / Expo environments)
5. On non-200 response or network error: store `null` in cache, return `null`
6. Parse JSON; call `parseOpenMeteoResponse(json, startTimeISO, durationSeconds)`
7. Store result (or `null`) in cache
8. Return result

**Error handling:** All errors are caught inside `fetchActivityWeather` and result in `null`. This is consistent with the PRD: "Fallback if API unavailable: null all weather fields — never use device temperature."

---

## 5. Database Schema (`sql/activity_weather.sql`)

The migration is idempotent (uses `IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`). It follows the exact pattern of `sql/activity_ef.sql`.

### 5.1 `activity_weather` Table

One row per activity. Primary key: `activity_id` (TEXT — matches `activity_ef.activity_id` type).

```sql
-- Section 21: activity_weather table
--
-- Stores weather conditions at the time and location of each outdoor activity.
-- Source: Open-Meteo historical archive API (archive-api.open-meteo.com).
-- Indoor activities (start_lat IS NULL) are excluded — no row is inserted.
--
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS).
--
-- Prerequisites:
--   - athletes table must exist (created by daily_pmc_values.sql)
--   - activity_ef.sql must have run (establishes activity_ef table referenced
--     by the EF backfill pipeline)

CREATE TABLE IF NOT EXISTS activity_weather (
    -- Primary key: matches activity_ef.activity_id type (TEXT)
    activity_id             TEXT             PRIMARY KEY,

    -- Athlete reference (no FK on activity_id; consistent with activity_ef pattern)
    athlete_id              UUID             NOT NULL REFERENCES athletes(id),

    -- Weather conditions at activity start time (Open-Meteo hourly data)
    temperature_celsius     DOUBLE PRECISION,
    humidity_pct            DOUBLE PRECISION,
    wind_speed_kmh          DOUBLE PRECISION,
    wind_direction_deg      DOUBLE PRECISION,

    -- Elevation from Open-Meteo DEM (not device GPS elevation)
    elevation_m             DOUBLE PRECISION,

    -- Mid-run temperature delta: max - min over activity duration (hourly resolution)
    -- NULL for activities < 1 hour (only one hourly data point available)
    mid_run_temp_delta      DOUBLE PRECISION,

    -- True when mid_run_temp_delta > 3°C (segment adjustment flagged)
    used_segment_adjustment BOOLEAN          NOT NULL DEFAULT false,

    -- Audit timestamp
    fetched_at              TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Index for per-athlete weather lookups (join with activity_ef)
CREATE INDEX IF NOT EXISTS idx_activity_weather_athlete
    ON activity_weather (athlete_id);
```

### 5.2 Access Control

```sql
-- Access control (RLS disabled -- consistent with all other tables)
GRANT SELECT, INSERT, UPDATE ON activity_weather TO anon, authenticated;

ALTER TABLE activity_weather DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
```

### 5.3 Notes on Schema Decisions

- `activity_id TEXT PRIMARY KEY` — TEXT type matches `activity_ef.activity_id` and the `String(actRow.activity_id)` conversion pattern used throughout the codebase. Garmin activity IDs are bigint at source but are stored as TEXT in the derived tables.
- No `SERIAL id` — this table uses the natural primary key (`activity_id`) since each activity has exactly one weather record. This differs from `activity_ef` (which uses SERIAL) but is consistent with the PRD's "One row per activity" requirement and avoids a redundant surrogate key.
- `fetched_at DEFAULT now()` — automatically populated on upsert; no application-level value required.

---

## 6. Weather Recalc Pipeline (`lib/weatherRecalc.ts`)

Follows the same pattern as `gapRecalc.ts` and `efRecalc.ts`: singleton Supabase client, try/catch on every exported async function, sequential (no `Promise.all`) batch processing.

### 6.1 Module Constants

```typescript
/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Batch size for upsert operations (matches gapRecalc.ts / efRecalc.ts pattern). */
const BATCH_SIZE = 500;

/** athlete_parameters key for the personal heat sensitivity coefficient. */
const HEAT_SENSITIVITY_KEY = 'heat_sensitivity_k';
```

### 6.2 Return-Type Interfaces

```typescript
export interface WeatherRecalcResult {
  ok: boolean;
  activitiesProcessed?: number;   // Activities with weather successfully fetched
  activitiesSkipped?: number;     // Indoor activities (null start_lat) or API failures
  errors?: number;
  error?: string;
}
```

### 6.3 `recalculateWeather`

```typescript
/**
 * Fetch and persist weather conditions for all outdoor run activities.
 *
 * Skips activities where start_lat IS NULL (indoor activities).
 * On Open-Meteo API failure for any activity, stores null for all weather fields
 * (never falls back to device temperature). Continues processing remaining activities.
 *
 * After all activities are processed, calls backfillEFWithTempAdjustment() to
 * apply normalization to all activity_ef rows with newly available weather data.
 *
 * @param fromDate  ISO date (YYYY-MM-DD). Process activities on or after this date.
 *                  Omit to process all activities on record.
 */
export async function recalculateWeather(
  fromDate?: string,
): Promise<WeatherRecalcResult>
```

**Pipeline steps:**

**Step 1 — Fetch outdoor activities**

Query `garmin_activities` for all activities with:
- `start_lat IS NOT NULL` AND `start_lng IS NOT NULL` (outdoor activities only)
- `sport ILIKE '%run%'` (consistent with `efRecalc.ts` sport filter)
- Optional `start_time >= fromDate`

Columns: `activity_id, start_lat, start_lng, start_time, moving_time_seconds`

**Step 2 — Per-activity weather fetch (sequential)**

For each activity:
1. Call `fetchActivityWeather(start_lat, start_lng, start_time, moving_time_seconds ?? 0)`
2. If result is `null` (API failure): store a null-filled weather row to mark the attempt; increment `activitiesSkipped`
3. If result is non-null: build upsert row (see below); increment `activitiesProcessed`

**Step 3 — Batch upsert to `activity_weather`**

Accumulate rows and upsert in batches of 500:

```typescript
{
  activity_id:             String(actRow.activity_id),
  athlete_id:              SINGLE_ATHLETE_ID,
  temperature_celsius:     weatherResult?.temperatureCelsius ?? null,
  humidity_pct:            weatherResult?.humidityPct ?? null,
  wind_speed_kmh:          weatherResult?.windSpeedKmh ?? null,
  wind_direction_deg:      weatherResult?.windDirectionDeg ?? null,
  elevation_m:             weatherResult?.elevationM ?? null,
  mid_run_temp_delta:      weatherResult?.midRunTempDelta ?? null,
  used_segment_adjustment: weatherResult?.usedSegmentAdjustment ?? false,
}
// onConflict: 'activity_id' (primary key)
```

Note: On conflict, update all weather columns. `fetched_at` is set by `DEFAULT now()` on the database side and is not included in the upsert payload (it updates automatically).

**Step 4 — Trigger EF backfill**

After all activities have been processed and upserted:

```typescript
await backfillEFWithTempAdjustment();
```

This call is fire-and-complete — `recalculateWeather` awaits its result and includes its error in the return value if it fails.

### 6.4 `fitAndStoreHeatSensitivityK`

```typescript
/**
 * Fit a personal heat sensitivity coefficient and store it in athlete_parameters.
 *
 * Reads all qualifying activity_ef rows that have a valid ef_value and temp_c,
 * calls fitHeatSensitivityK() from lib/envAdjust.ts, and upserts the result
 * to athlete_parameters with key 'heat_sensitivity_k'.
 *
 * Returns { ok: true, k: undefined } when insufficient data (< 30 outdoor runs
 * or < 15°C temperature range). Does not upsert in this case.
 *
 * Intended to be called quarterly (not on every sync). The caller is responsible
 * for determining the schedule.
 */
export async function fitAndStoreHeatSensitivityK(): Promise<{
  ok: boolean;
  k?: number;
  error?: string;
}>
```

**Implementation:**

**Step 1 — Fetch qualifying EF rows with temperature**

```sql
SELECT ef_value, temp_c
FROM activity_ef
WHERE athlete_id = $SINGLE_ATHLETE_ID
  AND qualifying = true
  AND ef_value IS NOT NULL
  AND temp_c IS NOT NULL
```

**Note on removed `temp_c > 15` filter:** An earlier draft filtered to only warm-weather runs before passing data to `fitHeatSensitivityK()`. This was removed. Cool-weather runs (where `tempC - 15` is negative) contribute negative `x_i` values to the OLS regression, anchoring the fit and improving stability. Filtering them out reduces regressor variance and can inflate the estimated k. `fitHeatSensitivityK()` already enforces its own data-quality gate via the `tempRange >= 15` check — if all provided runs fall within a narrow temperature band (regardless of where that band sits), the function returns null. Removing the pre-filter from the SQL query makes the query simpler and produces a better-anchored OLS fit.

**Step 2 — Fit coefficient**

```typescript
const k = fitHeatSensitivityK(
  rows.map(r => ({ efValue: r.ef_value, tempC: r.temp_c }))
);
if (k === null) return { ok: true, k: undefined };
```

**Step 3 — Upsert to `athlete_parameters`**

The `athlete_parameters` table uses a `key`/`value` pattern as described in the PRD. However, inspecting `sql/athlete_parameters.sql`, the current schema uses `tc_fitness`, `tc_fatigue`, `k1`, `k2`, `intercept` as named columns rather than a generic `key`/`value` pattern. The PRD states "Store in `athlete_parameters` (existing table, `key`/`value` pattern). Key: `heat_sensitivity_k`."

**Resolution:** The existing `athlete_parameters` table does not have a `key`/`value` generic column pattern — it has named columns for PMC parameters. Rather than altering the existing table (which risks breaking PMC queries), the `heat_sensitivity_k` coefficient is stored in a new column added to `athlete_parameters` via a migration in the `sql/activity_weather.sql` file:

```sql
ALTER TABLE athlete_parameters
    ADD COLUMN IF NOT EXISTS heat_sensitivity_k DOUBLE PRECISION;
```

The upsert in `fitAndStoreHeatSensitivityK()` updates this column:

```typescript
await supabase
  .from('athlete_parameters')
  .upsert(
    {
      athlete_id: SINGLE_ATHLETE_ID,
      sport: 'run',
      heat_sensitivity_k: k,
    },
    { onConflict: 'athlete_id,sport' },
  );
```

This is consistent with the existing `UNIQUE (athlete_id, sport)` constraint on `athlete_parameters`.

**Reading the coefficient in `recalculateEF` and `backfillEFWithTempAdjustment`:**

The personal `k` is read from `athlete_parameters` at the start of both pipeline functions:

```typescript
const { data: params } = await supabase
  .from('athlete_parameters')
  .select('heat_sensitivity_k')
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('sport', 'run')
  .maybeSingle();

const heatK = params?.heat_sensitivity_k ?? 0.02;  // Default 0.02 if not yet fitted
```

---

## 7. Updates to `lib/ef.ts`

### 7.1 Decision: Remove the Stub; Delegate to `lib/envAdjust.ts`

The `normalizeTempEF` stub in `lib/ef.ts` (lines 246–259) is **removed entirely** and replaced with a re-export delegation to `lib/envAdjust.ts`.

**Rationale:** Two options were considered:

1. **Keep stub in `lib/ef.ts`, have it call `lib/envAdjust.ts`** — This preserves the existing import in `lib/efRecalc.ts` (`import { normalizeTempEF } from './ef'`) without changes. However, it creates a confusing indirection where the canonical implementation lives in `envAdjust.ts` but the function is accessed via `ef.ts`. It also means `lib/ef.ts` would gain an import dependency on `lib/envAdjust.ts`, which is a new coupling not present in the pure-calculation design.

2. **Remove from `lib/ef.ts`; import directly from `lib/envAdjust.ts` in consumers** — This is the cleaner solution. `lib/efRecalc.ts` already imports from multiple `lib/` files; adding `envAdjust.ts` to its import list is not a burden. The stub comment in `lib/ef.ts` ("TODO Section 21: implement normalization") clearly anticipated this removal.

**Decision: Option 2.** Remove `normalizeTempEF` from `lib/ef.ts`. Update `lib/efRecalc.ts` to import `normalizeTempEF` from `./envAdjust` instead of `./ef`.

**Note on signature change:** The stub's signature was `normalizeTempEF(ef, tempC, refTempC?)`. The Section 21 signature is `normalizeTempEF(ef, tempC, humidityPct, elevationM, k?)`. These are not backward-compatible. Since the stub was never producing real output (always returned `ef` unchanged), no production data was computed using the old signature. The change is safe.

### 7.2 Minimal Change to `lib/ef.ts`

Remove lines 246–259 (the `normalizeTempEF` stub function). Also remove the now-unused import of `normalizeTempEF` in `lib/efRecalc.ts` from `./ef`. No other changes to `lib/ef.ts`.

The `TODO` comment at line 222 referencing Section 21 polynomial regression is retained as-is — that is a separate future enhancement unrelated to this section.

---

## 8. Updates to `lib/efRecalc.ts`

### 8.1 New Imports

The import change in `lib/efRecalc.ts` is a single **atomic edit** — removing `normalizeTempEF` from `./ef` and adding the `./envAdjust` import in the same change. Both steps are required; doing only one produces a duplicate-import TypeScript error or a missing-export error.

**Before (existing line in `lib/efRecalc.ts`):**

```typescript
import { calculateEFFromLaps, normalizeTempEF, type EFResult } from './ef';
```

**After (two lines replace the above — performed as one edit):**

```typescript
import { calculateEFFromLaps, type EFResult } from './ef';
import {
  normalizeTempEF,
  type EnvNormalizationResult,
} from './envAdjust';
```

The implementer must remove `normalizeTempEF` from the `./ef` import and add the `./envAdjust` import in the same commit. Leaving `normalizeTempEF` in both imports will produce a TypeScript "Duplicate identifier" error; leaving it only in `./ef` (which no longer exports it after Section 7 stub removal) will produce a "Module has no exported member" error.

### 8.2 Update `recalculateEF`: Step 3f

**Current code (lines 158–160):**

```typescript
// 3f. Temperature normalization — stub; store temp_adjusted = false and
//     ef_temp_adjusted = null (do not persist the stub's return value).
void normalizeTempEF(efResult.efValue, actRow.avg_temperature ?? 15);
```

**And current upsert (lines 176–177):**
```typescript
temp_adjusted: false,
ef_temp_adjusted: null,
```

**Replacement (step 3f):**

Before the upsert, read weather data for the activity from `activity_weather`, then call normalization:

```typescript
// 3f. Fetch weather data for this activity (if available)
const { data: weatherRow } = await supabase
  .from('activity_weather')
  .select('temperature_celsius, humidity_pct, elevation_m')
  .eq('activity_id', String(actRow.activity_id))
  .maybeSingle();

// 3g. Apply temperature normalization using weather data
const tempForNorm = weatherRow?.temperature_celsius ?? actRow.avg_temperature ?? null;
let tempAdjusted = false;
let efTempAdjusted: number | null = null;

if (tempForNorm !== null && efResult.efValue > 0) {
  const normResult = normalizeTempEF(
    efResult.efValue,
    tempForNorm,
    weatherRow?.humidity_pct ?? null,
    weatherRow?.elevation_m ?? null,
    heatK,  // personal coefficient read at function start; defaults to 0.02
  );
  // Store efAltAdj: the fully-normalized EF (temperature + humidity + altitude combined).
  // ef_temp_adjusted is the column name inherited from the Section 7 stub, but semantically
  // it holds the complete environmental normalization. Always use efAltAdj here, not efTempAdj.
  efTempAdjusted = normResult.efAltAdj;
  tempAdjusted = true;
}
```

**Updated upsert payload:**
```typescript
temp_adjusted: tempAdjusted,
ef_temp_adjusted: efTempAdjusted,
```

**Reading `heatK`:** At the start of `recalculateEF()`, before the activity loop, fetch the personal coefficient:

```typescript
const { data: paramsRow } = await supabase
  .from('athlete_parameters')
  .select('heat_sensitivity_k')
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('sport', 'run')
  .maybeSingle();

const heatK: number = paramsRow?.heat_sensitivity_k ?? 0.02;
```

**Temperature source precedence:** Open-Meteo weather data (`activity_weather.temperature_celsius`) takes precedence over device temperature (`garmin_activities.avg_temperature`). The PRD explicitly prohibits using device temperature as the primary source. Device temperature is used as a fallback only when `activity_weather` has no row for the activity (i.e., the weather fetch pipeline has not been run for this activity yet).

### 8.3 Implement `backfillEFWithTempAdjustment`

**Current stub (lines 338–348):**
```typescript
export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  try {
    return { ok: true, count: 0 };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
```

**Full implementation:**

```typescript
export async function backfillEFWithTempAdjustment(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  try {
    // Read personal heat coefficient (default 0.02 if not yet fitted)
    const { data: paramsRow } = await supabase
      .from('athlete_parameters')
      .select('heat_sensitivity_k')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('sport', 'run')
      .maybeSingle();

    const heatK: number = paramsRow?.heat_sensitivity_k ?? 0.02;

    // Query activity_ef rows that need backfilling
    // Condition: temp_adjusted = false AND temp_c IS NOT NULL
    const { data: efRows, error: efErr } = await supabase
      .from('activity_ef')
      .select('activity_id, ef_value, temp_c')
      .eq('athlete_id', SINGLE_ATHLETE_ID)
      .eq('temp_adjusted', false)
      .not('temp_c', 'is', null);

    if (efErr) throw efErr;

    const rows = efRows ?? [];
    if (rows.length === 0) return { ok: true, count: 0 };

    // Fetch all matching activity_weather rows in one query
    const activityIds = rows.map(r => r.activity_id);
    const { data: weatherRows, error: weatherErr } = await supabase
      .from('activity_weather')
      .select('activity_id, temperature_celsius, humidity_pct, elevation_m')
      .in('activity_id', activityIds);

    if (weatherErr) throw weatherErr;

    // Build weather lookup map
    const weatherMap = new Map<string, {
      temperature_celsius: number | null;
      humidity_pct: number | null;
      elevation_m: number | null;
    }>();
    for (const w of weatherRows ?? []) {
      weatherMap.set(w.activity_id, w);
    }

    // Build update rows
    interface EFUpdateRow {
      activity_id: string;
      ef_temp_adjusted: number;
      temp_adjusted: boolean;
    }

    const updateRows: EFUpdateRow[] = [];

    for (const efRow of rows) {
      // Skip rows with null or zero ef_value
      if (!efRow.ef_value || efRow.ef_value <= 0) continue;

      const weather = weatherMap.get(efRow.activity_id);
      const tempForNorm = weather?.temperature_celsius ?? efRow.temp_c;

      // tempForNorm cannot be null here (efRow.temp_c IS NOT NULL in query)
      if (tempForNorm === null) continue;

      const normResult = normalizeTempEF(
        efRow.ef_value,
        tempForNorm,
        weather?.humidity_pct ?? null,
        weather?.elevation_m ?? null,
        heatK,
      );

      updateRows.push({
        activity_id: efRow.activity_id,
        // Use efAltAdj: the fully-normalized EF (temperature + humidity + altitude).
        // Consistent with recalculateEF step 3f — both paths must assign efAltAdj to ef_temp_adjusted.
        ef_temp_adjusted: normResult.efAltAdj,
        temp_adjusted: true,
      });
    }

    // Upsert in batches
    let count = 0;
    for (let i = 0; i < updateRows.length; i += BATCH_SIZE) {
      const chunk = updateRows.slice(i, i + BATCH_SIZE);
      const { error: upsertErr } = await supabase
        .from('activity_ef')
        .upsert(
          chunk.map(r => ({
            athlete_id: SINGLE_ATHLETE_ID,
            activity_id: r.activity_id,
            ef_temp_adjusted: r.ef_temp_adjusted,
            temp_adjusted: r.temp_adjusted,
          })),
          { onConflict: 'athlete_id,activity_id' },
        );
      if (upsertErr) throw upsertErr;
      count += chunk.length;
    }

    return { ok: true, count };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
```

**Note on upsert vs. update:** `activity_ef` rows already exist (they were created by `recalculateEF`). An upsert with `onConflict: 'athlete_id,activity_id'` updates only the specified columns (`ef_temp_adjusted`, `temp_adjusted`) while leaving all other columns intact, including `ef_value`, `qualifying`, `gap_used`, etc. This is the correct pattern for a backfill that touches only two columns.

---

## 9. Ticket Breakdown

### Ticket 1: Pure Calculation Library (`lib/envAdjust.ts` + unit tests)

**Scope:**
- Create `lib/envAdjust.ts` with all functions specified in Section 3
- Create `__tests__/envAdjust.test.ts` with full unit test coverage
- No changes to any existing file

**Files created:**
- `lib/envAdjust.ts`
- `__tests__/envAdjust.test.ts`

**Boundaries:** No Supabase, no HTTP, no React Native imports. Entirely self-contained.

---

### Ticket 2: Open-Meteo API Client + SQL Migration + Weather Recalc Pipeline

**Scope:**
- Create `lib/weatherApi.ts` with `fetchActivityWeather`, `buildOpenMeteoUrl`, `parseOpenMeteoResponse`
- Create `sql/activity_weather.sql` (including `ALTER TABLE athlete_parameters ADD COLUMN IF NOT EXISTS heat_sensitivity_k`)
- Create `lib/weatherRecalc.ts` with `recalculateWeather` and `fitAndStoreHeatSensitivityK`
- Create `__tests__/weatherApi.test.ts` (URL construction, response parsing, cache behavior — all unit-testable with mock responses; no real HTTP calls in tests)

**Files created:**
- `lib/weatherApi.ts`
- `lib/weatherRecalc.ts`
- `sql/activity_weather.sql`
- `__tests__/weatherApi.test.ts`

**Dependencies:** Ticket 1 (imports `normalizeTempEF` from `lib/envAdjust.ts` via `lib/efRecalc.ts`; `weatherRecalc.ts` calls `backfillEFWithTempAdjustment` which is updated in Ticket 3 — stubs can be used during development)

---

### Ticket 3: Wire Normalization into `recalculateEF` + Implement `backfillEFWithTempAdjustment`

**Scope:**
- Remove `normalizeTempEF` stub from `lib/ef.ts` (lines 246–259)
- Update `lib/efRecalc.ts` — **all four changes are required together in one commit**:
  - Atomic import edit: remove `normalizeTempEF` from the `./ef` import line AND add `import { normalizeTempEF, type EnvNormalizationResult } from './envAdjust'` (see Section 8.1 for exact before/after — doing only one half produces a TS error)
  - Add `heatK` read at start of `recalculateEF()`
  - Replace step 3f with real normalization logic (fetch `activity_weather` row, call `normalizeTempEF`, store `normResult.efAltAdj` into `ef_temp_adjusted`)
  - Replace `backfillEFWithTempAdjustment` stub with full implementation (stores `normResult.efAltAdj` — not `efTempAdj` — consistent with step 3f)
- Add `triggerWeatherRecalc()` thin wrapper to `lib/gapRecalc.ts`

**Files modified:**
- `lib/ef.ts` (remove stub)
- `lib/efRecalc.ts` (update step 3f + implement backfill)
- `lib/gapRecalc.ts` (add `triggerWeatherRecalc` wrapper + call after `triggerEFRecalc`)

**Dependencies:** Ticket 1, Ticket 2 (SQL migration must be run before integration testing)

---

### Ticket 4 (Optional): Personal Coefficient Fitting (`fitAndStoreHeatSensitivityK`)

**Scope:**
- `fitAndStoreHeatSensitivityK()` in `lib/weatherRecalc.ts` is implemented in Ticket 2 but is not wired into the automatic pipeline
- Ticket 4 adds a manual trigger and documents the quarterly cadence
- Adds unit tests for `fitHeatSensitivityK` edge cases (< 30 runs, < 15°C range, anomalous negative slope)
- Optionally: add a UI hook or script for triggering the quarterly refit

**Files modified:**
- `__tests__/envAdjust.test.ts` (expanded test cases for `fitHeatSensitivityK`)

**Why optional:** The default `k = 0.02` is a valid approximation for all athletes until sufficient outdoor run data accumulates. The personal coefficient fitting requires 30+ qualifying runs spanning > 15°C of temperature variation, which may take months to accumulate for athletes in moderate climates. Shipping Tickets 1–3 delivers the full normalization pipeline with the default coefficient; Ticket 4 adds personalization.

---

## 10. Acceptance Criteria

### Ticket 1: `lib/envAdjust.ts`

- `computeHumidityPartialPressure(25, 80)` returns approximately `26.4` hPa (verify against formula)
- `computeEffectiveTemperature(22, 70)` returns a value > 22°C (Steadman correction applied)
- `computeEffectiveTemperature(20, 80)` returns `20.0` (boundary: temp exactly 20 → no correction)
- `computeEffectiveTemperature(25, 60)` returns `25.0` (boundary: humidity exactly 60 → no correction)
- `computeEffectiveTemperature(25, 61)` returns a value > 25°C (just above boundary → correction applied)
- `computePerformanceFactor(15, null)` returns `1.0`
- `computePerformanceFactor(14, null)` returns `1.0` (below baseline)
- `computePerformanceFactor(25, null)` returns `1 - 0.02 * 10 / 10 = 0.98`
- `computePerformanceFactor(25, null, 0.04)` returns `1 - 0.04 * 10 / 10 = 0.96`
- `computePerformanceFactor(50, null, 0.5)` returns `0.5` (clamp: unclamped = `1 - 0.5 * 35/10 = -0.75`, clamped to `0.5`)
- `computePerformanceFactor(40, null, 0.5)` returns `0.5` (clamp: unclamped = `1 - 0.5 * 25/10 = -0.25`, clamped to `0.5`)
- `computeAltitudeFactor(1500)` returns `1.0` (boundary: exactly 1500m)
- `computeAltitudeFactor(1499)` returns `1.0` (below threshold)
- `computeAltitudeFactor(2500)` returns `1 - 0.065 * (1000 / 1000) = 0.935`
- `normalizeTempEF(0.05, 15, null, null)` returns `{ efTempAdj: 0.05, efAltAdj: 0.05, performanceFactor: 1.0, altitudeFactor: 1.0 }`
- `normalizeTempEF(0.05, 25, null, null)` returns `efTempAdj ≈ 0.05/0.98 ≈ 0.05102`
- `fitHeatSensitivityK([])` returns `null`
- `fitHeatSensitivityK(Array of 30 runs, all at 20°C)` returns `null` (< 15°C range)
- `fitHeatSensitivityK(Array of 29 runs spanning 20°C range)` returns `null` (< 30 runs)
- `fitHeatSensitivityK(Array of 30 runs with known EF-vs-temp relationship)` returns expected k
- `npm test` passes

### Ticket 2: `lib/weatherApi.ts` + SQL + `lib/weatherRecalc.ts`

- `buildOpenMeteoUrl(51.5, -0.12, '2024-06-15')` returns a valid URL with correct query parameters
- `parseOpenMeteoResponse(mockResponse, '2024-06-15T07:30:00Z', 3600)` correctly extracts temperature at hour index 7
- `parseOpenMeteoResponse(mockResponse, '2024-06-15T07:30:00Z', 7200)` returns `midRunTempDelta` and `usedSegmentAdjustment = true` if delta > 3°C
- `parseOpenMeteoResponse` returns `null` for malformed response
- Cache hit: calling `fetchActivityWeather` twice with same args returns same result without second HTTP call (verified via mock)
- `sql/activity_weather.sql` runs without error on a clean Supabase instance
- Migration is idempotent (safe to run twice)
- `activity_weather` table exists with all columns from Section 5.1
- `athlete_parameters` has `heat_sensitivity_k DOUBLE PRECISION` column after migration
- `recalculateWeather()` runs without error against development Supabase
- Activities with `start_lat IS NULL` produce no `activity_weather` row (skipped)
- Activities where Open-Meteo returns an error result in null weather fields in `activity_weather`

### Ticket 3: `lib/efRecalc.ts` + `lib/ef.ts` + `lib/gapRecalc.ts`

- `lib/ef.ts` no longer exports `normalizeTempEF`
- `lib/efRecalc.ts` imports `normalizeTempEF` from `./envAdjust` (the `./ef` import line no longer includes `normalizeTempEF`)
- `lib/efRecalc.ts` has no duplicate import of `normalizeTempEF` — `tsc --noEmit` produces no errors
- Running `recalculateEF()` on a high-elevation activity: `ef_temp_adjusted` reflects altitude correction (i.e., equals `normResult.efAltAdj`, not `normResult.efTempAdj`)
- `backfillEFWithTempAdjustment()` stores `normResult.efAltAdj` in `ef_temp_adjusted` — identical value to what `recalculateEF()` step 3f stores for the same activity (no divergence between the two code paths)
- Running `recalculateEF()` on an activity that has a corresponding `activity_weather` row produces `temp_adjusted = true` and a non-null `ef_temp_adjusted` in `activity_ef`
- Running `recalculateEF()` on an activity with no `activity_weather` row but a device temperature: `temp_adjusted = true` using device temp as fallback
- Running `recalculateEF()` on an activity with no `activity_weather` row and no device temperature: `temp_adjusted = false`, `ef_temp_adjusted = null`
- `backfillEFWithTempAdjustment()` processes all `activity_ef` rows where `temp_adjusted = false AND temp_c IS NOT NULL`
- After backfill: all previously stub-processed rows have `temp_adjusted = true` and non-null `ef_temp_adjusted` (for rows with non-zero ef_value)
- Upsert is batched at 500 rows
- `triggerWeatherRecalc()` is exported from `lib/gapRecalc.ts` and called after `triggerEFRecalc()`
- `npm test` passes (no regressions)

### Ticket 4 (Optional): Personal Coefficient

- `fitAndStoreHeatSensitivityK()` returns `{ ok: true, k: undefined }` when < 30 qualifying outdoor runs exist
- `fitAndStoreHeatSensitivityK()` successfully upserts `heat_sensitivity_k` to `athlete_parameters` when sufficient data exists
- After fitting: subsequent `recalculateEF()` and `backfillEFWithTempAdjustment()` use the personal k instead of the default 0.02

---

## 11. Edge Cases and Error Handling

### 11.1 Open-Meteo API Unavailable

**Scenario:** `fetchActivityWeather()` receives a network error or non-200 response.

**Handling:**
- Catch all errors inside `fetchActivityWeather()`; return `null`
- In `recalculateWeather()`: upsert a row to `activity_weather` with all weather fields set to `null` and `used_segment_adjustment = false`
- In `recalculateEF()` step 3f: weather row exists but `temperature_celsius` is `null` → fall back to device temperature (`actRow.avg_temperature`). If device temperature is also `null` → `temp_adjusted = false, ef_temp_adjusted = null`
- In `backfillEFWithTempAdjustment()`: `activity_ef` rows with `temp_c IS NULL` are excluded from the backfill query by design
- **Never** use device temperature as the primary source; only as explicit fallback when Open-Meteo data is unavailable

### 11.2 Activity at Exactly 1500m Elevation

**Scenario:** `elevationM = 1500.0`

**Handling:**
- `computeAltitudeFactor(1500)` returns `1.0` (condition is `elevationM <= 1500`)
- `efAltAdj = efTempAdj * (1 / 1.0) = efTempAdj` — no altitude adjustment applied
- This is consistent with the PRD: "else 1.0" for the boundary case

### 11.3 Temperature at or Below 15°C

**Scenario:** `tempC = 15.0` or `tempC = 10.0`

**Handling:**
- `computeEffectiveTemperature(10, 80)` returns `10.0` (temp not > 20, no Steadman correction)
- `computePerformanceFactor(15, null)` returns `1.0` (condition is `T_eff <= 15`)
- `computePerformanceFactor(10, null)` returns `1.0` (below baseline)
- `efTempAdj = ef / 1.0 = ef` — no temperature adjustment applied

### 11.4 `humidity_pct` is `null`

**Scenario:** Open-Meteo API returned null for humidity (rare; network data gap).

**Handling:**
- `WeatherResult.humidityPct = null`
- `computePerformanceFactor(tempC, null, k)`: skip humidity correction, use `T_eff = tempC`
- Normalization still proceeds with temperature-only correction

### 11.5 `ef_value` is `null` or 0

**Scenario:** An `activity_ef` row has a null or zero `ef_value`.

**Handling:**
- In `backfillEFWithTempAdjustment()`: `if (!efRow.ef_value || efRow.ef_value <= 0) continue`
- Row is not updated; `temp_adjusted` remains `false`
- This prevents division by zero and avoids storing meaningless normalized values
- Note: `activity_ef.ef_value` has `NOT NULL` constraint, so `null` cannot appear from the upsert. The guard is defensive for any future schema relaxation.

### 11.6 Activity Duration < 1 Hour (Single Hourly Data Point)

**Scenario:** A 45-minute run provides only one hourly data point from Open-Meteo.

**Handling in `parseOpenMeteoResponse`:**
- `durationHours = Math.ceil(2700 / 3600) = 1`
- `hourlyTemps = [temperature_2m[startHourIndex]]` — single-element array
- `midRunTempDelta = null` (requires `hourlyTemps.length >= 2` to compute)
- `usedSegmentAdjustment = false`
- Activity temperature is still set from `temperature_2m[startHourIndex]` — this is valid

### 11.7 Activity with `null` `start_lat` / `start_lng` (Indoor)

**Scenario:** A treadmill run has `start_lat IS NULL`.

**Handling:**
- `recalculateWeather()` query filters `start_lat IS NOT NULL` — activity is excluded entirely
- No `activity_weather` row is created
- In `recalculateEF()` step 3f: no `activity_weather` row found → falls back to device temperature
- EF normalization is skipped only if device temperature is also null

### 11.8 Humidity Boundary Conditions

**Scenario:** `humidityPct = 60` with `tempC = 25`.

**Handling:**
- `computeEffectiveTemperature(25, 60)` — condition is `humidityPct > 60` (strictly greater than)
- Returns `25.0` (no correction applied at exactly 60%)

**Scenario:** `humidityPct = 61` with `tempC = 20`.

**Handling:**
- `computeEffectiveTemperature(20, 61)` — condition is `tempC > 20` (strictly greater than)
- Returns `20.0` (no correction applied at exactly 20°C)

### 11.9 Open-Meteo Hour Index Not Found

**Scenario:** Activity start time falls outside the returned hourly data (e.g., timezone offset places the activity outside the queried date range).

**Handling in `parseOpenMeteoResponse`:**
- `startHourIndex = -1` when `findIndex` fails
- Return `null`
- `fetchActivityWeather()` stores `null` in cache and returns `null`
- Weather fields in `activity_weather` are set to null

### 11.10 Performance Factor Clamped to 0.5 Minimum

**Scenario:** A high personal k from OLS fitting combined with high T_eff produces a performance factor below the physiological minimum.

**Scenario example:** `k = 0.5`, `T_eff = 40°C` → `1 - 0.5 * 25 / 10 = -0.25`. Without clamping, `ef / -0.25` produces a large negative `ef_temp_adjusted`, which is nonsensical.

**Handling in `computePerformanceFactor`:**
- Return value is `Math.max(0.5, 1 - k * (T_eff - 15) / 10)`
- The 0.5 floor is physiologically grounded: no competitive aerobic athlete loses more than 50% of their baseline fitness output to heat stress
- This clamp prevents downstream `ef / performanceFactor` from producing negative, near-zero, or astronomically large adjusted EF values when k is large
- `fitHeatSensitivityK()` clamps k to `Math.max(0, k)` (non-negative). The 0.5 floor on `performanceFactor` is a second, independent safety layer that guards against extreme-but-valid k values combined with high temperatures

---

## 12. Key Risks and Mitigations

### Risk 1: Open-Meteo Rate Limiting

**Risk:** Open-Meteo free tier may rate-limit requests when backfilling large historical archives. A typical athlete with 3 years of weekly outdoor runs = ~150 activities. Each is a separate API call.

**Mitigation:**
- The in-memory cache deduplicates requests for activities on the same day at the same location (e.g., track workouts)
- Sequential processing (no `Promise.all`) naturally spaces requests over time
- `recalculateWeather(fromDate?)` allows incremental processing — only new activities need to be fetched on subsequent runs
- On rate-limit response (HTTP 429): treat as API failure → `null` weather fields → activity will be retried on next `recalculateWeather()` call since `activity_weather` row will have null weather fields and no `temp_adjusted = true` in `activity_ef`
- A future enhancement could add a configurable delay between API calls; not required for MVP

### Risk 2: Open-Meteo Elevation vs. GPS Elevation Discrepancy

**Risk:** Open-Meteo's DEM-based elevation may differ from the GPS-recorded elevation in `garmin_activities`, particularly in urban canyons or for activities with significant elevation change within the bounding coordinate.

**Mitigation:**
- The PRD explicitly specifies Open-Meteo DEM elevation as the source. No fallback to GPS elevation is permitted.
- DEM-based elevation represents the terrain elevation at the activity's start coordinate, which is appropriate for altitude acclimatization effects (altitude factor applies to the entire run, not just the starting point)
- Discrepancies in hilly areas are acceptable; the altitude correction is a coarse adjustment, not a precision physiological model

### Risk 3: `normalizeTempEF` Signature Breaking Change

**Risk:** Removing `normalizeTempEF` from `lib/ef.ts` breaks any consumers that import it from there. Currently, only `lib/efRecalc.ts` imports it.

**Mitigation:**
- `lib/efRecalc.ts` is the only consumer — confirmed by grep of the codebase
- The import change is mechanical: replace `import { ..., normalizeTempEF } from './ef'` with `import { normalizeTempEF } from './envAdjust'`
- `npm test` will catch any missed consumers immediately

### Risk 4: `athlete_parameters` Schema Assumptions

**Risk:** The `fitAndStoreHeatSensitivityK()` upsert assumes `UNIQUE (athlete_id, sport)` on `athlete_parameters`. If this constraint does not exist or uses a different key, the upsert will fail.

**Mitigation:**
- The constraint is confirmed in `sql/athlete_parameters.sql`: `UNIQUE (athlete_id, sport)`
- The `sql/activity_weather.sql` migration uses `ADD COLUMN IF NOT EXISTS` for `heat_sensitivity_k` — idempotent
- If the upsert fails (e.g., no row yet for `(SINGLE_ATHLETE_ID, 'run')`), the `.upsert()` with `INSERT OR REPLACE` semantics will insert a new row with only the specified columns. Other PMC-specific columns (`tc_fitness`, `tc_fatigue`) will receive their `DEFAULT` values. This is acceptable — the PMC pipeline will overwrite them on its next run.

### Risk 5: Mid-Run Segment Adjustment Flagged But Not Applied

**Risk:** Activities with `used_segment_adjustment = true` are flagged but receive only a start-of-activity temperature correction, not a true per-segment adjustment. Athletes running in rapidly changing temperature conditions may be overcorrected or undercorrected.

**Mitigation:**
- `used_segment_adjustment` boolean in `activity_weather` provides full auditability
- The PRD-specified implementation requires per-segment adjustment for these cases; the actual execution is deferred due to missing lap-level absolute timestamps in the schema (see Section 4.3)
- This is documented as a scope decision in Section 13 and flagged for future work

---

## 13. Design Decisions

### Decision 1: `normalizeTempEF` Stub Removed From `lib/ef.ts`; Delegates to `lib/envAdjust.ts`

**Type:** Technical Decision
**Triggered by:** Section 7 stub shipped with old signature `(ef, tempC, refTempC?)`; Section 21 requires `(ef, tempC, humidityPct, elevationM, k?)`

**Decision:** Remove stub from `lib/ef.ts`. Consumers import `normalizeTempEF` directly from `lib/envAdjust.ts`. The Section 7 TDD documented this as the intended resolution path: "The seam is clean: only `lib/ef.ts:normalizeTempEF()` needs to change when Section 21 ships."

**Rationale:** The stub was intentionally minimal (always returned `ef` unchanged). Its removal does not break any real computation. The new function has a materially different signature that is not backward-compatible. A delegation wrapper would add indirection without benefit.

**Impact:**
- `lib/ef.ts`: remove lines 246–259
- `lib/efRecalc.ts`: update import source from `./ef` to `./envAdjust`

---

### Decision 2: Per-Segment Temperature Adjustment Deferred

**Type:** Scope Change
**Triggered by:** PRD specification for mid-run segment adjustment when delta > 3°C; missing lap-level absolute timestamps in schema

**Decision:** Store `used_segment_adjustment` boolean for auditability. Apply single start-of-activity temperature to EF normalization regardless of mid-run delta. Document as known limitation.

**Rationale:** `garmin_activity_laps` contains `elapsed_time_seconds` (relative to activity start) but not absolute timestamps. Implementing per-segment adjustment would require either (a) backfilling absolute timestamps from Garmin FIT data, or (b) computing a synthetic timestamp per lap from `start_time + elapsed_time_seconds`. Option (b) is feasible but introduces complexity that is out of scope for Section 21. The `used_segment_adjustment` flag marks these activities for future refinement.

**Impact:**
- TDD: `usedSegmentAdjustment` stored but EF normalization uses start temperature only
- PRD: clarification that per-segment adjustment is best-effort pending schema enhancement

---

### Decision 3: `heat_sensitivity_k` Stored as Named Column, Not Generic Key/Value

**Type:** Technical Decision
**Triggered by:** PRD states "Store in `athlete_parameters` (existing table, `key`/`value` pattern)" but existing schema uses named columns

**Decision:** Add `heat_sensitivity_k DOUBLE PRECISION` as a named column to `athlete_parameters` via migration. Do not implement a generic key/value pattern.

**Rationale:** The existing `athlete_parameters` table has named columns for all PMC parameters (`tc_fitness`, `tc_fatigue`, `k1`, `k2`, `intercept`). Adding a generic key/value pattern would require either (a) a schema redesign of `athlete_parameters` breaking existing PMC queries, or (b) a separate `athlete_kv_parameters` table. Neither is warranted for a single coefficient. Adding a named column is the least-invasive change and is consistent with the existing schema philosophy.

**Impact:**
- `sql/activity_weather.sql`: adds `ALTER TABLE athlete_parameters ADD COLUMN IF NOT EXISTS heat_sensitivity_k`
- `lib/weatherRecalc.ts`: upserts to `heat_sensitivity_k` column directly

---

### Decision 5: Open-Meteo Uses `timezone=UTC`; All Date/Hour Derivation in UTC

**Type:** Technical Decision
**Triggered by:** Staff Engineer 2 concern C1 (timezone mismatch in hour index extraction) and C2 (UTC date slicing for late-night-local activities)

**Decision:** Set `timezone=UTC` in the Open-Meteo URL (not `timezone=auto`). All date and hour derivation uses `new Date(startTimeISO).toISOString()` (UTC conversion). Both `start_date`/`end_date` query parameters and the `hourly.time` prefix match operate entirely in UTC.

**Rationale:** The hour-index extraction uses `toISOString().slice(0, 13)` to produce a UTC prefix. With `timezone=auto`, Open-Meteo returns local times, causing the UTC prefix match to fail for any non-UTC activity (`startHourIndex = -1` → null result). With `timezone=UTC`, the API returns UTC timestamps and the match is always correct. As a corollary, `start_date` must also be the UTC date (not the local date), which correctly handles late-night local runs whose UTC start falls on the next calendar day.

**Impact:**
- `lib/weatherApi.ts`: `buildOpenMeteoUrl` uses `timezone=UTC`
- `lib/weatherApi.ts`: `fetchActivityWeather` derives `date` as `new Date(startTimeISO).toISOString().slice(0, 10)`
- `lib/weatherApi.ts`: `parseOpenMeteoResponse` derives `dateHourPrefix` as `new Date(startTimeISO).toISOString().slice(0, 13)`

---

### Decision 6: `computePerformanceFactor` Clamped to Minimum of 0.5

**Type:** Technical Decision
**Triggered by:** Staff Engineer 2 concern C3 (fitted personal k can produce negative performance factor)

**Decision:** `computePerformanceFactor` returns `Math.max(0.5, 1 - k * (T_eff - 15) / 10)`. The minimum clamped value is `0.5`.

**Rationale:** `fitHeatSensitivityK()` returns a non-negative k but places no upper bound on it. A high k combined with high T_eff produces values below zero (e.g., k=0.5, T_eff=40°C → factor=-0.25). Without clamping, `ef / performanceFactor` returns a large negative number that appears valid and propagates silently into the database. The `0.5` floor is physiologically defensible (no aerobic athlete loses more than 50% of fitness output to heat stress). `Math.EPSILON` is not used because it allows near-zero factors that produce astronomically large adjusted EF values with different incorrect semantics.

**Impact:**
- `lib/envAdjust.ts`: `computePerformanceFactor` implementation and JSDoc
- `__tests__/envAdjust.test.ts`: new acceptance criteria for the clamp

---

### Decision 7: `ef_temp_adjusted` Column Stores `efAltAdj` (Full Environmental Normalization)

**Type:** Technical Decision
**Triggered by:** Staff Engineer 2 concern C4 (inconsistent ef_temp_adjusted assignment across two code paths)

**Decision:** `ef_temp_adjusted` in `activity_ef` always stores `normResult.efAltAdj` — the EF after all three corrections (temperature, humidity, altitude). Both `recalculateEF` step 3f and `backfillEFWithTempAdjustment` assign `efAltAdj`. The column name is a historical artifact of the Section 7 stub (which predated altitude correction); semantically it holds the fully normalized EF.

**Rationale:** Consumers of `ef_temp_adjusted` (e.g., PMC, fitness trend charts) want the cleanest possible EF signal with all environmental noise removed. Storing only `efTempAdj` (temperature + humidity only) would silently omit altitude correction for high-elevation activities. Storing `efAltAdj` is strictly more correct. Both code paths must agree to prevent divergent values for the same activity depending on which path wrote the row.

**Impact:**
- `lib/efRecalc.ts`: step 3f assigns `normResult.efAltAdj` to `efTempAdjusted`
- `lib/efRecalc.ts`: `backfillEFWithTempAdjustment` assigns `normResult.efAltAdj` to `ef_temp_adjusted`

---

### Decision 8: Remove `temp_c > 15` Filter From `fitAndStoreHeatSensitivityK` Query

**Type:** Technical Decision
**Triggered by:** Staff Engineer 2 concern C5 (cool-weather run exclusion reduces OLS regression stability)

**Decision:** Remove the `AND temp_c > 15` predicate from the `fitAndStoreHeatSensitivityK` SQL query. All qualifying runs with non-null EF and temperature are passed to `fitHeatSensitivityK()`.

**Rationale:** Cool-weather runs (tempC < 15) produce negative `x_i = tempC - 15` values in the OLS regressor. These anchor the regression and reduce variance in the estimated k. Filtering them out limits the regressor to only the high-temperature portion of the data, which reduces the effective temperature range and can inflate k estimates. The data-quality gate already in `fitHeatSensitivityK()` (tempRange >= 15, n >= 30) is sufficient; no pre-filtering at the query layer is needed.

**Impact:**
- `lib/weatherRecalc.ts`: `fitAndStoreHeatSensitivityK` query removes `AND temp_c > 15`

---

### Decision 4: Weather Fetch Triggered as Separate Pipeline Step, Not Inline in `recalculateEF`

**Type:** Technical Decision
**Triggered by:** Could fetch weather inline during `recalculateEF`; alternatively, separate pipeline in `weatherRecalc.ts`

**Decision:** Weather fetch lives in `lib/weatherRecalc.ts` and runs as a separate pipeline step after `recalculateEF()`, called via `triggerWeatherRecalc()` in `gapRecalc.ts`.

**Rationale:** Weather data is activity-level metadata that is independent of EF computation. Separating concerns allows:
1. Weather data to be fetched and cached independently (useful for other future sections, e.g., decoupling analysis by temperature)
2. `recalculateEF()` to remain independently executable without an HTTP dependency (useful for development and testing)
3. Re-running the weather pipeline without re-running full EF recalculation

The two-phase approach (fetch weather → backfill EF) is consistent with the Section 7 `backfillEFWithTempAdjustment` design intent.

**Impact:**
- `lib/gapRecalc.ts`: adds `triggerWeatherRecalc()` wrapper, called after `triggerEFRecalc()`
- `recalculateEF()` step 3f: reads from `activity_weather` (which must have been populated by `recalculateWeather()` before `recalculateEF()` runs with real normalization)
