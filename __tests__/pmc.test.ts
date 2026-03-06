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
import { getKRace, autoDetectRace } from '../lib/raceDetection.ts';
import {
  calculatePerformanceScore,
  checkBenchmarkCriteria,
  computeFittingEligibility,
} from '../lib/benchmarkUtils.ts';

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

function round1Test(v: number): number {
  return Math.round(v * 10) / 10;
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

// ── PMC-002: Race multiplier tests ───────────────────────────────────────────

console.log();
console.log('PMC-002 Race Multiplier Tests');

// getKRace duration table
assert(getKRace(2) === 1.0, 'getKRace: < 4 hours → 1.0×');
assert(getKRace(4) === 1.5, 'getKRace: 4 hours → 1.5×');
assert(getKRace(6) === 1.5, 'getKRace: 6 hours → 1.5×');
assert(getKRace(8) === 2.0, 'getKRace: 8 hours → 2.0×');
assert(getKRace(10) === 2.0, 'getKRace: 10 hours → 2.0×');
assert(getKRace(12) === 2.5, 'getKRace: 12 hours → 2.5×');
assert(getKRace(20) === 2.5, 'getKRace: > 12 hours → 2.5×');

// autoDetectRace — activity_type method
assert(
  autoDetectRace({ sport: 'race', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).is_race,
  'autoDetectRace: sport = "race" → is_race = true',
);
assert(
  autoDetectRace({ sport: 'running_race', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).is_race,
  'autoDetectRace: sport contains "race" → is_race = true',
);
assert(
  autoDetectRace({ sport: 'running_race', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).detection_reason === 'activity_type',
  'autoDetectRace: detection_reason = activity_type',
);

// autoDetectRace — avg HR method (91% of 185 = 168.35)
assert(
  autoDetectRace({ sport: 'running', avg_hr: 170, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).is_race,
  'autoDetectRace: avg HR 170 > 88% of 185 → is_race = true',
);
assert(
  autoDetectRace({ sport: 'running', avg_hr: 170, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).detection_reason === 'avg_hr',
  'autoDetectRace: detection_reason = avg_hr',
);

// autoDetectRace — negative HR case
assert(
  !autoDetectRace({ sport: 'running', avg_hr: 140, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).is_race,
  'autoDetectRace: avg HR 140 < 88% of 185 → is_race = false',
);

// autoDetectRace — pace method (within 5% of PB)
assert(
  autoDetectRace({ sport: 'running', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: 252, pb_pace_seconds: 245 }).is_race,
  'autoDetectRace: pace 252 within 5% of PB 245 → is_race = true',
);
assert(
  autoDetectRace({ sport: 'running', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: 252, pb_pace_seconds: 245 }).detection_reason === 'pace',
  'autoDetectRace: detection_reason = pace',
);

// autoDetectRace — pace outside 5% of PB
assert(
  !autoDetectRace({ sport: 'running', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: 290, pb_pace_seconds: 245 }).is_race,
  'autoDetectRace: pace 290 outside 5% of PB 245 → is_race = false',
);

// autoDetectRace — all null inputs
assert(
  !autoDetectRace({ sport: 'running', avg_hr: null, hr_max_estimate: 185, avg_pace_seconds: null, pb_pace_seconds: null }).is_race,
  'autoDetectRace: no signals → is_race = false',
);

// Race multiplier: 10hr race (k_race = 2.0) — ATL gets 2× TSS, CTL stays raw
// Single race activity with TSS=100, k_race=2.0 → atl_tss=200
const raceActivity = [{ date: BASE_DATE, tss: 100, atl_tss: 200 }];
const raceResult = calculatePMC(raceActivity);
const raceDay = raceResult.find((d) => d.date === BASE_DATE);
const nonRaceResult = calculatePMC([{ date: BASE_DATE, tss: 100 }]);
const nonRaceDay = nonRaceResult.find((d) => d.date === BASE_DATE);

assert(raceDay !== undefined, 'race day present in result');
assert(
  (raceDay?.atl ?? 0) > (nonRaceDay?.atl ?? 0),
  'race multiplier: ATL with k_race=2.0 > ATL without multiplier',
);
assert(
  Math.abs((raceDay?.ctl ?? 0) - (nonRaceDay?.ctl ?? 0)) < 0.01,
  'race multiplier: CTL is unaffected by atl_tss',
);

// Verify ATL is approximately 2× the non-race ATL (same formula, just 2× load input)
const k_ctl_default = 1 - Math.exp(-1 / 42);
const k_atl_default = 1 - Math.exp(-1 / 7);
const expectedAtlRace = round1Test(200 * k_atl_default);
const expectedAtlNormal = round1Test(100 * k_atl_default);
assert(
  near(raceDay?.atl ?? 0, expectedAtlRace),
  `race ATL: got ${raceDay?.atl}, expected ~${expectedAtlRace}`,
);
assert(
  near(nonRaceDay?.atl ?? 0, expectedAtlNormal),
  `non-race ATL: got ${nonRaceDay?.atl}, expected ~${expectedAtlNormal}`,
);

// Non-race: omitting atl_tss falls back to raw tss for ATL
const noAtlTssResult = calculatePMC([{ date: BASE_DATE, tss: 100 }]);
const noAtlTssDay = noAtlTssResult.find((d) => d.date === BASE_DATE);
assert(
  noAtlTssDay?.atl === nonRaceDay?.atl,
  'omitting atl_tss: ATL same as explicit atl_tss=tss',
);

console.log('Race detection: all passed');

// ── PMC-003: Benchmark Effort System tests ────────────────────────────────────

console.log();
console.log('PMC-003 Benchmark Effort Tests');

// checkBenchmarkCriteria — AND logic (both conditions must be true)

// Both conditions met → qualifies
assert(
  checkBenchmarkCriteria(175, 185, 252, 245),
  'checkBenchmarkCriteria: HR 175 > 90% of 185 AND pace 252 ≤ PB 245 × 1.05 → true',
);

// HR high enough but pace outside 5% of PB → does not qualify
assert(
  !checkBenchmarkCriteria(175, 185, 290, 245),
  'checkBenchmarkCriteria: HR ok but pace 290 outside 5% of PB 245 → false',
);

// Pace within 5% but HR below 90% HRmax → does not qualify
assert(
  !checkBenchmarkCriteria(150, 185, 252, 245),
  'checkBenchmarkCriteria: pace ok but HR 150 < 90% of 185 → false',
);

// HR at exactly 90% threshold (not strictly greater) → does not qualify
assert(
  !checkBenchmarkCriteria(166.5, 185, 252, 245),
  'checkBenchmarkCriteria: avg HR = exactly 90% HRmax → false (must be strictly greater)',
);

// Null avg_hr → does not qualify
assert(
  !checkBenchmarkCriteria(null, 185, 252, 245),
  'checkBenchmarkCriteria: null avg_hr → false',
);

// Null pbPaceSeconds → does not qualify (can't verify pace criterion)
assert(
  !checkBenchmarkCriteria(175, 185, 252, null),
  'checkBenchmarkCriteria: null pbPaceSeconds → false',
);

// Both null → does not qualify
assert(
  !checkBenchmarkCriteria(null, 185, null, null),
  'checkBenchmarkCriteria: all null → false',
);

// calculatePerformanceScore — running uses VDOT

// 5K in 20:00 → VDOT ~47.5 (reasonable range check)
const score5k = calculatePerformanceScore('running', 5000, 20 * 60);
assert(score5k !== null, 'calculatePerformanceScore: 5K in 20 min → non-null');
assert(
  (score5k ?? 0) >= 40 && (score5k ?? 0) <= 60,
  `calculatePerformanceScore: 5K in 20 min → VDOT in [40, 60], got ${score5k}`,
);

// 10K in 40:00 → similar VDOT to 5K in 20 min (Riegel equivalence)
const score10k = calculatePerformanceScore('running', 10000, 40 * 60);
assert(score10k !== null, 'calculatePerformanceScore: 10K in 40 min → non-null');
assert(
  score5k !== null && score10k !== null && Math.abs(score5k - score10k) < 3,
  `calculatePerformanceScore: 5K 20min and 10K 40min should yield similar VDOT (±3), got ${score5k} vs ${score10k}`,
);

// Faster athlete → higher score
const scoreFast = calculatePerformanceScore('running', 5000, 15 * 60);
const scoreSlow = calculatePerformanceScore('running', 5000, 25 * 60);
assert(
  (scoreFast ?? 0) > (scoreSlow ?? 0),
  'calculatePerformanceScore: faster 5K time → higher VDOT score',
);

// Cycling → null (cannot auto-calculate without NP + weight)
assert(
  calculatePerformanceScore('cycling', 50000, 3600) === null,
  'calculatePerformanceScore: cycling → null',
);

// Other sport → null
assert(
  calculatePerformanceScore('swimming', 1500, 1200) === null,
  'calculatePerformanceScore: swimming → null',
);

// Null distance → null
assert(
  calculatePerformanceScore('running', null, 1200) === null,
  'calculatePerformanceScore: null distance → null',
);

// Null duration → null
assert(
  calculatePerformanceScore('running', 5000, null) === null,
  'calculatePerformanceScore: null duration → null',
);

// computeFittingEligibility — minimum data gate

// Empty → not eligible
const emptyElig = computeFittingEligibility([]);
assert(!emptyElig.eligible, 'computeFittingEligibility: empty → not eligible');
assert(emptyElig.count === 0, 'computeFittingEligibility: empty → count = 0');
assert(emptyElig.needed === 6, 'computeFittingEligibility: needed = 6');

// 5 benchmarks over 12 months → not eligible (count < 6)
const fiveDates = [
  '2023-01-15', '2023-03-10', '2023-06-01',
  '2023-09-20', '2024-01-15',
];
const fiveElig = computeFittingEligibility(fiveDates);
assert(!fiveElig.eligible, 'computeFittingEligibility: 5 benchmarks → not eligible');
assert(fiveElig.count === 5, 'computeFittingEligibility: 5 benchmarks → count = 5');
assert(fiveElig.months_span > 6, 'computeFittingEligibility: 5 benchmarks → months_span > 6');

// 6 benchmarks over only 3 months → not eligible (span < 6 months)
const sixShortDates = [
  '2024-01-01', '2024-01-15', '2024-02-01',
  '2024-02-15', '2024-03-01', '2024-03-15',
];
const sixShortElig = computeFittingEligibility(sixShortDates);
assert(!sixShortElig.eligible, 'computeFittingEligibility: 6 benchmarks over 3 months → not eligible');
assert(sixShortElig.count === 6, 'computeFittingEligibility: 6 benchmarks → count = 6');
assert(sixShortElig.months_span < 6, 'computeFittingEligibility: 3-month span → months_span < 6');

// 6 benchmarks over 8 months → eligible
const sixGoodDates = [
  '2023-01-10', '2023-03-05', '2023-05-20',
  '2023-07-15', '2023-09-01', '2023-09-10',
];
const sixGoodElig = computeFittingEligibility(sixGoodDates);
assert(sixGoodElig.eligible, 'computeFittingEligibility: 6 benchmarks over 8 months → eligible');
assert(sixGoodElig.count === 6, 'computeFittingEligibility: 6 benchmarks → count = 6');
assert(sixGoodElig.months_span >= 6, 'computeFittingEligibility: 8-month span → months_span >= 6');

// 10 benchmarks over 18 months → eligible, returns correct shape
const tenDates = [
  '2022-01-01', '2022-04-01', '2022-07-01', '2022-10-01',
  '2023-01-01', '2023-04-01', '2023-07-01', '2023-10-01',
  '2024-01-01', '2024-04-01',
];
const tenElig = computeFittingEligibility(tenDates);
assert(tenElig.eligible, 'computeFittingEligibility: 10 benchmarks over 27 months → eligible');
assert(tenElig.count === 10, 'computeFittingEligibility: 10 benchmarks → count = 10');
assert(tenElig.months_span > 24, 'computeFittingEligibility: 27-month span → months_span > 24');
assert(tenElig.needed === 6, 'computeFittingEligibility: needed always = 6');

// Unsorted input → same result as sorted input (order should not matter)
const unsortedDates = [...sixGoodDates].reverse();
const unsortedElig = computeFittingEligibility(unsortedDates);
assert(
  unsortedElig.eligible === sixGoodElig.eligible &&
    unsortedElig.count === sixGoodElig.count,
  'computeFittingEligibility: unsorted input → same result as sorted',
);

console.log('Benchmark effort: all passed');

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`30-day fixture: ${passed}/30 days passed (within ±0.5 TSS)`);

if (process.exitCode === 1) {
  console.log('\n✗ Test failed');
} else {
  console.log('Edge cases: all passed');
  console.log('\n✓ All tests passed');
}
