/**
 * PMC-001 Regression Test — R5
 *
 * Verifies that calculatePMC output matches expected CTL/ATL/TSB values
 * within ±0.5 TSS. Expected values were computed using the same Banister
 * Impulse-Response formula as TrainingPeaks (tc_fitness=42, tc_fatigue=7).
 *
 * Run with:
 *   node --experimental-strip-types __tests__/pmc.test.ts
 */

import { calculatePMC } from '../lib/pmc.ts';

// ── 30-day fixture ────────────────────────────────────────────────────────────
// TSS pattern: realistic athlete training week with hard days, rest days, and
// a long run on day 28. Start date is an arbitrary fixed date so the test is
// not affected by "today".

const BASE_DATE = '2024-01-01';
const TSS_INPUTS = [
  80, 0, 60, 90, 0, 0, 120,
  70, 0, 55, 85, 0, 0, 100,
  65, 0, 75, 95, 0, 0, 110,
  60, 0, 70, 90, 0, 0, 130,
  0, 80,
];

// Expected values computed at 1 decimal precision with tc_fitness=42, tc_fatigue=7
// TSB = CTL(prev) - ATL(prev) (form going INTO the day)
const EXPECTED: Array<{ tss: number; ctl: number; atl: number; tsb: number }> = [
  { tss:  80, ctl:  1.9, atl: 10.6, tsb:   0.0 },
  { tss:   0, ctl:  1.8, atl:  9.2, tsb:  -8.8 },
  { tss:  60, ctl:  3.2, atl: 16.0, tsb:  -7.4 },
  { tss:  90, ctl:  5.2, atl: 25.8, tsb: -12.8 },
  { tss:   0, ctl:  5.1, atl: 22.4, tsb: -20.6 },
  { tss:   0, ctl:  5.0, atl: 19.4, tsb: -17.3 },
  { tss: 120, ctl:  7.7, atl: 32.8, tsb: -14.4 },
  { tss:  70, ctl:  9.2, atl: 37.8, tsb: -25.1 },
  { tss:   0, ctl:  9.0, atl: 32.7, tsb: -28.6 },
  { tss:  55, ctl: 10.0, atl: 35.7, tsb: -23.8 },
  { tss:  85, ctl: 11.8, atl: 42.3, tsb: -25.7 },
  { tss:   0, ctl: 11.5, atl: 36.6, tsb: -30.5 },
  { tss:   0, ctl: 11.3, atl: 31.8, tsb: -25.1 },
  { tss: 100, ctl: 13.3, atl: 40.8, tsb: -20.5 },
  { tss:  65, ctl: 14.6, atl: 44.1, tsb: -27.5 },
  { tss:   0, ctl: 14.2, atl: 38.2, tsb: -29.5 },
  { tss:  75, ctl: 15.6, atl: 43.1, tsb: -24.0 },
  { tss:  95, ctl: 17.5, atl: 50.0, tsb: -27.4 },
  { tss:   0, ctl: 17.1, atl: 43.3, tsb: -32.5 },
  { tss:   0, ctl: 16.7, atl: 37.6, tsb: -26.2 },
  { tss: 110, ctl: 18.9, atl: 47.2, tsb: -20.9 },
  { tss:  60, ctl: 19.9, atl: 48.9, tsb: -28.3 },
  { tss:   0, ctl: 19.4, atl: 42.4, tsb: -29.1 },
  { tss:  70, ctl: 20.6, atl: 46.1, tsb: -23.0 },
  { tss:  90, ctl: 22.2, atl: 51.9, tsb: -25.5 },
  { tss:   0, ctl: 21.7, atl: 45.0, tsb: -29.7 },
  { tss:   0, ctl: 21.2, atl: 39.0, tsb: -23.3 },
  { tss: 130, ctl: 23.7, atl: 51.1, tsb: -17.8 },
  { tss:   0, ctl: 23.2, atl: 44.3, tsb: -27.4 },
  { tss:  80, ctl: 24.5, atl: 49.1, tsb: -21.1 },
];

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
  }
}

function near(a: number, b: number, tol = 0.5): boolean {
  return Math.abs(a - b) <= tol;
}

// ── Build activities input ────────────────────────────────────────────────────

