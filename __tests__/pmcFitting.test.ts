/**
 * PMC-004 Fitting Engine Tests
 *
 * Synthetic recovery test: generate activities with known tc_fitness=45, tc_fatigue=5,
 * produce noiseless benchmark scores under that model, then assert the optimizer
 * recovers within ±3 days of the true values.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings=MODULE_TYPELESS_PACKAGE_JSON __tests__/pmcFitting.test.ts
 */

import { calculatePMC } from '../lib/pmc.ts';
import { fitDecayConstants, bootstrapCI } from '../lib/pmcFitting.ts';
import { computeFittingEligibility } from '../lib/benchmarkUtils.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

// ── Synthetic dataset generation ──────────────────────────────────────────────

/**
 * Generate 2 years of synthetic activities (weekly pattern):
 *   Mon 80 TSS, Wed 60, Thu 90, Sun 120 (rest other days)
 * Starting from BASE_DATE.
 */
function generateActivities(start: string, days: number) {
  const pattern = [80, 0, 60, 90, 0, 0, 120]; // Mon-Sun
  const acts: Array<{ date: string; tss: number }> = [];
  for (let i = 0; i < days; i++) {
    const tss = pattern[i % 7];
    if (tss > 0) acts.push({ date: addDays(start, i), tss });
  }
  return acts;
}

/**
 * Generate deterministic benchmark observations under the true model.
 * Performance score = k1 * CTL - k2 * ATL + intercept (no noise → exact recovery expected).
 * True coefficients: k1=1.5, k2=1.0, intercept=40.
 */
function generateBenchmarks(
  activities: Array<{ date: string; tss: number }>,
  tc_fitness: number,
  tc_fatigue: number,
  benchmarkDates: string[],
) {
  const pmcDays = calculatePMC(activities, { tc_fitness, tc_fatigue });
  const pmcMap = new Map(pmcDays.map((d) => [d.date, d]));

  return benchmarkDates
    .map((date) => {
      const pmc = pmcMap.get(date);
      if (!pmc) return null;
      const score = 1.5 * pmc.ctl - 1.0 * pmc.atl + 40;
      return { date, performance_score: Math.max(0, score) };
    })
    .filter((b) => b !== null) as Array<{ date: string; performance_score: number }>;
}

// ── Test 1: Synthetic recovery — tc=45/5 ─────────────────────────────────────

console.log('PMC-004 Fitting Engine Tests');
console.log();
console.log('Test 1: Synthetic parameter recovery (tc_fitness=45, tc_fatigue=5)');

const BASE_DATE = '2022-01-01';
const TRUE_TC_FITNESS = 45;
const TRUE_TC_FATIGUE = 5;
const DAYS = 730; // 2 years

const activities = generateActivities(BASE_DATE, DAYS);

// 12 benchmark dates spread across 15 months (well above 6-benchmark, 6-month gate)
const benchmarkDates = [
  addDays(BASE_DATE, 60),
  addDays(BASE_DATE, 120),
  addDays(BASE_DATE, 180),
  addDays(BASE_DATE, 240),
  addDays(BASE_DATE, 300),
  addDays(BASE_DATE, 365),
  addDays(BASE_DATE, 420),
  addDays(BASE_DATE, 460),
  addDays(BASE_DATE, 510),
  addDays(BASE_DATE, 550),
  addDays(BASE_DATE, 600),
  addDays(BASE_DATE, 450),
];

const benchmarks = generateBenchmarks(
  activities,
  TRUE_TC_FITNESS,
  TRUE_TC_FATIGUE,
  benchmarkDates,
);

console.log(`  Activities: ${activities.length} days with TSS > 0`);
console.log(`  Benchmarks: ${benchmarks.length} observations`);

const t0 = Date.now();
const result = fitDecayConstants(activities, benchmarks);
const elapsed = Date.now() - t0;

console.log(`  Elapsed: ${elapsed}ms (including 1000-iteration bootstrap CI)`);
console.log();

assert(result.eligible !== false, 'fitDecayConstants: returns eligible result');

