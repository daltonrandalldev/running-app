# Section 21 — Environmental Adjustment (Heat, Humidity, Altitude): Implementation Ticket Prompts

**Author:** Prompt Engineer
**Date:** 2026-03-08
**TDD:** `docs/output/section-21-tech-design.md`
**Section:** 21 (Environmental Adjustment: Heat, Humidity, Altitude)

---

## Ticket 1

**ENV-001: Create the pure environmental adjustment calculation library (`lib/envAdjust.ts`) and its unit tests (`__tests__/envAdjust.test.ts`).**

### Summary

Write `lib/envAdjust.ts` — a zero-I/O, zero-external-dependency TypeScript module — exporting all 6 functions and 1 interface specified below. Write `__tests__/envAdjust.test.ts` using Jest, covering every function including boundary conditions and the OLS regression fit. No imports from Supabase, AsyncStorage, or React Native are permitted anywhere in `lib/envAdjust.ts`.

The file header must state: "Pure TypeScript module — zero I/O, zero external dependencies."

### Branch

`feature/env-001`

### Files to Create

- `lib/envAdjust.ts`
- `__tests__/envAdjust.test.ts`

### Types and Exports

**Type definitions (export from `lib/envAdjust.ts`):**

```typescript
export interface EnvNormalizationResult {
  efTempAdj: number;          // EF after temperature + humidity correction
  efAltAdj: number;           // EF after all corrections (temperature + humidity + altitude)
  performanceFactor: number;  // Factor applied for temp/humidity (< 1.0 means heat penalty)
  altitudeFactor: number;     // Factor applied for altitude (> 1.0 means altitude penalty)
}
```

**Function signatures (implement all 6):**

```typescript
export function computeHumidityPartialPressure(tempC: number, humidityPct: number): number

export function computeEffectiveTemperature(tempC: number, humidityPct: number): number

export function computePerformanceFactor(tempC: number, humidityPct: number | null, k?: number): number

export function computeAltitudeFactor(elevationM: number): number

export function normalizeTempEF(
  ef: number,
  tempC: number,
  humidityPct: number | null,
  elevationM: number | null,
  k?: number,
): EnvNormalizationResult

export function fitHeatSensitivityK(
  runs: Array<{ efValue: number; tempC: number }>,
): number | null
```

### Implementation Specifications

**`computeHumidityPartialPressure(tempC, humidityPct)`**

Compute the vapor pressure (hPa) using the August-Roche-Magnus approximation as used in Steadman (1979).

```typescript
return (humidityPct / 100) * 6.105 * Math.exp(17.27 * tempC / (237.7 + tempC));
```

**`computeEffectiveTemperature(tempC, humidityPct)`**

Compute effective temperature using Steadman (1979). Only applied when humidity > 60 AND temp > 20. These are strictly greater-than comparisons on both conditions — exactly 60% humidity or exactly 20°C does not trigger the correction.

```typescript
if (humidityPct <= 60 || tempC <= 20) return tempC;
return tempC + (0.33 * computeHumidityPartialPressure(tempC, humidityPct)) - 4.0;
```

**`computePerformanceFactor(tempC, humidityPct, k = 0.02)`**

Compute the performance factor representing physiological output suppression relative to the 15°C baseline. A factor of 0.98 means the athlete is running at 98% of their true fitness capability due to heat stress.

Implementation steps:
1. Compute `T_eff`:
   - If `humidityPct` is non-null: `T_eff = computeEffectiveTemperature(tempC, humidityPct)`
   - If `humidityPct` is null: `T_eff = tempC` (skip humidity correction)
2. If `T_eff <= 15`: return `1.0`
3. Otherwise: `return Math.max(0.5, 1 - k * (T_eff - 15) / 10)`

The result is clamped to a minimum of `0.5`. The default `k = 0.02` produces physiologically plausible values for all real-world temperatures, but `fitHeatSensitivityK()` can return larger k values from OLS regression on individual athlete data. A high k combined with a high T_eff produces a negative factor (e.g., `k = 0.5`, `T_eff = 40°C` → `1 - 0.5 * 25/10 = -0.25`). The 0.5 floor is physiologically grounded: no competitive aerobic athlete loses more than 50% of their baseline fitness output to heat stress.

**`computeAltitudeFactor(elevationM)`**

Compute the altitude correction factor. At or below 1500m the factor is 1.0 (no correction). The boundary is inclusive — exactly 1500m does not trigger the correction.

```typescript
if (elevationM <= 1500) return 1.0;
return 1 - 0.065 * ((elevationM - 1500) / 1000);
```

**`normalizeTempEF(ef, tempC, humidityPct, elevationM, k = 0.02)`**

Apply all environmental corrections to a raw EF value in sequence: temperature + humidity correction first, then altitude correction.

```typescript
const performanceFactor = computePerformanceFactor(tempC, humidityPct, k);
const altitudeFactor = computeAltitudeFactor(elevationM ?? 0);
const efTempAdj = ef / performanceFactor;
const efAltAdj = efTempAdj * (1 / altitudeFactor);
return { efTempAdj, efAltAdj, performanceFactor, altitudeFactor };
```

When `performanceFactor = 1.0` and `altitudeFactor = 1.0` (cool, low-elevation activity), all four returned values are numerically equal to the input `ef` — the function is a no-op in that case.

**`fitHeatSensitivityK(runs)`**

Fit a personal heat sensitivity coefficient k via OLS regression. Regresses EF against temperature to derive the per-athlete k coefficient that best explains observed EF suppression at elevated temperatures.

Returns `null` when:
- Fewer than 30 qualifying outdoor runs are provided
- The temperature range across provided runs is < 15°C (insufficient range to distinguish heat effect from noise)

Implementation steps:
1. Check `runs.length < 30` → return `null`
2. Compute temp range: `max(tempC) - min(tempC)`. If `< 15` → return `null`
3. Compute `efMean = mean(efValue)`
4. For each run, compute `x_i = tempC_i - 15`
5. OLS slope: `slope = Σ(x_i * (efValue_i - efMean)) / Σ(x_i^2)`
6. `k = -slope` (negative because heat reduces EF — slope of EF vs. temp is negative — but k is defined as positive in the performance factor formula)
7. Return `Math.max(0, k)` — k must be non-negative (heat cannot improve performance in this model)

The regression uses all runs including cool-weather ones. Cool-weather runs (tempC < 15) produce negative `x_i` values that anchor the regression and improve OLS stability. Do not filter them out before passing to this function.

### Test Requirements (`__tests__/envAdjust.test.ts`)