const activities = TSS_INPUTS.flatMap((tss, i) =>
  tss > 0
    ? [{ date: addDays(BASE_DATE, i), tss }]
    : [],
);

// The last date in the fixture (day 30 = index 29)
const FIXTURE_END = addDays(BASE_DATE, 29);

// ── Run calculatePMC and validate ─────────────────────────────────────────────

console.log('PMC-001 Regression Test');
console.log(`  Fixture: 30 days from ${BASE_DATE} to ${FIXTURE_END}`);
console.log(`  Activities: ${activities.length} days with TSS > 0`);
console.log();

const result = calculatePMC(activities);

// Only validate the first 30 days (the fixture range)
const resultMap = new Map(result.map((d) => [d.date, d]));

let passed = 0;
let failed = 0;

for (let i = 0; i < EXPECTED.length; i++) {
  const date = addDays(BASE_DATE, i);
  const exp = EXPECTED[i];
  const got = resultMap.get(date);

  if (!got) {
    assert(false, `day ${i + 1} (${date}): missing from result`);
    failed++;
    continue;
  }

  const ctlOk = near(got.ctl, exp.ctl);
  const atlOk = near(got.atl, exp.atl);
  const tsbOk = near(got.tsb, exp.tsb);

  if (ctlOk && atlOk && tsbOk) {
    passed++;
  } else {
    failed++;
    if (!ctlOk) assert(false, `day ${i + 1} CTL: got ${got.ctl}, expected ${exp.ctl} (±0.5)`);
    if (!atlOk) assert(false, `day ${i + 1} ATL: got ${got.atl}, expected ${exp.atl} (±0.5)`);
    if (!tsbOk) assert(false, `day ${i + 1} TSB: got ${got.tsb}, expected ${exp.tsb} (±0.5)`);
  }
}

// ── Edge-case tests ───────────────────────────────────────────────────────────

// Empty input → empty output
const empty = calculatePMC([]);
assert(empty.length === 0, 'empty input should return []');

// Single activity: CTL/ATL start at 0
const single = calculatePMC([{ date: BASE_DATE, tss: 100 }]);
const singleDay = single.find((d) => d.date === BASE_DATE);
assert(singleDay !== undefined, 'single activity: day present in result');
assert(singleDay?.tsb === 0, 'single activity: TSB on first day = 0 (no prior load)');
assert((singleDay?.ctl ?? 0) > 0, 'single activity: CTL > 0 after training day');

// Custom time constants
const custom = calculatePMC([{ date: BASE_DATE, tss: 100 }], { tc_fitness: 21, tc_fatigue: 3 });
const customDay = custom.find((d) => d.date === BASE_DATE);
const defaultDay = single.find((d) => d.date === BASE_DATE);
assert(
  (customDay?.ctl ?? 0) > (defaultDay?.ctl ?? 0),
  'shorter tc_fitness → higher CTL gain per day',
);

// Multiple activities on same day are summed
const multiDay = calculatePMC([
  { date: BASE_DATE, tss: 40 },
  { date: BASE_DATE, tss: 60 },
]);
const singleBig = calculatePMC([{ date: BASE_DATE, tss: 100 }]);
const multiResult = multiDay.find((d) => d.date === BASE_DATE);
const singleResult = singleBig.find((d) => d.date === BASE_DATE);
assert(
  multiResult?.ctl === singleResult?.ctl,
  'two activities summed (40+60) equals one activity of 100',
);

// Rest day decays CTL and ATL (TSS=0)
const restDay = addDays(BASE_DATE, 1);
const afterRest = calculatePMC([{ date: BASE_DATE, tss: 100 }]);
const restResult = afterRest.find((d) => d.date === restDay);
const trainingResult = afterRest.find((d) => d.date === BASE_DATE);
assert(
  (restResult?.atl ?? 0) < (trainingResult?.atl ?? 0),
  'rest day: ATL decays toward zero',
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`30-day fixture: ${passed}/30 days passed (within ±0.5 TSS)`);

if (process.exitCode === 1) {
  console.log('\n✗ Test failed');
} else {
  console.log('Edge cases: all passed');
  console.log('\n✓ All tests passed');
}
