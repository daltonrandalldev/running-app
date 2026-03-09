/**
 * Pure TypeScript module — zero I/O, zero external dependencies.
 * No imports from Supabase, AsyncStorage, or React Native.
 *
 * Environmental adjustment library: temperature, humidity, and altitude
 * corrections for Efficiency Factor (EF) normalization.
 *
 * References:
 *   - Steadman (1979) apparent temperature / heat index formulation
 *   - August-Roche-Magnus approximation for vapor pressure
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnvNormalizationResult {
  efTempAdj: number;        // EF after temperature + humidity correction
  efAltAdj: number;         // EF after all corrections (temperature + humidity + altitude)
  performanceFactor: number; // Factor applied for temp/humidity (< 1.0 means heat penalty)
  altitudeFactor: number;   // Factor applied for altitude (> 1.0 means altitude penalty)
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Compute the vapor pressure (hPa) using the August-Roche-Magnus approximation
 * as used in Steadman (1979).
 *
 * @param tempC       - Dry-bulb temperature in degrees Celsius
 * @param humidityPct - Relative humidity as a percentage (0–100)
 * @returns Vapor pressure in hPa
 */
export function computeHumidityPartialPressure(
  tempC: number,
  humidityPct: number,
): number {
  return (humidityPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
}

/**
 * Compute effective temperature using the Steadman (1979) apparent temperature
 * formulation. Only applied when humidity > 60 AND temp > 20 (strictly
 * greater-than on both conditions).
 *
 * @param tempC       - Dry-bulb temperature in degrees Celsius
 * @param humidityPct - Relative humidity as a percentage (0–100)
 * @returns Effective (apparent) temperature in degrees Celsius
 */
export function computeEffectiveTemperature(
  tempC: number,
  humidityPct: number,
): number {
  if (humidityPct <= 60 || tempC <= 20) return tempC;
  return tempC + 0.33 * computeHumidityPartialPressure(tempC, humidityPct) - 4.0;
}

/**
 * Compute the performance factor representing physiological output suppression
 * relative to the 15°C baseline.
 *
 * A factor < 1.0 indicates heat-induced performance penalty.
 * The result is clamped to a minimum of 0.5.
 *
 * @param tempC       - Dry-bulb temperature in degrees Celsius
 * @param humidityPct - Relative humidity as a percentage (0–100), or null to skip humidity correction
 * @param k           - Heat sensitivity coefficient (default 0.02)
 * @returns Performance factor in range [0.5, 1.0]
 */
export function computePerformanceFactor(
  tempC: number,
  humidityPct: number | null,
  k: number = 0.02,
): number {
  const tEff =
    humidityPct !== null
      ? computeEffectiveTemperature(tempC, humidityPct)
      : tempC;

  if (tEff <= 15) return 1.0;
  return Math.max(0.5, 1 - (k * (tEff - 15)) / 10);
}

/**
 * Compute the altitude correction factor. At or below 1500 m the factor is
 * 1.0 (no correction). The boundary is inclusive — exactly 1500 m does not
 * trigger the correction.
 *
 * @param elevationM - Elevation in metres above sea level
 * @returns Altitude factor (values < 1.0 indicate altitude penalty on EF denominator)
 */
export function computeAltitudeFactor(elevationM: number): number {
  if (elevationM <= 1500) return 1.0;
  return 1 - 0.065 * ((elevationM - 1500) / 1000);
}

/**
 * Apply all environmental corrections to a raw EF value in sequence:
 * temperature + humidity correction first, then altitude correction.
 *
 * When performanceFactor = 1.0 and altitudeFactor = 1.0 (cool, low-elevation
 * activity), all four returned values are numerically equal to the input ef.
 *
 * @param ef          - Raw Efficiency Factor value
 * @param tempC       - Dry-bulb temperature in degrees Celsius
 * @param humidityPct - Relative humidity as a percentage (0–100), or null
 * @param elevationM  - Elevation in metres, or null (treated as sea level)
 * @param k           - Heat sensitivity coefficient (default 0.02)
 * @returns EnvNormalizationResult with all corrected values and factors
 */
export function normalizeTempEF(
  ef: number,
  tempC: number,
  humidityPct: number | null,
  elevationM: number | null,
  k: number = 0.02,
): EnvNormalizationResult {
  const performanceFactor = computePerformanceFactor(tempC, humidityPct, k);
  const altitudeFactor = computeAltitudeFactor(elevationM ?? 0);
  const efTempAdj = ef / performanceFactor;
  const efAltAdj = efTempAdj * (1 / altitudeFactor);
  return { efTempAdj, efAltAdj, performanceFactor, altitudeFactor };
}

/**
 * Fit a personal heat sensitivity coefficient k via OLS regression of
 * EF against (tempC - 15).
 *
 * Returns null when:
 *   - Fewer than 30 qualifying outdoor runs are provided
 *   - The temperature range across provided runs is < 15°C
 *
 * The regression uses all runs including cool-weather ones (negative x_i).
 * The sign is negated (k = -slope) because heat reduces EF — the slope of
 * EF vs temperature is expected to be negative, but k is defined as positive.
 *
 * @param runs - Array of { efValue, tempC } run records
 * @returns Fitted k value (≥ 0), or null if insufficient data
 */
export function fitHeatSensitivityK(
  runs: Array<{ efValue: number; tempC: number }>,
): number | null {
  if (runs.length < 30) return null;

  const temps = runs.map((r) => r.tempC);
  const tempRange = Math.max(...temps) - Math.min(...temps);
  if (tempRange < 15) return null;

  const efMean = runs.reduce((sum, r) => sum + r.efValue, 0) / runs.length;

  let numerator = 0;
  let denominator = 0;
  for (const run of runs) {
    const xi = run.tempC - 15;
    numerator += xi * (run.efValue - efMean);
    denominator += xi * xi;
  }

  // Guard against degenerate denominator (all temps equal — already caught
  // above by tempRange check, but defensive)
  if (denominator === 0) return null;

  const slope = numerator / denominator;
  const k = -slope; // negate: heat reduces EF so slope is negative, k is positive
  return Math.max(0, k);
}
