/**
 * Open-Meteo API client — no Supabase, no I/O side effects beyond HTTP fetch.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── In-memory cache ───────────────────────────────────────────────────────────

// Cache stores raw API JSON (not parsed results) so that the same response can
// be re-parsed with different startTimeISO values (e.g. two activities on the
// same day at different start hours). A failure sentinel avoids re-fetching
// known-bad keys within the same pipeline run.
type CacheEntry = { ok: true; json: unknown } | { ok: false };

// Module-level cache (lives for the duration of a single pipeline run)
const weatherCache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lng: number, date: string): string {
  return `${lat},${lng},${date}`;
}

/**
 * Clear the in-memory weather cache.
 * Exported for test use — allows tests to reset cache state between cases.
 */
export function clearWeatherCache(): void {
  weatherCache.clear();
}

// ── URL construction ──────────────────────────────────────────────────────────

/**
 * Build the Open-Meteo archive API URL for a given coordinate and date.
 *
 * Uses timezone=UTC (NOT timezone=auto) so that Open-Meteo returns UTC
 * timestamps in hourly.time. The hour-index extraction logic uses
 * new Date(startTimeISO).toISOString().slice(0, 13) which produces a UTC
 * prefix — this matches correctly only when the API returns UTC timestamps.
 *
 * Exported for unit testing.
 *
 * @param lat   Activity start latitude
 * @param lng   Activity start longitude
 * @param date  ISO YYYY-MM-DD (UTC date of the activity)
 * @returns     Full Open-Meteo archive API URL
 */
export function buildOpenMeteoUrl(
  lat: number,
  lng: number,
  date: string,  // ISO YYYY-MM-DD
): string {
  return (
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}` +
    `&longitude=${lng}` +
    `&start_date=${date}` +
    `&end_date=${date}` +
    `&hourly=temperature_2m,relativehumidity_2m,windspeed_10m,winddirection_10m` +
    `&timezone=UTC`
  );
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Parse an Open-Meteo archive API response into a structured record.
 * Returns null if the response is malformed or missing required fields,
 * or if the activity's start hour is not found in the returned hourly data.
 *
 * Hour index extraction uses UTC: new Date(startTimeISO).toISOString().slice(0, 13)
 * produces "YYYY-MM-DDTHH" in UTC, which matches the UTC timestamps returned
 * by Open-Meteo when timezone=UTC is used.
 *
 * Exported for unit testing.
 *
 * @param responseJson      Raw JSON response from Open-Meteo (unknown type)
 * @param startTimeISO      Activity start time as ISO 8601 string
 * @param durationSeconds   Activity duration in seconds
 * @returns                 WeatherResult or null on any parsing failure
 */
export function parseOpenMeteoResponse(
  responseJson: unknown,
  startTimeISO: string,
  durationSeconds: number,
): WeatherResult | null {
  // Guard: must be an object with an hourly property
  if (typeof responseJson !== 'object' || responseJson === null) return null;

  const json = responseJson as Record<string, unknown>;
  const hourly = json['hourly'];

  if (typeof hourly !== 'object' || hourly === null) return null;

  const h = hourly as Record<string, unknown>;

  const timeArr = h['time'];
  const temp2m = h['temperature_2m'];
  const humidity = h['relativehumidity_2m'];
  const windspeed = h['windspeed_10m'];
  const winddirection = h['winddirection_10m'];

  if (!Array.isArray(timeArr) || !Array.isArray(temp2m)) return null;

  // Extract UTC hour prefix from startTimeISO: "YYYY-MM-DDTHH"
  const startHourPrefix = new Date(startTimeISO).toISOString().slice(0, 13);
  const startHourIndex = (timeArr as string[]).findIndex((t: string) =>
    t.startsWith(startHourPrefix),
  );

  if (startHourIndex === -1) return null;

  const durationHours = Math.ceil(durationSeconds / 3600);
  const hourlyTemps = (temp2m as number[]).slice(
    startHourIndex,
    startHourIndex + durationHours,
  );

  // Activity temperature = start-of-activity hour
  const temperatureCelsius = (temp2m as number[])[startHourIndex] ?? null;

  // Mid-run delta: max - min over the activity's hourly range
  const midRunTempDelta =
    hourlyTemps.length >= 2
      ? Math.max(...hourlyTemps) - Math.min(...hourlyTemps)
      : null;

  const usedSegmentAdjustment = midRunTempDelta !== null && midRunTempDelta > 3;

  return {
    temperatureCelsius,
    humidityPct: Array.isArray(humidity)
      ? ((humidity as number[])[startHourIndex] ?? null)
      : null,
    windSpeedKmh: Array.isArray(windspeed)
      ? ((windspeed as number[])[startHourIndex] ?? null)
      : null,
    windDirectionDeg: Array.isArray(winddirection)
      ? ((winddirection as number[])[startHourIndex] ?? null)
      : null,
    elevationM: (json as any).elevation ?? null,
    midRunTempDelta,
    usedSegmentAdjustment,
    hourlyTemps,
  };
}

// ── Main fetch function ───────────────────────────────────────────────────────

/**
 * Fetch weather conditions for a single activity from the Open-Meteo archive API.
 *
 * Returns null on any error (API unavailable, network failure, parse error,
 * or missing hourly data for the activity's time slot). Never throws.
 *
 * Uses in-memory cache keyed by (lat, lng, date) to avoid redundant API calls
 * across a single pipeline run (e.g., multiple activities at the same location
 * on the same day — common for track workouts).
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
): Promise<WeatherResult | null> {
  try {
    // Derive UTC date from startTimeISO
    const date = new Date(startTimeISO).toISOString().slice(0, 10);
    const key = cacheKey(lat, lng, date);

    // Check cache (including failure sentinel to avoid re-fetching known failures)
    if (weatherCache.has(key)) {
      const entry = weatherCache.get(key)!;
      if (!entry.ok) return null;
      // Re-parse with THIS call's startTimeISO so that two activities on the
      // same day at different hours each get the correct temperature slice.
      return parseOpenMeteoResponse(entry.json, startTimeISO, durationSeconds);
    }

    // Build URL and fetch
    const url = buildOpenMeteoUrl(lat, lng, date);
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      weatherCache.set(key, { ok: false });
      return null;
    }

    if (!response.ok) {
      weatherCache.set(key, { ok: false });
      return null;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      weatherCache.set(key, { ok: false });
      return null;
    }

    weatherCache.set(key, { ok: true, json });
    return parseOpenMeteoResponse(json, startTimeISO, durationSeconds);
  } catch {
    return null;
  }
}
