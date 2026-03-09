/**
 * MON-001 Unit Tests — Training Monotony & Strain Library
 *
 * Verifies calculateMonotony, calculateStrain, calculateMonotonyStrain,
 * and the SPORT_WEIGHTS constant exported from lib/monotony.ts.
 *
 * Run with:
 *   node --experimental-strip-types __tests__/monotony.test.ts
 */

import {
  SPORT_WEIGHTS,
  calculateMonotony,
  calculateStrain,
  calculateMonotonyStrain,
} from '../lib/monotony.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

function near(a: number, b: number, tol = 0.001): boolean {
  return Math.abs(a - b) <= tol;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── SPORT_WEIGHTS constant ────────────────────────────────────────────────────

console.log('MON-001: SPORT_WEIGHTS');

assert(SPORT_WEIGHTS.run === 1.0, 'SPORT_WEIGHTS.run === 1.0');
assert(SPORT_WEIGHTS.cycle === 0.5, 'SPORT_WEIGHTS.cycle === 0.5');

// Verify the shape has exactly the two keys expected
const weightKeys = Object.keys(SPORT_WEIGHTS);
assert(weightKeys.length === 2, 'SPORT_WEIGHTS has exactly 2 keys');
assert(weightKeys.includes('run'), 'SPORT_WEIGHTS has key "run"');
assert(weightKeys.includes('cycle'), 'SPORT_WEIGHTS has key "cycle"');

console.log('  SPORT_WEIGHTS: all passed');

// ── calculateMonotony ─────────────────────────────────────────────────────────

console.log('\nMON-001: calculateMonotony');

// AC-1: zero stdev → null (Example A)
const degenerate = [60, 60, 60, 60, 60, 60, 60];
assert(
  calculateMonotony(degenerate) === null,
  'calculateMonotony([60×7]) returns null (zero stdev)',
);

// AC-2: normal varied week (Example B)
// dailyLoads = [80, 0, 60, 0, 100, 50, 20]
// sum = 310, mean = 310/7 ≈ 44.286
// population variance = 9171.43/7 ≈ 1310.20, stdev ≈ 36.197
// monotony = 44.286 / 36.197 ≈ 1.2235
// NOTE: The spec's worked example contained an arithmetic error (it stated stdev ≈ 12.88
// and monotony ≈ 3.44). The correct population stdev is ≈ 36.197, monotony ≈ 1.2235.
const varied = [80, 0, 60, 0, 100, 50, 20];
const variedMono = calculateMonotony(varied);
assert(variedMono !== null, 'calculateMonotony([80,0,60,0,100,50,20]) returns non-null');
assert(
  variedMono !== null && near(variedMono, 1.2235, 0.001),
  `calculateMonotony([80,0,60,0,100,50,20]) ≈ 1.2235, got ${variedMono}`,
);

// AC-10: throws on wrong-length input
let threwOnShort = false;
try {
  calculateMonotony([1, 2, 3, 4, 5, 6]);
} catch {
  threwOnShort = true;
}
assert(threwOnShort, 'calculateMonotony throws on input length 6');

let threwOnLong = false;
try {
  calculateMonotony([1, 2, 3, 4, 5, 6, 7, 8]);
} catch {
  threwOnLong = true;
}
assert(threwOnLong, 'calculateMonotony throws on input length 8');

let threwOnEmpty = false;
try {
  calculateMonotony([]);
} catch {
  threwOnEmpty = true;
}
assert(threwOnEmpty, 'calculateMonotony throws on empty input');

// Population stdev: verify calculation precision
// mean = 310/7, variance = sum((v-mean)^2)/7, stdev = sqrt(variance)
const sum310 = varied.reduce((s, v) => s + v, 0);
assert(sum310 === 310, 'varied array sums to 310');
const mean310 = sum310 / 7;
const popVariance = varied.reduce((s, v) => s + (v - mean310) ** 2, 0) / 7;
const popStdev = Math.sqrt(popVariance);
const expectedMono = mean310 / popStdev;
assert(
  variedMono !== null && near(variedMono, expectedMono, 1e-10),
  `calculateMonotony matches hand calculation (${variedMono} vs ${expectedMono})`,
);

console.log('  calculateMonotony: all passed');

// ── calculateStrain ───────────────────────────────────────────────────────────

console.log('\nMON-001: calculateStrain');

// AC-3: degenerate (zero stdev) → weekly sum, no multiplier = 420
const strainDegenerate = calculateStrain(degenerate);
assert(
  strainDegenerate === 420,
  `calculateStrain([60×7]) = 420 (weekly sum, no multiplier), got ${strainDegenerate}`,
);

// AC-4: normal case → weeklySum × monotony
const strainVaried = calculateStrain(varied);
const expectedStrainVaried = 310 * expectedMono;
assert(
  near(strainVaried, expectedStrainVaried, 0.01),
  `calculateStrain([80,0,60,0,100,50,20]) ≈ ${expectedStrainVaried.toFixed(2)}, got ${strainVaried}`,
);

// Strain > weekly sum when monotony > 1
assert(
  strainVaried > 310,
  `calculateStrain([80,0,60,0,100,50,20]) > 310 (monotony > 1)`,
);

console.log('  calculateStrain: all passed');

// ── calculateMonotonyStrain — empty input ─────────────────────────────────────

console.log('\nMON-001: calculateMonotonyStrain — empty input');

// AC-5: empty activities → []
const emptyResult = calculateMonotonyStrain([], 'combined');
assert(emptyResult.length === 0, 'calculateMonotonyStrain([], combined) returns []');

const emptyRun = calculateMonotonyStrain([], 'run');
assert(emptyRun.length === 0, 'calculateMonotonyStrain([], run) returns []');

const emptyCycle = calculateMonotonyStrain([], 'cycle');
assert(emptyCycle.length === 0, 'calculateMonotonyStrain([], cycle) returns []');

console.log('  empty input: all passed');

// ── calculateMonotonyStrain — 6-day dataset (AC-6) ───────────────────────────

console.log('\nMON-001: calculateMonotonyStrain — 6-day partial window');

// A fixed past date ensures the window is bounded (not extended to today,
// which would introduce null-free days beyond the fixture). We pick a date
// far enough in the past that "today" is well beyond, and verify the first
// 6 rows all have null monotony/strain.
const SIX_DAY_BASE = '2020-01-01';
const sixDayActivities = Array.from({ length: 6 }, (_, i) => ({
  date: addDays(SIX_DAY_BASE, i),
  tss: 60,
  sport: 'running',
}));

const sixDayResult = calculateMonotonyStrain(sixDayActivities, 'run');

// The result spans from 2020-01-01 → today, but first 6 rows must be null
assert(sixDayResult.length >= 6, 'calculateMonotonyStrain: result has at least 6 rows');

const firstSixRows = sixDayResult.slice(0, 6);
assert(
  firstSixRows.every((r) => r.monotony === null),
  'first 6 rows have monotony: null (partial window)',
);
assert(
  firstSixRows.every((r) => r.strain === null),
  'first 6 rows have strain: null (partial window)',
);

// AC-6: all rows in a 6-activity dataset that only spans 6 days have nulls
// for the first 6 positions regardless of how many total days are in the range
const sixDayDates = firstSixRows.map((r) => r.date);
assert(
  sixDayDates[0] === SIX_DAY_BASE,
  `first row date is ${SIX_DAY_BASE}, got ${sixDayDates[0]}`,
);

console.log('  6-day partial window: all passed');

// ── calculateMonotonyStrain — 7-day dataset (AC-7) ───────────────────────────

console.log('\nMON-001: calculateMonotonyStrain — 7-day full window');

// Use a fixed 7-day window anchored in the past.
// We use today's date minus 7 days so we get exactly the fixture.
// However, calculateMonotonyStrain always extends to "today". For this test
// we use a past anchor and check just the fixture rows.
const SEVEN_DAY_BASE = '2020-02-01';
const sevenDayActivities = Array.from({ length: 7 }, (_, i) => ({
  date: addDays(SEVEN_DAY_BASE, i),
  tss: i === 0 ? 80 : i === 2 ? 60 : i === 4 ? 100 : i === 5 ? 50 : i === 6 ? 20 : 0,
  sport: 'running',
})).filter((a) => a.tss > 0);

const sevenDayResult = calculateMonotonyStrain(sevenDayActivities, 'run');

// Find the rows corresponding to the fixture dates
const sevenDayMap = new Map(sevenDayResult.map((r) => [r.date, r]));

// First 6 fixture rows (index 0–5) must have null
for (let i = 0; i < 6; i++) {
  const date = addDays(SEVEN_DAY_BASE, i);
  const row = sevenDayMap.get(date);
  assert(row !== undefined, `7-day fixture: row for ${date} exists`);
  assert(row?.monotony === null, `7-day fixture: row ${i + 1} monotony = null`);
  assert(row?.strain === null, `7-day fixture: row ${i + 1} strain = null`);
}

// 7th row (index 6) must have non-null monotony and strain
const seventhDate = addDays(SEVEN_DAY_BASE, 6);
const seventhRow = sevenDayMap.get(seventhDate);
assert(seventhRow !== undefined, `7-day fixture: row for ${seventhDate} exists`);
assert(
  seventhRow?.monotony !== null,
  `7-day fixture: 7th row has non-null monotony (got ${seventhRow?.monotony})`,
);
assert(
  seventhRow?.strain !== null,
  `7-day fixture: 7th row has non-null strain (got ${seventhRow?.strain})`,
);

console.log('  7-day full window: all passed');

// ── calculateMonotonyStrain — combined sport series (AC-8) ────────────────────

console.log('\nMON-001: calculateMonotonyStrain — combined sport weighting');

// AC-8: run tss=100 + cycle tss=100 on same date → combined load = 150
// (run: 100×1.0 = 100, cycle: 100×0.5 = 50)
const COMBINED_BASE = '2020-03-01';
const combinedActivities = [
  { date: COMBINED_BASE, tss: 100, sport: 'running' },
  { date: COMBINED_BASE, tss: 100, sport: 'cycling' },
];

// Add 6 more days of run-only load to get a full 7-day window
const combinedFull = [
  ...combinedActivities,
  ...Array.from({ length: 6 }, (_, i) => ({
    date: addDays(COMBINED_BASE, i + 1),
    tss: 0,
    sport: 'running',
  })).filter((a) => a.tss > 0),
];

// Verify by computing the combined daily load for the first day
const combinedDailyLoads = [150, 0, 0, 0, 0, 0, 0];
const expectedCombinedMono = calculateMonotony(combinedDailyLoads);
// monotony = 150/7 / stdev([150,0,0,0,0,0,0])
const cm = combinedDailyLoads.reduce((s, v) => s + v, 0) / 7;
const cv = combinedDailyLoads.reduce((s, v) => s + (v - cm) ** 2, 0) / 7;
const cStdev = Math.sqrt(cv);
const handMono = cm / cStdev;

assert(
  expectedCombinedMono !== null && near(expectedCombinedMono, handMono, 1e-10),
  `combined day load 150: monotony matches hand calculation`,
);

// Now run the full pipeline and check the 7th-row values
const combinedResult = calculateMonotonyStrain(
  [
    { date: COMBINED_BASE, tss: 100, sport: 'running' },
    { date: COMBINED_BASE, tss: 100, sport: 'cycling' },
    // Rest days (load = 0) don't need to be explicit — the pipeline fills them
  ],
  'combined',
);
const combinedMap = new Map(combinedResult.map((r) => [r.date, r]));

// First row has load 150; verify the pipeline sees exactly that
// by checking the 7th-row monotony against our hand-computed value
const seventhCombinedDate = addDays(COMBINED_BASE, 6);
const seventhCombined = combinedMap.get(seventhCombinedDate);
assert(seventhCombined !== undefined, `combined: row for ${seventhCombinedDate} exists`);
assert(
  seventhCombined?.monotony !== null,
  `combined: 7th row has non-null monotony`,
);
assert(
  seventhCombined !== null &&
    seventhCombined?.monotony !== null &&
    near(seventhCombined.monotony, Math.round(handMono * 10000) / 10000, 0.0001),
  `combined: 7th-row monotony ≈ ${(Math.round(handMono * 10000) / 10000).toFixed(4)}, got ${seventhCombined?.monotony}`,
);

// Also verify the 'run' series only sees run activities
const runOnlyResult = calculateMonotonyStrain(combinedActivities, 'run');
const runMap = new Map(runOnlyResult.map((r) => [r.date, r]));
const runDay1 = runMap.get(COMBINED_BASE);
// run series: only the run activity contributes, so day 1 load = 100
// With only 1 day of data, day 1 is the first row → monotony = null
assert(runDay1?.monotony === null, 'run series: 1-row result has null monotony (partial window)');

// cycle series: only the cycling activity contributes
const cycleOnlyResult = calculateMonotonyStrain(combinedActivities, 'cycle');
const cycleMap = new Map(cycleOnlyResult.map((r) => [r.date, r]));
const cycleDay1 = cycleMap.get(COMBINED_BASE);
assert(cycleDay1?.monotony === null, 'cycle series: 1-row result has null monotony (partial window)');

// Filtered-out sport produces empty result when the only activities are filtered
const noMatchRun = calculateMonotonyStrain(
  [{ date: COMBINED_BASE, tss: 100, sport: 'cycling' }],
  'run',
);
assert(noMatchRun.length === 0, 'run series: cycling-only activities → [] (no matching activities)');

const noMatchCycle = calculateMonotonyStrain(
  [{ date: COMBINED_BASE, tss: 100, sport: 'running' }],
  'cycle',
);
assert(noMatchCycle.length === 0, 'cycle series: running-only activities → [] (no matching activities)');

console.log('  combined sport weighting: all passed');

// ── calculateMonotonyStrain — other sport in combined series ──────────────────

console.log('\nMON-001: calculateMonotonyStrain — other sport receives weight 1.0 in combined');

// Swimming is neither run nor cycle → weight 1.0 in combined
const OTHER_BASE = '2020-04-01';
const otherSportActivities = Array.from({ length: 7 }, (_, i) => ({
  date: addDays(OTHER_BASE, i),
  tss: 100,
  sport: 'swimming',
}));

const combinedOther = calculateMonotonyStrain(otherSportActivities, 'combined');
const otherMap = new Map(combinedOther.map((r) => [r.date, r]));
const otherSeventhDate = addDays(OTHER_BASE, 6);
const otherSeventhRow = otherMap.get(otherSeventhDate);

// All same TSS (100) → stdev = 0 → monotony = null, strain = weekly sum = 700
assert(
  otherSeventhRow?.monotony === null,
  'combined/swimming: all-equal load → monotony = null',
);
assert(
  otherSeventhRow?.strain === 700,
  `combined/swimming: strain = 700 (weekly sum, no multiplier), got ${otherSeventhRow?.strain}`,
);

// If swim weight were 0.5, strain would be 350. Confirm it's 700 (weight = 1.0).
assert(otherSeventhRow?.strain !== 350, 'combined/swimming: strain ≠ 350 (weight is 1.0 not 0.5)');

console.log('  other sport weight 1.0: all passed');

// ── calculateMonotonyStrain — rounding ───────────────────────────────────────

console.log('\nMON-001: calculateMonotonyStrain — output rounding');

// Use the varied loads to test rounding in the pipeline
const ROUND_BASE = '2020-05-01';
const roundActivities = [80, 0, 60, 0, 100, 50, 20].flatMap((tss, i) =>
  tss > 0 ? [{ date: addDays(ROUND_BASE, i), tss, sport: 'running' }] : [],
);
const roundResult = calculateMonotonyStrain(roundActivities, 'run');
const roundMap = new Map(roundResult.map((r) => [r.date, r]));
const roundSeventhDate = addDays(ROUND_BASE, 6);
const roundSeventhRow = roundMap.get(roundSeventhDate);

assert(roundSeventhRow !== undefined, 'rounding test: 7th row exists');

// Monotony should be rounded to 4 decimal places
const rawMono = calculateMonotony(varied);
if (rawMono !== null && roundSeventhRow?.monotony !== null && roundSeventhRow !== undefined) {
  const roundedMono = Math.round(rawMono * 10000) / 10000;
  assert(
    roundSeventhRow.monotony === roundedMono,
    `monotony rounded to 4dp: expected ${roundedMono}, got ${roundSeventhRow.monotony}`,
  );
}

// Strain should be rounded to 2 decimal places
const rawStrain = calculateStrain(varied);
const roundedStrain = Math.round(rawStrain * 100) / 100;
if (roundSeventhRow !== undefined) {
  assert(
    roundSeventhRow.strain === roundedStrain,
    `strain rounded to 2dp: expected ${roundedStrain}, got ${roundSeventhRow.strain}`,
  );
}

console.log('  rounding: all passed');

// ── calculateMonotonyStrain — date range extends to today ─────────────────────

console.log('\nMON-001: calculateMonotonyStrain — date range');

// Result should start at the earliest activity date
const RANGE_BASE = '2020-06-01';
const rangeActivities = [
  { date: RANGE_BASE, tss: 80, sport: 'running' },
  { date: addDays(RANGE_BASE, 3), tss: 60, sport: 'running' },
];
const rangeResult = calculateMonotonyStrain(rangeActivities, 'run');

assert(rangeResult.length > 0, 'date range: result is non-empty');
assert(rangeResult[0].date === RANGE_BASE, `date range: starts at ${RANGE_BASE}`);

// Result should extend through today
const today = new Date().toISOString().slice(0, 10);
assert(
  rangeResult[rangeResult.length - 1].date === today,
  `date range: ends at today (${today}), got ${rangeResult[rangeResult.length - 1].date}`,
);

// Result should be a contiguous daily sequence (no gaps)
for (let i = 1; i < rangeResult.length; i++) {
  const prev = new Date(rangeResult[i - 1].date + 'T00:00:00Z');
  const curr = new Date(rangeResult[i].date + 'T00:00:00Z');
  const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
  assert(
    diffDays === 1,
    `date range: no gap between row ${i - 1} (${rangeResult[i - 1].date}) and row ${i} (${rangeResult[i].date})`,
  );
}

console.log('  date range: all passed');

// ── Example B hand-calculation verification ───────────────────────────────────

console.log('\nMON-001: Example B hand-calculation cross-check');

// From the spec:
// dailyLoads = [80, 0, 60, 0, 100, 50, 20]
// sum = 310, mean = 310/7 ≈ 44.286
// population variance = sum((v - mean)^2) / 7 = 9171.43 / 7 ≈ 1310.20
// population stdev ≈ 36.197
// monotony = 44.286 / 36.197 ≈ 1.2235
// strain = 310 × 1.2235 ≈ 379.28
//
// NOTE: The spec's worked example contained an arithmetic error. It stated the
// sum of squared deviations as 1161.22 (actual: 9171.43), which led to the
// incorrect stdev ≈ 12.88 and monotony ≈ 3.44. The library's population stdev
// formula is correct; tests use the mathematically accurate values.

const exBMono = calculateMonotony(varied);
const exBStrain = calculateStrain(varied);

// Hand-calculate expected values
const exBMean = 310 / 7;
const exBPopVar = varied.reduce((s, v) => s + (v - exBMean) ** 2, 0) / 7;
const exBPopStdev = Math.sqrt(exBPopVar);
const exBExpectedMono = exBMean / exBPopStdev; // ≈ 1.2235
const exBExpectedStrain = 310 * exBExpectedMono; // ≈ 379.28

assert(exBMono !== null, 'Example B: monotony is non-null');
assert(
  exBMono !== null && near(exBMono, exBExpectedMono, 1e-10),
  `Example B: monotony ≈ ${exBExpectedMono.toFixed(4)}, got ${exBMono?.toFixed(4)}`,
);
assert(
  near(exBStrain, exBExpectedStrain, 0.01),
  `Example B: strain ≈ ${exBExpectedStrain.toFixed(2)}, got ${exBStrain.toFixed(2)}`,
);

// Verify the formula uses population stdev (divide by N=7, not N-1=6)
const sampleVar = varied.reduce((s, v) => s + (v - exBMean) ** 2, 0) / 6;
const sampleStdev = Math.sqrt(sampleVar);
const sampleMono = exBMean / sampleStdev;
assert(
  exBMono !== null && Math.abs(exBMono - exBExpectedMono) < Math.abs(exBMono - sampleMono),
  'Example B: population stdev used (not sample stdev)',
);

console.log('  Example B cross-check: all passed');

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode === 1) {
  console.log('\n✗ MON-001 tests FAILED');
} else {
  console.log('\n✓ All MON-001 tests passed');
}