Write Jest tests. All tests are pure — no Supabase, no AsyncStorage, no React Native imports.

**`computeHumidityPartialPressure`**
- `computeHumidityPartialPressure(25, 80)` ≈ `26.4` hPa (verify against formula; tolerance ±0.1)
- `computeHumidityPartialPressure(0, 100)` is a positive number (boundary: freezing)
- `computeHumidityPartialPressure(25, 0)` returns `0` (zero humidity → zero vapor pressure)

**`computeEffectiveTemperature`**
- `computeEffectiveTemperature(22, 70)` returns a value > 22°C (Steadman correction applied: temp > 20 AND humidity > 60)
- `computeEffectiveTemperature(20, 80)` returns `20.0` (boundary: temp exactly 20 → no correction; guard is `tempC <= 20`)
- `computeEffectiveTemperature(25, 60)` returns `25.0` (boundary: humidity exactly 60 → no correction; guard is `humidityPct <= 60`)
- `computeEffectiveTemperature(25, 61)` returns a value > 25°C (just above humidity boundary → correction applied)
- `computeEffectiveTemperature(20.001, 61)` returns a value > 20.001°C (just above temp boundary → correction applied)

**`computePerformanceFactor`**
- `computePerformanceFactor(15, null)` returns `1.0` (at baseline)
- `computePerformanceFactor(14, null)` returns `1.0` (below baseline)
- `computePerformanceFactor(25, null)` returns `0.98` (1 - 0.02 * 10 / 10)
- `computePerformanceFactor(25, null, 0.04)` returns `0.96` (1 - 0.04 * 10 / 10)
- `computePerformanceFactor(50, null, 0.5)` returns `0.5` (clamp: unclamped = `1 - 0.5 * 35/10 = -0.75`, clamped to `0.5`)
- `computePerformanceFactor(40, null, 0.5)` returns `0.5` (clamp: unclamped = `1 - 0.5 * 25/10 = -0.25`, clamped to `0.5`)

**`computeAltitudeFactor`**
- `computeAltitudeFactor(1500)` returns `1.0` (boundary: exactly 1500m → no correction)
- `computeAltitudeFactor(1499)` returns `1.0` (below threshold)
- `computeAltitudeFactor(0)` returns `1.0` (sea level)
- `computeAltitudeFactor(2500)` returns `0.935` (1 - 0.065 * (1000/1000))
- `computeAltitudeFactor(3000)` returns `1 - 0.065 * 1.5 = 0.9025`

**`normalizeTempEF`**
- `normalizeTempEF(0.05, 15, null, null)` returns `{ efTempAdj: 0.05, efAltAdj: 0.05, performanceFactor: 1.0, altitudeFactor: 1.0 }` (no-op at baseline temp, sea level)
- `normalizeTempEF(0.05, 25, null, null)` returns `efTempAdj ≈ 0.05/0.98 ≈ 0.051020`; `efAltAdj = efTempAdj` (no altitude correction); `performanceFactor = 0.98`; `altitudeFactor = 1.0`
- `normalizeTempEF(0.05, 25, null, 1646)` returns `efAltAdj > efTempAdj > 0.05` (both heat and altitude corrections applied — elevation 1646m is above the 1500m threshold)
- `normalizeTempEF(0.05, 10, null, 1000)` returns `{ efTempAdj: 0.05, efAltAdj: 0.05, ... }` (no corrections: temp below 15, elevation below 1500)

**`fitHeatSensitivityK`**
- `fitHeatSensitivityK([])` returns `null` (empty input)
- `fitHeatSensitivityK` with 29 runs spanning 20°C temperature range returns `null` (n < 30)
- `fitHeatSensitivityK` with 30 runs all at 20°C returns `null` (tempRange = 0, < 15)
- `fitHeatSensitivityK` with 30 runs spanning only 10°C returns `null` (tempRange < 15)
- `fitHeatSensitivityK` with 30 runs where EF and temperature have a known linear relationship returns expected k (construct a synthetic dataset where k = 0.03 and verify the OLS returns ≈ 0.03 within tolerance ±0.005)
- `fitHeatSensitivityK` with 30 runs where EF increases with temperature (anomalous data, negative slope) returns `0` (clamped from negative k)

### Acceptance Criteria

1. `lib/envAdjust.ts` file header states: "Pure TypeScript module — zero I/O, zero external dependencies."
2. All 6 functions and the `EnvNormalizationResult` interface are exported.
3. `computeEffectiveTemperature` uses strictly greater-than comparisons: `humidityPct <= 60 || tempC <= 20` as the guard for no-correction (i.e., correction only when humidity > 60 AND temp > 20).
4. `computePerformanceFactor(50, null, 0.5)` returns `0.5` (clamped — unclamped would be -0.75).
5. `computePerformanceFactor(25, null)` returns `0.98`.
6. `computeEffectiveTemperature(20, 80)` returns `20.0` (temp exactly 20 → no correction).
7. `computeEffectiveTemperature(25, 60)` returns `25.0` (humidity exactly 60 → no correction).
8. `computeAltitudeFactor(1500)` returns `1.0`.
9. `computeAltitudeFactor(2500)` returns `0.935`.
10. `normalizeTempEF(0.05, 25, null, 1646)` returns `efAltAdj > efTempAdj > 0.05`.
11. `fitHeatSensitivityK([])` returns `null`.
12. `fitHeatSensitivityK` with 30 runs all at 20°C returns `null` (tempRange < 15).
13. `fitHeatSensitivityK` with 29 runs spanning a large temp range returns `null` (n < 30).
14. No imports from Supabase, AsyncStorage, or React Native in `lib/envAdjust.ts`.
15. `npm test` passes with all new tests green.

### Dependencies

None. This ticket is a prerequisite for ENV-002 and ENV-003. It has no runtime dependency on any existing file other than the TypeScript compiler.

### Gotchas and Edge Cases

- The `humidityPct` parameter in `computePerformanceFactor` and `normalizeTempEF` is `number | null`. When null, skip the Steadman humidity correction and use `T_eff = tempC` directly — do not pass null to `computeEffectiveTemperature`.
- The `elevationM` parameter in `normalizeTempEF` is `number | null`. Use `elevationM ?? 0` when calling `computeAltitudeFactor` — elevation null is treated as sea level (0m), producing `altitudeFactor = 1.0`.
- In `fitHeatSensitivityK`, the OLS numerator is `Σ(x_i * (efValue_i - efMean))` and denominator is `Σ(x_i^2)`. The negation (`k = -slope`) is required because the slope of EF vs. temperature is expected to be negative (higher temp → lower EF), but k by definition must be positive.
- Do not filter cool-weather runs before passing data to `fitHeatSensitivityK`. The function itself enforces the data-quality gate via the `tempRange >= 15` and `n >= 30` checks.