if (result.eligible !== false) {
  console.log(`  Fitted tc_fitness: ${result.tc_fitness.toFixed(2)} (true: ${TRUE_TC_FITNESS})`);
  console.log(`  Fitted tc_fatigue: ${result.tc_fatigue.toFixed(2)} (true: ${TRUE_TC_FATIGUE})`);
  console.log(`  R²: ${result.r2.toFixed(4)}`);
  console.log(`  95% CI tc_fitness: [${result.ci.tc_fitness_low.toFixed(1)}, ${result.ci.tc_fitness_high.toFixed(1)}]`);
  console.log(`  95% CI tc_fatigue: [${result.ci.tc_fatigue_low.toFixed(1)}, ${result.ci.tc_fatigue_high.toFixed(1)}]`);
  console.log();

  assert(
    near(result.tc_fitness, TRUE_TC_FITNESS, 3),
    `tc_fitness within ±3 days of true value (got ${result.tc_fitness.toFixed(2)}, true ${TRUE_TC_FITNESS})`,
  );

  assert(
    near(result.tc_fatigue, TRUE_TC_FATIGUE, 3),
    `tc_fatigue within ±3 days of true value (got ${result.tc_fatigue.toFixed(2)}, true ${TRUE_TC_FATIGUE})`,
  );

  assert(
    result.r2 > 0.8,
    `R² > 0.8 for noiseless data (got ${result.r2.toFixed(4)})`,
  );

  assert(
    result.n_benchmarks === benchmarks.length,
    `n_benchmarks matches input (got ${result.n_benchmarks}, expected ${benchmarks.length})`,
  );

  assert(!result.was_clamped, 'no clamping needed for physiological true values');

  assert(
    result.ci.tc_fitness_low < TRUE_TC_FITNESS &&
      result.ci.tc_fitness_high > TRUE_TC_FITNESS,
    `tc_fitness CI contains true value [${result.ci.tc_fitness_low.toFixed(1)}, ${result.ci.tc_fitness_high.toFixed(1)}] ∋ ${TRUE_TC_FITNESS}`,
  );

  assert(
    result.ci.tc_fatigue_low < TRUE_TC_FATIGUE &&
      result.ci.tc_fatigue_high > TRUE_TC_FATIGUE,
    `tc_fatigue CI contains true value [${result.ci.tc_fatigue_low.toFixed(1)}, ${result.ci.tc_fatigue_high.toFixed(1)}] ∋ ${TRUE_TC_FATIGUE}`,
  );
}

// ── Test 2: Eligible:false — data gate ───────────────────────────────────────

console.log();
console.log('Test 2: Data gate — eligible:false cases');

// Fewer than 6 benchmarks
const fewBenchmarks = benchmarks.slice(0, 4);
const fewResult = fitDecayConstants(activities, fewBenchmarks);
assert(
  fewResult.eligible === false,
  'fewer than 6 benchmarks → eligible:false',
);
assert(
  fewResult.eligible === false && fewResult.count === 4,
  'eligible:false carries correct count',
);

// 6 benchmarks but span < 6 months (all within 3 months)
const shortSpanDates = [
  BASE_DATE,
  addDays(BASE_DATE, 14),
  addDays(BASE_DATE, 28),
  addDays(BASE_DATE, 42),
  addDays(BASE_DATE, 56),
  addDays(BASE_DATE, 70),
];
const shortBenchmarks = generateBenchmarks(
  activities,
  TRUE_TC_FITNESS,
  TRUE_TC_FATIGUE,
  shortSpanDates,
);
const shortResult = fitDecayConstants(activities, shortBenchmarks);
assert(
  shortResult.eligible === false,
  '6 benchmarks over 3 months → eligible:false (span < 6 months)',
);

// Empty input
const emptyResult = fitDecayConstants([], []);
assert(emptyResult.eligible === false, 'empty input → eligible:false');

// ── Test 3: Physiological bounds clamping ─────────────────────────────────────

console.log();
console.log('Test 3: Bounds respected — tc always in [20,60] × [3,14]');

// With normal data, fitted values should stay within bounds
if (result.eligible !== false) {
  assert(
    result.tc_fitness >= 20 && result.tc_fitness <= 60,
    `tc_fitness in [20, 60] (got ${result.tc_fitness.toFixed(2)})`,
  );
  assert(
    result.tc_fatigue >= 3 && result.tc_fatigue <= 14,
    `tc_fatigue in [3, 14] (got ${result.tc_fatigue.toFixed(2)})`,
  );
}

// ── Test 4: Bootstrap CI structure ───────────────────────────────────────────

console.log();
console.log('Test 4: Bootstrap CI internal consistency');

if (result.eligible !== false) {
  assert(
    result.ci.tc_fitness_low <= result.tc_fitness,
    'CI lower bound ≤ fitted value for tc_fitness',
  );
  assert(
    result.ci.tc_fitness_high >= result.tc_fitness,
    'CI upper bound ≥ fitted value for tc_fitness',
  );
  assert(
    result.ci.tc_fatigue_low <= result.tc_fatigue,
    'CI lower bound ≤ fitted value for tc_fatigue',
  );
  assert(
    result.ci.tc_fatigue_high >= result.tc_fatigue,
    'CI upper bound ≥ fitted value for tc_fatigue',
  );
}

// ── Test 5: Default initialisation doesn't harm recovery ──────────────────────

console.log();
console.log('Test 5: tc=42/7 defaults as starting point');

// The noiseless synthetic data should recover from defaults to true values
if (result.eligible !== false) {
  const drift_f = Math.abs(result.tc_fitness - 42);
  const drift_a = Math.abs(result.tc_fatigue - 7);
  console.log(
    `  Optimizer moved tc_fitness ${drift_f.toFixed(1)} days from default (42→${result.tc_fitness.toFixed(1)})`,
  );
  console.log(
    `  Optimizer moved tc_fatigue ${drift_a.toFixed(1)} days from default (7→${result.tc_fatigue.toFixed(1)})`,
  );
  assert(drift_f > 0.1 || drift_a > 0.1, 'optimizer moved from defaults (not stuck at initialisation)');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log();
if (process.exitCode === 1) {
  console.log('✗ PMC-004 tests FAILED');
} else {
  console.log('✓ All PMC-004 tests passed');
}
