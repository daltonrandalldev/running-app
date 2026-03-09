/**
 * ENV-001: Unit tests for lib/envAdjust.ts
 *
 * Pure tests — no Supabase, no AsyncStorage, no React Native imports.
 *
 * Run with:
 *   node --experimental-strip-types __tests__/envAdjust.test.ts
 */

import {
  computeHumidityPartialPressure,
  computeEffectiveTemperature,
  computePerformanceFactor,
  computeAltitudeFactor,
  normalizeTempEF,
  fitHeatSensitivityK,
} from '../lib/envAdjust.ts';

// ── Minimal test harness (mirrors the pattern used in other test files) ────────

let passed = 0;
let failed = 0;

function test(description: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${description}`);
    passed++;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${description}`);
    console.error(`    ${message}`);
    failed++;
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
      }
    },
    toBeCloseTo(expected: number, tolerance: number = 0.001) {
      const diff = Math.abs((actual as number) - expected);
      if (diff > tolerance) {
        throw new Error(
          `Expected ${actual} to be close to ${expected} (tolerance ±${tolerance}), diff = ${diff}`,
        );
      }
    },
    toBeGreaterThan(expected: number) {
      if ((actual as number) <= expected) {
        throw new Error(`Expected ${actual} > ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if ((actual as number) < expected) {
        throw new Error(`Expected ${actual} >= ${expected}`);
      }
    },
    not: {
      toBeNull() {
        if (actual === null) {
          throw new Error(`Expected a non-null value`);
        }
      },
    },
  };
}

// ── computeHumidityPartialPressure ────────────────────────────────────────────

console.log('\ncomputeHumidityPartialPressure');

test('(25, 80) ≈ 25.27 hPa (±0.1) — August-Roche-Magnus formula', () => {
  // Using the specified formula: (80/100) * 6.105 * exp(17.27*25 / (237.7+25))
  // = 0.8 * 6.105 * exp(1.6435) ≈ 25.27 hPa
  expect(computeHumidityPartialPressure(25, 80)).toBeCloseTo(25.27, 0.1);
});

test('(0, 100) returns a positive number', () => {
  const result = computeHumidityPartialPressure(0, 100);
  expect(result).toBeGreaterThan(0);
});

test('(25, 0) returns 0', () => {
  expect(computeHumidityPartialPressure(25, 0)).toBe(0);
});

// ── computeEffectiveTemperature ───────────────────────────────────────────────

console.log('\ncomputeEffectiveTemperature');

test('(22, 70) returns a value > 22°C', () => {
  expect(computeEffectiveTemperature(22, 70)).toBeGreaterThan(22);
});

test('(20, 80) returns 20.0 — boundary: temp exactly 20 → no correction', () => {
  expect(computeEffectiveTemperature(20, 80)).toBe(20.0);
});

test('(25, 60) returns 25.0 — boundary: humidity exactly 60 → no correction', () => {
  expect(computeEffectiveTemperature(25, 60)).toBe(25.0);
});

test('(25, 61) returns a value > 25°C', () => {
  expect(computeEffectiveTemperature(25, 61)).toBeGreaterThan(25);
});

test('(20.001, 61) returns a value > 20.001°C', () => {
  expect(computeEffectiveTemperature(20.001, 61)).toBeGreaterThan(20.001);
});

// ── computePerformanceFactor ──────────────────────────────────────────────────

console.log('\ncomputePerformanceFactor');

test('(15, null) returns 1.0', () => {
  expect(computePerformanceFactor(15, null)).toBe(1.0);
});

test('(14, null) returns 1.0', () => {
  expect(computePerformanceFactor(14, null)).toBe(1.0);
});

test('(25, null) returns 0.98', () => {
  // 1 - 0.02 * (25 - 15) / 10 = 1 - 0.02 = 0.98
  expect(computePerformanceFactor(25, null)).toBeCloseTo(0.98, 0.0001);
});

test('(25, null, 0.04) returns 0.96', () => {
  // 1 - 0.04 * (25 - 15) / 10 = 1 - 0.04 = 0.96
  expect(computePerformanceFactor(25, null, 0.04)).toBeCloseTo(0.96, 0.0001);
});

test('(50, null, 0.5) returns 0.5 — clamp (unclamped = -0.75)', () => {
  // unclamped: 1 - 0.5 * (50 - 15) / 10 = 1 - 1.75 = -0.75 → clamped to 0.5
  expect(computePerformanceFactor(50, null, 0.5)).toBe(0.5);
});

test('(40, null, 0.5) returns 0.5 — clamp (unclamped = -0.25)', () => {
  // unclamped: 1 - 0.5 * (40 - 15) / 10 = 1 - 1.25 = -0.25 → clamped to 0.5
  expect(computePerformanceFactor(40, null, 0.5)).toBe(0.5);
});

// ── computeAltitudeFactor ─────────────────────────────────────────────────────

console.log('\ncomputeAltitudeFactor');

test('(1500) returns 1.0 — boundary inclusive', () => {
  expect(computeAltitudeFactor(1500)).toBe(1.0);
});

test('(1499) returns 1.0', () => {
  expect(computeAltitudeFactor(1499)).toBe(1.0);
});

test('(0) returns 1.0', () => {
  expect(computeAltitudeFactor(0)).toBe(1.0);
});

test('(2500) returns 0.935', () => {
  // 1 - 0.065 * (2500 - 1500) / 1000 = 1 - 0.065 = 0.935
  expect(computeAltitudeFactor(2500)).toBeCloseTo(0.935, 0.0001);
});

test('(3000) returns 0.9025', () => {
  // 1 - 0.065 * (3000 - 1500) / 1000 = 1 - 0.0975 = 0.9025
  expect(computeAltitudeFactor(3000)).toBeCloseTo(0.9025, 0.0001);
});

// ── normalizeTempEF ───────────────────────────────────────────────────────────

console.log('\nnormalizeTempEF');

test('(0.05, 15, null, null) → all values = 0.05, factors = 1.0', () => {
  const result = normalizeTempEF(0.05, 15, null, null);
  expect(result.efTempAdj).toBeCloseTo(0.05, 1e-10);
  expect(result.efAltAdj).toBeCloseTo(0.05, 1e-10);
  expect(result.performanceFactor).toBe(1.0);
  expect(result.altitudeFactor).toBe(1.0);
});

test('(0.05, 25, null, null) → efTempAdj ≈ 0.051020; performanceFactor = 0.98; altitudeFactor = 1.0', () => {
  const result = normalizeTempEF(0.05, 25, null, null);
  // efTempAdj = 0.05 / 0.98 ≈ 0.051020
  expect(result.efTempAdj).toBeCloseTo(0.051020, 0.0001);
  expect(result.efAltAdj).toBeCloseTo(result.efTempAdj, 1e-10);
  expect(result.performanceFactor).toBeCloseTo(0.98, 0.0001);
  expect(result.altitudeFactor).toBe(1.0);
});

test('(0.05, 25, null, 1646) → efAltAdj > efTempAdj > 0.05', () => {
  // 1646m > 1500m → altitudeFactor < 1.0, so efAltAdj = efTempAdj / altitudeFactor > efTempAdj
  // tempC=25 > 15 → performanceFactor < 1.0, so efTempAdj > 0.05
  const result = normalizeTempEF(0.05, 25, null, 1646);
  expect(result.efAltAdj).toBeGreaterThan(result.efTempAdj);
  expect(result.efTempAdj).toBeGreaterThan(0.05);
});

test('(0.05, 10, null, 1000) → efTempAdj = 0.05, efAltAdj = 0.05', () => {
  // tempC=10 ≤ 15 → performanceFactor = 1.0 → efTempAdj = 0.05
  // elevationM=1000 ≤ 1500 → altitudeFactor = 1.0 → efAltAdj = 0.05
  const result = normalizeTempEF(0.05, 10, null, 1000);
  expect(result.efTempAdj).toBeCloseTo(0.05, 1e-10);
  expect(result.efAltAdj).toBeCloseTo(0.05, 1e-10);
  expect(result.performanceFactor).toBe(1.0);
  expect(result.altitudeFactor).toBe(1.0);
});

// ── fitHeatSensitivityK ───────────────────────────────────────────────────────

console.log('\nfitHeatSensitivityK');

test('([]) returns null', () => {
  expect(fitHeatSensitivityK([])).toBeNull();
});

test('29 runs spanning 20°C → null (n < 30)', () => {
  const runs = Array.from({ length: 29 }, (_, i) => ({
    efValue: 0.05,
    tempC: 10 + i * (20 / 28), // spans 20°C
  }));
  expect(fitHeatSensitivityK(runs)).toBeNull();
});

test('30 runs all at 20°C → null (tempRange = 0 < 15)', () => {
  const runs = Array.from({ length: 30 }, () => ({
    efValue: 0.05,
    tempC: 20,
  }));
  expect(fitHeatSensitivityK(runs)).toBeNull();
});

test('30 runs spanning only 10°C → null (tempRange < 15)', () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({
    efValue: 0.05,
    tempC: 15 + i * (10 / 29), // spans exactly 10°C
  }));
  expect(fitHeatSensitivityK(runs)).toBeNull();
});

test('30 runs with known k ≈ 0.03 → returns value within ±0.005 of 0.03', () => {
  // The OLS formula used is Σ x_i*(y_i - ȳ) / Σ x_i² where x_i = T_i - 15.
  // This formula exactly recovers the true slope only when mean(T) = 15
  // (so that x_mean = 0 and the formula equals standard OLS).
  // Test data: temps evenly spaced 5°C to 25°C (mean = 15, range = 20 ≥ 15).
  // EF is a strict linear function of (T - 15) with slope = -k = -0.03.
  const trueK = 0.03;
  const runs = Array.from({ length: 30 }, (_, i) => {
    const tempC = 5 + i * (20 / 29); // 5°C to 25°C — mean = 15, range = 20°C
    // ef = C - k*(T-15): slope of ef vs (T-15) is exactly -k
    const efValue = 0.5 - trueK * (tempC - 15);
    return { efValue, tempC };
  });

  const result = fitHeatSensitivityK(runs);
  if (result === null) {
    throw new Error('Expected a non-null result');
  }
  const diff = Math.abs(result - trueK);
  if (diff > 0.005) {
    throw new Error(
      `Expected fitted k ≈ ${trueK} (±0.005), got ${result} (diff = ${diff})`,
    );
  }
});

test('30 runs where EF increases with temperature → returns 0 (anomalous data clamped)', () => {
  // EF increases with temperature → positive slope → negative k before clamping → clamped to 0
  const runs = Array.from({ length: 30 }, (_, i) => ({
    efValue: 0.04 + i * 0.001, // EF increases with index
    tempC: 5 + i * 1,          // temp also increases with index → positive correlation
  }));
  const result = fitHeatSensitivityK(runs);
  if (result === null) {
    throw new Error('Expected 0, got null');
  }
  expect(result).toBe(0);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