---

## Ticket 2

**ENV-002: Implement the Open-Meteo API client (`lib/weatherApi.ts`), the SQL migration (`sql/activity_weather.sql`), and the weather recalculation pipeline (`lib/weatherRecalc.ts`).**

### Summary

Write three new files: `lib/weatherApi.ts` (async HTTP client, no Supabase), `sql/activity_weather.sql` (idempotent schema migration), and `lib/weatherRecalc.ts` (Supabase I/O layer for weather fetch and personal coefficient fitting). Write `__tests__/weatherApi.test.ts` covering URL construction, response parsing, and cache behavior using mock HTTP responses — no real network calls in tests.

This ticket depends on ENV-001. `lib/weatherRecalc.ts` imports `fitHeatSensitivityK` from `lib/envAdjust.ts`.

### Branch

`feature/env-002`

### Files to Create

- `lib/weatherApi.ts`
- `lib/weatherRecalc.ts`
- `sql/activity_weather.sql`
- `__tests__/weatherApi.test.ts`

### Depends On

ENV-001 (`lib/envAdjust.ts` must exist — specifically `fitHeatSensitivityK`).

---

### Part A: `lib/weatherApi.ts`

File header: "Open-Meteo API client — no Supabase, no I/O side effects beyond HTTP fetch."

#### Types

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

#### `buildOpenMeteoUrl(lat, lng, date)`

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

The URL format (use `timezone=UTC` — NOT `timezone=auto`):

```
https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lng}&start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}&hourly=temperature_2m,relativehumidity_2m,windspeed_10m,winddirection_10m&timezone=UTC
```

`start_date` and `end_date` are both set to the same value (the activity's UTC date — single-day query).

**Why `timezone=UTC` and not `timezone=auto`:** Open-Meteo with `timezone=auto` returns local times in `hourly.time`. The hour-index extraction logic uses `new Date(startTimeISO).toISOString().slice(0, 13)` which produces a UTC prefix. If local times were returned by the API, this prefix match would fail for any activity outside UTC — producing `startHourIndex = -1` and a null result for every non-UTC activity. Using `timezone=UTC` causes Open-Meteo to return UTC timestamps, making the prefix match correct for all activities regardless of the local timezone at the activity location.

#### `parseOpenMeteoResponse(responseJson, startTimeISO, durationSeconds)`

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

The Open-Meteo response structure:

```json
{
  "elevation": 245.3,
  "hourly": {
    "time": ["2024-06-15T00:00", "2024-06-15T01:00", "..."],
    "temperature_2m": [18.2, 17.9, "..."],
    "relativehumidity_2m": [72, 75, "..."],
    "windspeed_10m": [8.4, 7.1, "..."],
    "winddirection_10m": [215, 220, "..."]
  }
}
```

Hour index extraction — all UTC:

```typescript
// Extract UTC hour prefix from startTimeISO
const startHourPrefix = new Date(startTimeISO).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
const startHourIndex = hourly.time.findIndex((t: string) => t.startsWith(startHourPrefix));
if (startHourIndex === -1) return null;  // Activity hour not found in response

const durationHours = Math.ceil(durationSeconds / 3600);
const hourlyTemps = temperature_2m.slice(startHourIndex, startHourIndex + durationHours);

// Activity temperature = start-of-activity hour
const temperatureCelsius = temperature_2m[startHourIndex] ?? null;

// Mid-run delta: max - min over the activity's hourly range
const midRunTempDelta = hourlyTemps.length >= 2
  ? Math.max(...hourlyTemps) - Math.min(...hourlyTemps)
  : null;
const usedSegmentAdjustment = midRunTempDelta !== null && midRunTempDelta > 3;
```

**Note on `usedSegmentAdjustment`:** When this flag is true, the temperature stored in `activity_weather.temperature_celsius` is still the start-of-activity hour temperature. The segment adjustment flag is stored for audit purposes only. Per-segment normalization using lap-level timestamps is out of scope for this section.

Full return value:

```typescript
return {
  temperatureCelsius: temperature_2m[startHourIndex] ?? null,
  humidityPct: relativehumidity_2m[startHourIndex] ?? null,
  windSpeedKmh: windspeed_10m[startHourIndex] ?? null,
  windDirectionDeg: winddirection_10m[startHourIndex] ?? null,
  elevationM: responseJson.elevation ?? null,
  midRunTempDelta,
  usedSegmentAdjustment,
  hourlyTemps,
};
```

Return `null` for any malformed response (missing `hourly`, missing `hourly.time`, or `startHourIndex === -1`).

#### In-Memory Cache

```typescript
// Module-level cache (lives for the duration of a single pipeline run)
const weatherCache = new Map<string, WeatherResult | null>();

function cacheKey(lat: number, lng: number, date: string): string {
  return `${lat},${lng},${date}`;
}
```

Cache behavior:
- Before fetching: check `weatherCache.get(cacheKey(...))`. If present (including `null` sentinel), return cached value immediately without making an HTTP call.
- After fetching: store result (or `null` on error) in cache before returning.
- Cache is module-level (not persisted across process restarts). It prevents redundant API calls within a single `recalculateWeather()` invocation (e.g., multiple activities at the same location on the same day — common for track workouts).

#### `fetchActivityWeather(lat, lng, startTimeISO, durationSeconds)`

```typescript
/**
 * Fetch weather conditions for a single activity from the Open-Meteo archive API.
 *
 * Returns null on any error (API unavailable, network failure, parse error,
 * or missing hourly data for the activity's time slot). Never throws.
 *
 * Uses in-memory cache keyed by (lat, lng, date) to avoid redundant API calls.
 */
export async function fetchActivityWeather(
  lat: number,
  lng: number,
  startTimeISO: string,
  durationSeconds: number,
): Promise<WeatherResult | null>
```

Implementation:
1. Derive `date` from `startTimeISO`: `new Date(startTimeISO).toISOString().slice(0, 10)` (UTC date)
2. Check cache via `weatherCache.get(cacheKey(lat, lng, date))`. If present, return it.
3. Build URL via `buildOpenMeteoUrl(lat, lng, date)`
4. `fetch(url)` — use the global `fetch` (available in React Native / Expo environments)
5. On non-200 response or network error: store `null` in cache, return `null`
6. Parse JSON; call `parseOpenMeteoResponse(json, startTimeISO, durationSeconds)`
7. Store result (or `null` on parse failure) in cache
8. Return result

All errors are caught inside this function. It never throws to callers.

---

### Part B: `sql/activity_weather.sql`

Write an idempotent migration. Use `IF NOT EXISTS` for all `CREATE TABLE` and `CREATE INDEX` statements. End with `NOTIFY pgrst, 'reload schema';`.

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

-- Access control (RLS disabled — consistent with all other tables)
GRANT SELECT, INSERT, UPDATE ON activity_weather TO anon, authenticated;

ALTER TABLE activity_weather DISABLE ROW LEVEL SECURITY;

-- Add heat_sensitivity_k column to athlete_parameters for personal coefficient storage
ALTER TABLE athlete_parameters
    ADD COLUMN IF NOT EXISTS heat_sensitivity_k DOUBLE PRECISION;

NOTIFY pgrst, 'reload schema';
```

**Schema notes:**
- `activity_id TEXT PRIMARY KEY` — TEXT type matches `activity_ef.activity_id` and the `String(actRow.activity_id)` conversion pattern used throughout the codebase.
- No SERIAL surrogate key — this table uses the natural primary key since each activity has exactly one weather record.
- `fetched_at DEFAULT now()` — set automatically on insert; not included in upsert payload.
- The `ALTER TABLE athlete_parameters ADD COLUMN IF NOT EXISTS heat_sensitivity_k` is part of this migration. It is idempotent. The `UNIQUE (athlete_id, sport)` constraint on `athlete_parameters` already exists; the new column is used by `fitAndStoreHeatSensitivityK()`.

---

### Part C: `lib/weatherRecalc.ts`

Follows the same pattern as `gapRecalc.ts` and `efRecalc.ts`: singleton Supabase client, try/catch on every exported async function, sequential (no `Promise.all`) batch processing.

#### Module Constants

```typescript
/** Placeholder athlete ID used until authentication is implemented. */
const SINGLE_ATHLETE_ID = '00000000-0000-0000-0000-000000000001';

/** Batch size for upsert operations (matches gapRecalc.ts / efRecalc.ts pattern). */
const BATCH_SIZE = 500;

/** athlete_parameters key for the personal heat sensitivity coefficient. */
const HEAT_SENSITIVITY_KEY = 'heat_sensitivity_k';
```

`HEAT_SENSITIVITY_KEY` is defined as a named constant for documentation purposes even though it is used as a column name directly.

#### Return-Type Interfaces

```typescript
export interface WeatherRecalcResult {
  ok: boolean;
  activitiesProcessed?: number;   // Activities with weather successfully fetched
  activitiesSkipped?: number;     // Indoor activities (null start_lat) or API failures
  errors?: number;
  error?: string;
}
```

#### `recalculateWeather(fromDate?)`

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

**Step 1 — Fetch outdoor activities**

Query `garmin_activities` for all activities with:
- `start_lat IS NOT NULL` AND `start_lng IS NOT NULL` (outdoor activities only)
- `sport ILIKE '%run%'` (consistent with `efRecalc.ts` sport filter)
- Optional `.gte('start_time', fromDate)` when `fromDate` is provided

Columns to select: `activity_id, start_lat, start_lng, start_time, moving_time_seconds`

**Step 2 — Per-activity weather fetch (sequential)**

For each activity row:
1. Call `fetchActivityWeather(start_lat, start_lng, start_time, moving_time_seconds ?? 0)`
2. Build the upsert row regardless of whether the result is null or non-null

**Step 3 — Batch upsert to `activity_weather`**

Accumulate rows and upsert in batches of 500 with `onConflict: 'activity_id'`:

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
```

Note: `fetched_at` is set by `DEFAULT now()` on the database side and is not included in the upsert payload.

When `weatherResult` is `null` (API failure), all weather columns are set to null. The row is still upserted so the activity is marked as attempted.

**Step 4 — Trigger EF backfill**

After all activities have been processed and upserted:

```typescript
await backfillEFWithTempAdjustment();
```

Import `backfillEFWithTempAdjustment` from `./efRecalc`. This function is currently a stub (returns `{ ok: true, count: 0 }`) — ENV-003 replaces the stub. This import is correct: it calls whatever is currently exported from `efRecalc.ts`.

Return `WeatherRecalcResult` with counters.

#### `fitAndStoreHeatSensitivityK()`

```typescript
/**
 * Fit a personal heat sensitivity coefficient and store it in athlete_parameters.
 *
 * Reads all qualifying activity_ef rows that have a valid ef_value and temp_c,
 * calls fitHeatSensitivityK() from lib/envAdjust.ts, and upserts the result
 * to athlete_parameters.heat_sensitivity_k.
 *
 * Returns { ok: true, k: undefined } when insufficient data (< 30 outdoor runs
 * or < 15°C temperature range). Does not upsert in this case.
 *
 * Intended to be called quarterly. The caller is responsible for scheduling.
 */
export async function fitAndStoreHeatSensitivityK(): Promise<{
  ok: boolean;
  k?: number;
  error?: string;
}>
```

**Step 1 — Fetch qualifying EF rows with temperature**

```typescript
const { data: rows, error } = await supabase
  .from('activity_ef')
  .select('ef_value, temp_c')
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('qualifying', true)
  .not('ef_value', 'is', null)
  .not('temp_c', 'is', null);
```

Do NOT add a `.gt('temp_c', 15)` filter. Cool-weather runs (tempC < 15) produce negative `x_i = tempC - 15` values in the OLS regressor that anchor the fit and improve stability. All qualifying runs with non-null EF and temperature are passed to `fitHeatSensitivityK()`.

**Step 2 — Fit coefficient**

```typescript
import { fitHeatSensitivityK } from './envAdjust';

const k = fitHeatSensitivityK(
  (rows ?? []).map(r => ({ efValue: r.ef_value, tempC: r.temp_c }))
);
if (k === null) return { ok: true, k: undefined };
```

**Step 3 — Upsert to `athlete_parameters`**

```typescript
const { error: upsertErr } = await supabase
  .from('athlete_parameters')
  .upsert(
    {
      athlete_id: SINGLE_ATHLETE_ID,
      sport: 'run',
      heat_sensitivity_k: k,
    },
    { onConflict: 'athlete_id,sport' },
  );
if (upsertErr) throw upsertErr;
return { ok: true, k };
```

The `athlete_parameters` table has `UNIQUE (athlete_id, sport)`. The upsert uses this constraint. Other PMC-specific columns (`tc_fitness`, `tc_fatigue`, etc.) are not touched — only `heat_sensitivity_k` is updated.

---

### Part D: `__tests__/weatherApi.test.ts`

Write Jest tests. All tests use mock responses — no real HTTP calls. Mock `fetch` using Jest's module mocking.

**`buildOpenMeteoUrl`**
- `buildOpenMeteoUrl(51.5, -0.12, '2024-06-15')` returns a URL containing `timezone=UTC` (NOT `timezone=auto`)
- URL contains `latitude=51.5&longitude=-0.12` (or equivalent encoding)
- URL contains `start_date=2024-06-15&end_date=2024-06-15`
- URL contains `temperature_2m,relativehumidity_2m,windspeed_10m,winddirection_10m` in the `hourly` parameter
- URL base is `https://archive-api.open-meteo.com/v1/archive`

**`parseOpenMeteoResponse`**
- Correctly extracts `temperature_celsius` at hour index 7 for `startTimeISO = '2024-06-15T07:30:00Z'` with a mock response whose `hourly.time[7]` starts with `'2024-06-15T07'`
- Returns `midRunTempDelta` and `usedSegmentAdjustment = true` when a 2-hour activity has hourly temps `[20, 25]` (delta = 5 > 3)
- Returns `usedSegmentAdjustment = false` when delta ≤ 3
- Returns `midRunTempDelta = null` for a 45-minute activity (single hourly data point, `hourlyTemps.length < 2`)
- Returns `null` when `startHourIndex === -1` (start time not found in hourly.time)
- Returns `null` for a malformed response (missing `hourly` field)
- Correctly reads `elevationM` from the response root `elevation` field

**Cache behavior**
- Calling `fetchActivityWeather` twice with the same `lat`, `lng`, and `startTimeISO` (same UTC date) only triggers one actual `fetch` call (second call hits cache)
- Calling `fetchActivityWeather` with a different `startTimeISO` on a different UTC date triggers a second `fetch` call

### Acceptance Criteria

1. `buildOpenMeteoUrl` always includes `timezone=UTC` (not `timezone=auto`).
2. Hour prefix is extracted as UTC `YYYY-MM-DDTHH` using `new Date(startTimeISO).toISOString().slice(0, 13)`.
3. `parseOpenMeteoResponse` returns `null` when `startHourIndex === -1`.
4. Cache prevents a second HTTP call for the same `lat`, `lng`, and date (verified by mock call count).
5. `fetchActivityWeather` never throws — all errors result in `null`.
6. `sql/activity_weather.sql` runs without error on a clean Supabase instance.
7. `sql/activity_weather.sql` is idempotent (safe to run twice without error).
8. `activity_weather` table has all columns: `activity_id, athlete_id, temperature_celsius, humidity_pct, wind_speed_kmh, wind_direction_deg, elevation_m, mid_run_temp_delta, used_segment_adjustment, fetched_at`.
9. `activity_weather.used_segment_adjustment` has `NOT NULL DEFAULT false`.
10. `athlete_parameters` gains `heat_sensitivity_k DOUBLE PRECISION` column after migration.
11. `idx_activity_weather_athlete` index exists on `activity_weather (athlete_id)`.
12. RLS is disabled on `activity_weather`; `anon` and `authenticated` are granted `SELECT, INSERT, UPDATE`.
13. `recalculateWeather()` runs without error against development Supabase.
14. Activities with `start_lat IS NULL` produce no `activity_weather` row (excluded by query filter).
15. Activities where Open-Meteo returns an error result in null weather columns in `activity_weather` (row is still upserted).
16. `fitAndStoreHeatSensitivityK()` returns `{ ok: true, k: undefined }` when fewer than 30 qualifying outdoor runs exist.
17. `npm test` passes with all new tests green.

### Dependencies

- ENV-001 (`lib/envAdjust.ts`) — `fitHeatSensitivityK` is imported by `lib/weatherRecalc.ts`.
- `sql/activity_ef.sql` must have been run (the `activity_ef` table is queried by `fitAndStoreHeatSensitivityK`).

### Gotchas and Edge Cases

- `fetchActivityWeather` derives the UTC date for the cache key and the API query using `new Date(startTimeISO).toISOString().slice(0, 10)`. This is the UTC calendar date. For a late-night local run (e.g., 22:00 UTC-4 → UTC start is 02:00Z the next day), the UTC date correctly identifies the API day containing the activity's UTC start hour.
- The `fetch` global is available in React Native / Expo environments. Do not import a fetch polyfill.
- When upserting to `activity_weather`, do not include `fetched_at` in the payload — it is set by `DEFAULT now()` on the database side and updates automatically on conflict.
- `backfillEFWithTempAdjustment` imported in `lib/weatherRecalc.ts` from `./efRecalc` is currently a stub (ENV-003 replaces it). The import is correct regardless — `recalculateWeather` calls whatever is exported from `efRecalc.ts` at runtime.
- Run the SQL migration in the Supabase SQL editor before testing `recalculateWeather()` or `fitAndStoreHeatSensitivityK()` against development Supabase.

---

## Ticket 3

**ENV-003: Wire real environmental normalization into `lib/efRecalc.ts`, remove the `normalizeTempEF` stub from `lib/ef.ts`, and add `triggerWeatherRecalc()` to `lib/gapRecalc.ts`.**

### Summary

Replace the Section 7 `normalizeTempEF` stub with real environmental normalization from `lib/envAdjust.ts`. This ticket requires four coordinated changes across three files — all four changes must land in the same commit to avoid TypeScript compilation errors. Also add `triggerWeatherRecalc()` as a thin wrapper in `lib/gapRecalc.ts` and wire it into the post-GAP call chain.

### Branch

`feature/env-003`

### Files to Modify

- `lib/ef.ts` — remove the `normalizeTempEF` stub (lines 246–259 in the Section 7 implementation)
- `lib/efRecalc.ts` — atomic import edit + heatK read + step 3f replacement + backfill implementation
- `lib/gapRecalc.ts` — add `triggerWeatherRecalc()` export and call after `triggerEFRecalc()`

### Depends On

ENV-001 (`lib/envAdjust.ts`) and ENV-002 (`lib/weatherRecalc.ts`, `sql/activity_weather.sql` must be migrated).

---

### Change 1: Remove `normalizeTempEF` Stub from `lib/ef.ts`

Read `lib/ef.ts` in full before editing. The file currently exports a stub function `normalizeTempEF(ef, tempC, refTempC?)` (around lines 246–259) that returns `ef` unchanged. It includes a TODO comment referencing Section 21.

**Remove the entire `normalizeTempEF` function from `lib/ef.ts`.** No other changes to `lib/ef.ts`. The `TODO` comment at the polynomial extension point (around line 222) is unrelated and must be left as-is.

After removal, `lib/ef.ts` must NOT export a function named `normalizeTempEF`. TypeScript compilation (`tsc --noEmit`) must confirm this.

---

### Change 2: Atomic Import Edit in `lib/efRecalc.ts`

Read `lib/efRecalc.ts` in full before editing. The current import block at the top of the file contains:

```typescript
import {
  calculateEFFromLaps,
  isQualifyingRun,
  computeRollingEFAvg,
  computeEFRegression,
  detectEFAlert,
  normalizeTempEF,
  type EFLapRecord,
} from './ef';
```

This is an **atomic change** — removing `normalizeTempEF` from the `./ef` import AND adding the `./envAdjust` import must be done in the same edit. Leaving `normalizeTempEF` in only the `./ef` import (which no longer exports it after Change 1) produces a TypeScript "Module has no exported member" error. Adding the `./envAdjust` import without removing from `./ef` would produce a duplicate-identifier error if both imports exist simultaneously.

**Replace the single `./ef` import line with two import lines:**

```typescript
import {
  calculateEFFromLaps,
  isQualifyingRun,
  computeRollingEFAvg,
  computeEFRegression,
  detectEFAlert,
  type EFLapRecord,
} from './ef';
import { normalizeTempEF, type EnvNormalizationResult } from './envAdjust';
```

The `EFResult` type import mentioned in the TDD design note is only needed if used elsewhere in the file — check the current file and include it only if it is already in the import.

---

### Change 3: Update `recalculateEF()` in `lib/efRecalc.ts`

**Read the current `recalculateEF()` implementation before editing.** The current file is included here for reference.

**3a. Add `heatK` read at the start of `recalculateEF()`, before the activity loop:**

Place this immediately after the HR zones resolution (Step 1) and before the activity fetch (Step 2):

```typescript
// Read personal heat sensitivity coefficient (default 0.02 if not yet fitted)
const { data: paramsRow } = await supabase
  .from('athlete_parameters')
  .select('heat_sensitivity_k')
  .eq('athlete_id', SINGLE_ATHLETE_ID)
  .eq('sport', 'run')
  .maybeSingle();
const heatK: number = paramsRow?.heat_sensitivity_k ?? 0.02;
```

**3b. Replace step 3f (the stub normalization call) with real normalization:**

The current step 3f (around lines 158–160) is:

```typescript
// 3f. Temperature normalization — stub; store temp_adjusted = false and
//     ef_temp_adjusted = null (do not persist the stub's return value).
void normalizeTempEF(efResult.efValue, actRow.avg_temperature ?? 15);
```

And the current upsert (around lines 176–177) contains:

```typescript
temp_adjusted: false,
ef_temp_adjusted: null,
```

**Replace step 3f with:**

```typescript
// 3f. Fetch weather data for this activity (if available)
const { data: weatherRow } = await supabase
  .from('activity_weather')
  .select('temperature_celsius, humidity_pct, elevation_m')
  .eq('activity_id', String(actRow.activity_id))
  .maybeSingle();

// 3g. Apply environmental normalization
// Open-Meteo temperature takes precedence; device temp is fallback only.
const tempForNorm = weatherRow?.temperature_celsius ?? actRow.avg_temperature ?? null;
let tempAdjusted = false;
let efTempAdjusted: number | null = null;

if (tempForNorm !== null && efResult.efValue > 0) {
  const normResult = normalizeTempEF(
    efResult.efValue,
    tempForNorm,
    weatherRow?.humidity_pct ?? null,
    weatherRow?.elevation_m ?? null,
    heatK,
  );
  // Store efAltAdj: the fully-normalized EF (temperature + humidity + altitude combined).
  // ef_temp_adjusted is the column name inherited from the Section 7 stub, but semantically
  // it holds the complete environmental normalization. Always use efAltAdj here, not efTempAdj.
  efTempAdjusted = normResult.efAltAdj;
  tempAdjusted = true;
}
```

**Update the upsert payload** (replace the hardcoded `false` and `null`):

```typescript
temp_adjusted: tempAdjusted,
ef_temp_adjusted: efTempAdjusted,
```

**Temperature source precedence:** Open-Meteo weather data (`activity_weather.temperature_celsius`) takes precedence over device temperature (`garmin_activities.avg_temperature`). Device temperature is used as a fallback only when `activity_weather` has no row for this activity. When both are null, `tempForNorm` is null, `tempAdjusted` remains `false`, and `efTempAdjusted` remains `null`.

---

### Change 4: Replace `backfillEFWithTempAdjustment()` Stub in `lib/efRecalc.ts`

The current stub (around lines 338–348) is:

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

**Replace the stub body with the full implementation:**

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

    // Query activity_ef rows that need backfilling:
    // temp_adjusted = false AND temp_c IS NOT NULL
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
    const activityIds = rows.map((r: any) => r.activity_id);
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
    const updateRows: Array<{
      activity_id: string;
      ef_temp_adjusted: number;
      temp_adjusted: boolean;
    }> = [];

    for (const efRow of rows) {
      // Skip rows with null or zero ef_value (defensive guard)
      if (!efRow.ef_value || efRow.ef_value <= 0) continue;

      const weather = weatherMap.get(efRow.activity_id);
      const tempForNorm = weather?.temperature_celsius ?? efRow.temp_c;

      // tempForNorm cannot be null here (temp_c IS NOT NULL in query)
      if (tempForNorm === null) continue;

      const normResult = normalizeTempEF(
        efRow.ef_value,
        tempForNorm,
        weather?.humidity_pct ?? null,
        weather?.elevation_m ?? null,
        heatK,
      );

      // Use efAltAdj: the fully-normalized EF (temperature + humidity + altitude).
      // Consistent with recalculateEF step 3g — both paths must assign efAltAdj to ef_temp_adjusted.
      updateRows.push({
        activity_id: efRow.activity_id,
        ef_temp_adjusted: normResult.efAltAdj,
        temp_adjusted: true,
      });
    }

    // Upsert in batches of 500
    let count = 0;
    for (let i = 0; i < updateRows.length; i += BATCH_SIZE) {
      const chunk = updateRows.slice(i, i + BATCH_SIZE);
      const { error: upsertErr } = await supabase
        .from('activity_ef')
        .upsert(
          chunk.map((r) => ({
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

**Critical consistency note:** Both `recalculateEF()` step 3g and `backfillEFWithTempAdjustment()` must assign `normResult.efAltAdj` (not `normResult.efTempAdj`) to `ef_temp_adjusted`. These are the fully-normalized values including altitude correction. If you store `efTempAdj` in either path, the same activity will have divergent `ef_temp_adjusted` values depending on which code path ran last — which would produce silent data corruption.

---

### Change 5: Add `triggerWeatherRecalc()` to `lib/gapRecalc.ts`

Read `lib/gapRecalc.ts` in full before editing. The current post-GAP call chain in `computeGAPBatch()` ends with:

```typescript
const backfillResult = await triggerDecouplingBackfill();
const backfill_triggered = backfillResult.ok ? (backfillResult.count ?? 0) : 0;

await triggerEFRecalc(/* fromDate is not passed here; recalculate all */);
```

**Add the new `triggerWeatherRecalc()` function** following the exact thin-wrapper pattern of `triggerDecouplingBackfill()` and `triggerEFRecalc()`:

```typescript
import { recalculateWeather } from './weatherRecalc';

/**
 * Delegates to recalculateWeather() from weatherRecalc.ts.
 * Does not duplicate any logic — thin wrapper for error isolation only.
 */
export async function triggerWeatherRecalc(fromDate?: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const result = await recalculateWeather(fromDate);
    return { ok: result.ok, error: result.error };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
```

**Update `computeGAPBatch()`** to call `triggerWeatherRecalc()` after `triggerEFRecalc()`:

```typescript
await triggerEFRecalc(/* fromDate is not passed here; recalculate all */);

await triggerWeatherRecalc(/* fromDate is not passed here; recalculate all */);
```

The final call order in `computeGAPBatch()` is:
1. Loop over activities calling `computeGAPForActivity()` (existing)
2. `triggerDecouplingBackfill()` (existing)
3. `triggerEFRecalc()` (existing — wired in EF-005)
4. `triggerWeatherRecalc()` (new)

Do not pass `fromDate` into `triggerWeatherRecalc()` from `computeGAPBatch()` — always recalculate all weather data after a GAP batch to ensure consistency.

Check the import graph before committing. If importing `recalculateWeather` from `./weatherRecalc` would create a circular dependency, use a dynamic import inside `triggerWeatherRecalc()` instead.

---

### Commit Strategy

All five changes (Change 1 through Change 5) must be committed together in a single commit. The reason: Change 1 removes `normalizeTempEF` from `lib/ef.ts`, and Change 2 removes `normalizeTempEF` from the `./ef` import in `lib/efRecalc.ts`. If committed separately:
- After Change 1 alone: `lib/efRecalc.ts` imports a non-existent export → TypeScript error
- After Change 2 alone: `lib/efRecalc.ts` uses `normalizeTempEF` with no import source → TypeScript error

Commit all files together: `lib/ef.ts`, `lib/efRecalc.ts`, `lib/gapRecalc.ts`.

### Acceptance Criteria

1. `lib/ef.ts` no longer exports `normalizeTempEF` — verified by `tsc --noEmit` (TypeScript compile with no errors).
2. `lib/efRecalc.ts` imports `normalizeTempEF` from `./envAdjust` only — the `./ef` import line does not include `normalizeTempEF`.
3. `tsc --noEmit` passes with no errors after all changes are committed.
4. `ef_temp_adjusted` in `activity_ef` always stores `normResult.efAltAdj` (not `normResult.efTempAdj`) from BOTH code paths in `recalculateEF()` step 3g and `backfillEFWithTempAdjustment()`.
5. Activities with an `activity_weather` row containing a non-null `temperature_celsius`: `temp_adjusted = true`, non-null `ef_temp_adjusted` in `activity_ef`.
6. Activities with no `activity_weather` row but with a device temperature (`avg_temperature` in `garmin_activities`): `temp_adjusted = true`, non-null `ef_temp_adjusted` (device temp used as fallback).
7. Activities with no `activity_weather` row and no device temperature: `temp_adjusted = false`, `ef_temp_adjusted = null`.
8. `backfillEFWithTempAdjustment()` processes all `activity_ef` rows where `temp_adjusted = false AND temp_c IS NOT NULL`. Rows with `ef_value <= 0` are skipped.
9. Upsert in `backfillEFWithTempAdjustment()` is batched at 500 rows.
10. `triggerWeatherRecalc(fromDate?)` is exported from `lib/gapRecalc.ts`.
11. `computeGAPBatch()` calls `triggerWeatherRecalc()` after `triggerEFRecalc()`.
12. `triggerWeatherRecalc()` is a thin wrapper — no logic beyond error isolation (same pattern as `triggerDecouplingBackfill()` and `triggerEFRecalc()`).
13. `npm test` passes with no regressions to existing GAP, PMC, decoupling, or EF tests.

### Dependencies

- ENV-001 (`lib/envAdjust.ts`) — `normalizeTempEF` is imported by `lib/efRecalc.ts`.
- ENV-002 (`lib/weatherRecalc.ts`) — `recalculateWeather` is imported by `lib/gapRecalc.ts`; `activity_weather` SQL migration must be run before integration testing.

### Gotchas and Edge Cases

- Read both `lib/ef.ts` and `lib/efRecalc.ts` in full before making any edits. The exact line numbers of the stub and the import block may differ from the TDD description — use the actual file content.
- The `EFResult` type referenced in some TDD notes: check whether it is currently imported in `lib/efRecalc.ts`. If it is not in the current file, do not add it. Only remove `normalizeTempEF` from the `./ef` import — leave all other imports unchanged.
- The `EnvNormalizationResult` type is imported from `./envAdjust` alongside `normalizeTempEF`. Include it in the new import line — it may be needed for TypeScript type annotations.
- In `backfillEFWithTempAdjustment()`, the upsert uses `onConflict: 'athlete_id,activity_id'`. This updates only `ef_temp_adjusted` and `temp_adjusted` — all other columns (`ef_value`, `qualifying`, `gap_used`, etc.) remain unchanged. This is correct for a targeted backfill.
- The `weatherMap` lookup in `backfillEFWithTempAdjustment()` uses `activity_id` as key (a string). Ensure the map key and `efRow.activity_id` are the same type (both should be strings from the Supabase query).

---

## Ticket 4

**ENV-004 (Optional): Personal coefficient fitting — expand edge-case tests for `fitHeatSensitivityK` and wire in a manual trigger for `fitAndStoreHeatSensitivityK`.**

### Summary

This is an optional ticket. The default `k = 0.02` is a valid approximation for all athletes until sufficient outdoor run data accumulates. `fitAndStoreHeatSensitivityK()` is already implemented in `lib/weatherRecalc.ts` (ENV-002) but is not wired into any automatic pipeline. Ticket 4 adds expanded unit tests for `fitHeatSensitivityK` edge cases and adds a manual trigger so the quarterly refit can be invoked explicitly.

The personal coefficient fitting requires 30+ qualifying runs spanning > 15°C of temperature variation, which may take months to accumulate. Shipping ENV-001 through ENV-003 delivers the full normalization pipeline with the default coefficient. ENV-004 adds personalization once sufficient data exists.

### Branch

`feature/env-004`

### Files to Modify

- `__tests__/envAdjust.test.ts` — expand test coverage for `fitHeatSensitivityK` edge cases

### Files to Optionally Create or Modify

- A script or UI hook to trigger `fitAndStoreHeatSensitivityK()` manually (implementation at the engineer's discretion — a simple Node script in `scripts/fitHeatK.ts` is sufficient)

### Depends On

ENV-001 (`lib/envAdjust.ts`) and ENV-002 (`lib/weatherRecalc.ts`).

---

### Part A: Expanded Tests for `fitHeatSensitivityK`

Add the following test cases to the existing `__tests__/envAdjust.test.ts` describe block for `fitHeatSensitivityK`. These augment (do not replace) the tests written in ENV-001.

**Minimum data threshold edge cases:**
- Exactly 30 runs with exactly 15°C range: the function must return a number (not null) — this is the minimum passing case on both thresholds simultaneously
- 30 runs with 14.99°C range: returns `null` (range just below threshold)
- 29 runs with 20°C range: returns `null` (count just below threshold)
- 30 runs with 15°C range and all EF values identical: returns `0.0` (no slope → k = -slope = 0; clamped to `Math.max(0, 0)`)

**OLS correctness:**
- Construct a synthetic dataset of 50 runs with `tempC` values uniformly distributed from 0°C to 40°C and `efValue` defined as `0.050 - 0.02 * (tempC - 15) / 10 + noise` (where noise is ±0.001 drawn deterministically from a fixed pattern). Assert that `fitHeatSensitivityK` returns a value within ±0.003 of 0.02.
- Construct a dataset where EF is perfectly flat regardless of temperature: returns `0.0` (no heat sensitivity detected; k clamped to `Math.max(0, 0)`)
- Construct a dataset where EF increases with temperature (anomalous positive slope): returns `0.0` (k = -slope is negative → clamped to `Math.max(0, k) = 0`)

**Boundary on k clamping:**
- Construct a dataset where the OLS slope would yield a very small negative k (e.g., -0.0001 due to floating-point noise in a flat dataset): the returned value is `0.0` (not a tiny negative)

### Part B: Manual Trigger for `fitAndStoreHeatSensitivityK`

Create a simple invocation mechanism so the quarterly refit can be triggered manually without running the full GAP pipeline. A Node.js script is the preferred approach:

**`scripts/fitHeatK.ts`** (example — implement as appropriate for the codebase):

```typescript
/**
 * Manual trigger for quarterly heat sensitivity coefficient fitting.
 *
 * Run with: npx ts-node scripts/fitHeatK.ts
 *
 * This script calls fitAndStoreHeatSensitivityK() and prints the result.
 * It requires at least 30 qualifying outdoor runs spanning > 15°C to produce
 * a fitted coefficient. Until then, the default k = 0.02 is used automatically.
 */
import { fitAndStoreHeatSensitivityK } from '../lib/weatherRecalc';

async function main() {
  console.log('[fitHeatK] Starting personal coefficient fitting...');
  const result = await fitAndStoreHeatSensitivityK();

  if (!result.ok) {
    console.error('[fitHeatK] Fitting failed:', result.error);
    process.exit(1);
  }

  if (result.k === undefined) {
    console.log('[fitHeatK] Insufficient data (< 30 qualifying runs or < 15°C range). Default k = 0.02 remains in effect.');
  } else {
    console.log(`[fitHeatK] Fitted k = ${result.k.toFixed(4)}. Stored in athlete_parameters.`);
    console.log('[fitHeatK] Next recalculateEF() and backfillEFWithTempAdjustment() runs will use the new coefficient.');
  }
}

main().catch((err) => {
  console.error('[fitHeatK] Unexpected error:', err);
  process.exit(1);
});
```

Confirm that after `fitAndStoreHeatSensitivityK()` upserts a new k value, subsequent calls to `recalculateEF()` and `backfillEFWithTempAdjustment()` (both of which read `athlete_parameters.heat_sensitivity_k` at their start) will automatically pick up the new coefficient.

### Acceptance Criteria

1. All new `fitHeatSensitivityK` edge-case tests in `__tests__/envAdjust.test.ts` pass.
2. Exactly 30 runs with exactly 15°C temperature range returns a number (not null).
3. Runs where EF is flat (no temperature correlation) return `0.0` (not negative).
4. Anomalous dataset (EF improves with heat) returns `0.0` (k clamped from negative).
5. OLS synthetic dataset with known k ≈ 0.02 returns a value within ±0.003 of 0.02.
6. `fitAndStoreHeatSensitivityK()` returns `{ ok: true, k: undefined }` when < 30 qualifying outdoor runs exist (verifiable against development Supabase if fewer than 30 rows exist with qualifying=true and temp_c IS NOT NULL).
7. After `fitAndStoreHeatSensitivityK()` stores a k value, the next call to `recalculateEF()` reads the stored k from `athlete_parameters` and uses it instead of the default 0.02.
8. `npm test` passes with all new tests green and no regressions to ENV-001 through ENV-003 tests.

### Dependencies

- ENV-001 (`lib/envAdjust.ts`) — `fitHeatSensitivityK` is the function under expanded test.
- ENV-002 (`lib/weatherRecalc.ts`) — `fitAndStoreHeatSensitivityK` is the I/O function being wired.
- ENV-003 (recommended, not strictly required) — confirms the pipeline reads `heat_sensitivity_k` correctly before testing the end-to-end coefficient update.

### Gotchas and Edge Cases

- The OLS synthetic dataset test must be fully deterministic (no `Math.random()`). Use a fixed sequence for any noise values so the test produces the same result on every run.
- `fitHeatSensitivityK` clamps k to `Math.max(0, k)`. A flat dataset produces `slope = 0`, so `k = -0 = 0`. A dataset with anomalous positive EF-vs-temperature slope produces a negative slope, so `k = -(negative) = positive` before clamping — wait, re-read the formula: `k = -slope`. If EF increases with temperature, slope is positive, so `k = -(positive) = negative`, then `Math.max(0, k) = 0`. Verify this logic against the implementation before writing the test.
- The `scripts/fitHeatK.ts` script requires `ts-node` to run. Confirm it is available in the project's dev dependencies before writing the invocation instructions.
