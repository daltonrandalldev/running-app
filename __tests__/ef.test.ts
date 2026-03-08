/**
 * EF-002: Efficiency Factor Library — Unit Tests
 *
 * Run with:
 *   node --experimental-strip-types __tests__/ef.test.ts
 */

import {
  calculateEFRun,
  calculateEFFromLaps,
  isQualifyingRun,
  computeRollingEFAvg,
  computeEFRegression,
  detectEFAlert,
  normalizeTempEF,
  type EFLapRecord,
} from '../lib/ef.ts';

import type { HRZones } from '../lib/hrZones.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

function near(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

// Sample HR zones used for qualifying-run tests.
// Zone 1: 120–139, Zone 2: 140–159, Zone 3: 160–179, Zone 4: 180–189, Zone 5: 190–200
const TEST_ZONES: HRZones = [
  { min: 120, max: 139 },
  { min: 140, max: 159 },
  { min: 160, max: 179 },
  { min: 180, max: 189 },
  { min: 190, max: 200 },
];

// ── calculateEFRun ─────────────────────────────────────────────────────────────

console.log('calculateEFRun tests');

// Basic calculation
{
  const result = calculateEFRun(0.04, 140);
  const expected = 0.04 / 140;
  assert(
    result !== null && near(result, expected, 1e-12),
    `calculateEFRun(0.04, 140) = ${result}, expected ${expected}`,
  );
}

// Guard: speedMps = 0 → null
assert(calculateEFRun(0, 140) === null, 'calculateEFRun(0, 140) → null');

// Guard: avgHR = 0 → null
assert(calculateEFRun(0.04, 0) === null, 'calculateEFRun(0.04, 0) → null');

// Guard: negative speed → null
assert(calculateEFRun(-1, 140) === null, 'calculateEFRun(-1, 140) → null');

// Guard: negative HR → null
assert(calculateEFRun(0.04, -140) === null, 'calculateEFRun(0.04, -140) → null');

// Guard: both zero → null
assert(calculateEFRun(0, 0) === null, 'calculateEFRun(0, 0) → null');

// ── calculateEFFromLaps ────────────────────────────────────────────────────────

console.log();
console.log('calculateEFFromLaps tests');

// Warmup exclusion: 3 laps with elapsed_time_seconds 480, 780, 1200
// Laps 1 (480s < 600) and 2 (780s >= 600) — wait: lap 2 has elapsed=780 which IS >= 600
// Per spec: drop laps where elapsed_time_seconds < 600
// Lap 1: elapsed=480 → dropped (< 600)
// Lap 2: elapsed=780 → NOT dropped (>= 600)
// Lap 3: elapsed=1200 → NOT dropped
// So only lap 1 is warmup. Let's use elapsed 480, 580, 1200 so first two are < 600.
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 300, elapsed_time_seconds: 480,  distance: 1200, avg_hr: 140, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 300, elapsed_time_seconds: 580,  distance: 1200, avg_hr: 140, gap_pace_sec_per_km: null },
    { lap: 3, moving_time_seconds: 300, elapsed_time_seconds: 1200, distance: 1200, avg_hr: 140, gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  // Only lap 3 contributes: speed = 1200/300 = 4.0, HR = 140, EF = 4.0/140
  const expectedEF = 4.0 / 140;
  assert(result !== null, 'Warmup exclusion: result is not null');
  assert(result !== null && result.lapCount === 1, `Warmup exclusion: lapCount = 1 (got ${result?.lapCount})`);
  assert(
    result !== null && near(result.efValue, expectedEF, 1e-9),
    `Warmup exclusion: efValue = ${result?.efValue}, expected ${expectedEF}`,
  );
}

// GAP usage: laps with gap_pace_sec_per_km set → gapUsed = true
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 300, elapsed_time_seconds: 800,  distance: 1200, avg_hr: 145, gap_pace_sec_per_km: 250 },
    { lap: 2, moving_time_seconds: 300, elapsed_time_seconds: 1100, distance: 1200, avg_hr: 148, gap_pace_sec_per_km: 260 },
  ];
  const result = calculateEFFromLaps(laps);
  assert(result !== null && result.gapUsed === true, `GAP usage: gapUsed = true (got ${result?.gapUsed})`);
}

// All null gap_pace_sec_per_km → gapUsed = false
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 300, elapsed_time_seconds: 800,  distance: 1200, avg_hr: 145, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 300, elapsed_time_seconds: 1100, distance: 1200, avg_hr: 148, gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  assert(result !== null && result.gapUsed === false, `All-null GAP: gapUsed = false (got ${result?.gapUsed})`);
}

// All-warmup scenario: every lap has elapsed_time_seconds < 600 → null
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 200, elapsed_time_seconds: 200, distance: 800, avg_hr: 130, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 200, elapsed_time_seconds: 400, distance: 800, avg_hr: 135, gap_pace_sec_per_km: null },
    { lap: 3, moving_time_seconds: 180, elapsed_time_seconds: 580, distance: 720, avg_hr: 138, gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  assert(result === null, 'All-warmup: returns null');
}

// Null elapsed_time_seconds treated as warmup (dropped)
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 300, elapsed_time_seconds: null, distance: 1200, avg_hr: 140, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 300, elapsed_time_seconds: 800,  distance: 1200, avg_hr: 145, gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  // Lap 1 is dropped (elapsed = null), only lap 2 contributes
  assert(result !== null && result.lapCount === 1, `Null elapsed: lapCount = 1 (got ${result?.lapCount})`);
}

// All null elapsed_time_seconds → null
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 300, elapsed_time_seconds: null, distance: 1200, avg_hr: 140, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 300, elapsed_time_seconds: null, distance: 1200, avg_hr: 145, gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  assert(result === null, 'All null elapsed: returns null');
}

// Null avg_hr laps skipped from weighting
{
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 300, elapsed_time_seconds: 800,  distance: 1200, avg_hr: null, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 300, elapsed_time_seconds: 1100, distance: 1200, avg_hr: 145,  gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  // Lap 1 skipped (avg_hr null), only lap 2 contributes
  assert(result !== null && result.lapCount === 1, `Null avg_hr: lapCount = 1 (got ${result?.lapCount})`);
  const expectedEF = (1200 / 300) / 145; // speed = 4.0, EF = 4.0/145
  assert(
    result !== null && near(result.efValue, expectedEF, 1e-9),
    `Null avg_hr: efValue = ${result?.efValue}, expected ${expectedEF}`,
  );
}

// Time-weighted average correctness: 2 post-warmup laps with different moving_time_seconds
{
  // Lap A: moving_time=200s, distance=1000m → speed=5.0, HR=140, weight=200
  // Lap B: moving_time=400s, distance=1600m → speed=4.0, HR=150, weight=400
  // Weighted avg speed = (5.0*200 + 4.0*400) / (200+400) = (1000+1600)/600 = 2600/600 = 4.3333...
  // Weighted avg HR   = (140*200 + 150*400) / (200+400) = (28000+60000)/600 = 88000/600 = 146.6666...
  // EF = 4.3333.../146.6666... = 0.02954545...
  const laps: EFLapRecord[] = [
    { lap: 1, moving_time_seconds: 200, elapsed_time_seconds: 700,  distance: 1000, avg_hr: 140, gap_pace_sec_per_km: null },
    { lap: 2, moving_time_seconds: 400, elapsed_time_seconds: 1100, distance: 1600, avg_hr: 150, gap_pace_sec_per_km: null },
  ];
  const result = calculateEFFromLaps(laps);
  const weightedSpeed = (5.0 * 200 + 4.0 * 400) / 600;
  const weightedHR    = (140 * 200 + 150 * 400) / 600;
  const expectedEF    = weightedSpeed / weightedHR;
  assert(result !== null && result.lapCount === 2, `Time-weighted: lapCount = 2 (got ${result?.lapCount})`);
  assert(
    result !== null && near(result.efValue, expectedEF, 1e-9),
    `Time-weighted: efValue = ${result?.efValue?.toFixed(8)}, expected ${expectedEF.toFixed(8)}`,
  );
}

// ── isQualifyingRun ───────────────────────────────────────────────────────────

console.log();
console.log('isQualifyingRun tests');

// Duration: exactly 1800 → disqualified
{
  const r = isQualifyingRun({ movingTimeSec: 1800, avgHR: 145, zones: TEST_ZONES, avgTempC: 20 });
  assert(!r.qualifying && r.reason === 'duration_too_short', `movingTimeSec=1800 → duration_too_short (got qualifying=${r.qualifying}, reason=${r.reason})`);
}

// Duration: 1801 → passes duration check (may still fail others)
{
  const r = isQualifyingRun({ movingTimeSec: 1801, avgHR: 145, zones: TEST_ZONES, avgTempC: 20 });
  assert(r.reason !== 'duration_too_short', `movingTimeSec=1801 → does not fail duration (reason=${r.reason})`);
}

// Temperature: 28 → temp_out_of_range
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 145, zones: TEST_ZONES, avgTempC: 28 });
  assert(!r.qualifying && r.reason === 'temp_out_of_range', `avgTempC=28 → temp_out_of_range (got ${r.reason})`);
}

// Temperature: exactly 27 → passes temp check
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 145, zones: TEST_ZONES, avgTempC: 27 });
  assert(r.reason !== 'temp_out_of_range', `avgTempC=27 → does not fail temp (reason=${r.reason})`);
}

// Temperature: -1 → temp_out_of_range
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 145, zones: TEST_ZONES, avgTempC: -1 });
  assert(!r.qualifying && r.reason === 'temp_out_of_range', `avgTempC=-1 → temp_out_of_range (got ${r.reason})`);
}

// Temperature: exactly 0 → passes temp check
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 145, zones: TEST_ZONES, avgTempC: 0 });
  assert(r.reason !== 'temp_out_of_range', `avgTempC=0 → does not fail temp (reason=${r.reason})`);
}

// Temperature: null → does not disqualify
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 145, zones: TEST_ZONES, avgTempC: null });
  assert(r.reason !== 'temp_out_of_range', `avgTempC=null → does not fail temp (reason=${r.reason})`);
}

// HR: above zones[1].max (159) → hr_outside_z2
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 160, zones: TEST_ZONES, avgTempC: 20 });
  assert(!r.qualifying && r.reason === 'hr_outside_z2', `avgHR=160 (above Z2 max 159) → hr_outside_z2 (got ${r.reason})`);
}

// HR: below zones[0].min (120) → hr_outside_z2
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 119, zones: TEST_ZONES, avgTempC: 20 });
  assert(!r.qualifying && r.reason === 'hr_outside_z2', `avgHR=119 (below Z1 min 120) → hr_outside_z2 (got ${r.reason})`);
}

// HR: within Z1–Z2 bounds → qualifies
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 145, zones: TEST_ZONES, avgTempC: 20 });
  assert(r.qualifying, `avgHR=145 (within Z1–Z2) → qualifying (got qualifying=${r.qualifying})`);
}

// Precedence: duration fires before temp
{
  const r = isQualifyingRun({ movingTimeSec: 1800, avgHR: 145, zones: TEST_ZONES, avgTempC: 35 });
  assert(r.reason === 'duration_too_short', `Precedence: duration fires before temp (got ${r.reason})`);
}

// Precedence: temp fires before HR
{
  const r = isQualifyingRun({ movingTimeSec: 2000, avgHR: 200, zones: TEST_ZONES, avgTempC: 35 });
  assert(r.reason === 'temp_out_of_range', `Precedence: temp fires before HR (got ${r.reason})`);
}

// ── computeRollingEFAvg ───────────────────────────────────────────────────────

console.log();
console.log('computeRollingEFAvg tests');

// 30-day window: entries spanning 45 days; only entries in the most recent 30 days are included
{
  const baseMs = new Date('2025-01-01').getTime();
  const entries = Array.from({ length: 46 }, (_, i) => ({
    date: new Date(baseMs + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    efValue: 0.030 + i * 0.0001,
  }));
  const lastDate = entries[45].date; // 2025-02-15
  const result = computeRollingEFAvg(entries, 30, lastDate);

  // Window: [lastDate - 29 days, lastDate] inclusive
  const refMs = new Date(lastDate).getTime();
  const win30Start = new Date(refMs - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const inWindow = entries.filter(e => e.date >= win30Start && e.date <= lastDate);
  const expectedAvg = inWindow.reduce((a, e) => a + e.efValue, 0) / inWindow.length;

  assert(result !== null, '30-day window: result is not null');
  assert(
    result !== null && near(result, expectedAvg, 1e-9),
    `30-day window: result ${result?.toFixed(8)} matches expected ${expectedAvg.toFixed(8)}`,
  );

  // Confirm not all 46 entries are used
  assert(inWindow.length === 30, `30-day window: 30 entries in window (got ${inWindow.length})`);
}

// Empty window: no entries within window → null
{
  const entries = [
    { date: '2024-01-01', efValue: 0.031 },
    { date: '2024-01-15', efValue: 0.032 },
  ];
  const result = computeRollingEFAvg(entries, 30, '2025-01-01');
  assert(result === null, `Empty window: returns null (got ${result})`);
}

// All entries on same day: returns mean of those entries
{
  const entries = [
    { date: '2025-03-01', efValue: 0.030 },
    { date: '2025-03-01', efValue: 0.034 },
    { date: '2025-03-01', efValue: 0.032 },
  ];
  const result = computeRollingEFAvg(entries, 30, '2025-03-01');
  const expectedMean = (0.030 + 0.034 + 0.032) / 3;
  assert(
    result !== null && near(result, expectedMean, 1e-9),
    `Same-day entries: mean ${result?.toFixed(6)} = ${expectedMean.toFixed(6)}`,
  );
}

// ── computeEFRegression ───────────────────────────────────────────────────────

console.log();
console.log('computeEFRegression tests');

// Fewer than 3 points → null
assert(computeEFRegression([]) === null, 'Empty entries → null');
assert(
  computeEFRegression([{ date: '2025-01-01', efValue: 0.03 }]) === null,
  '1 entry → null',
);
assert(
  computeEFRegression([
    { date: '2025-01-01', efValue: 0.03 },
    { date: '2025-01-05', efValue: 0.031 },
  ]) === null,
  '2 entries → null',
);

// Perfect linear trend: slope matches expected, rSquared = 1.0
{
  // EF increases by 0.001 per day for 5 days
  const entries = [
    { date: '2025-01-01', efValue: 0.030 },
    { date: '2025-01-02', efValue: 0.031 },
    { date: '2025-01-03', efValue: 0.032 },
    { date: '2025-01-04', efValue: 0.033 },
    { date: '2025-01-05', efValue: 0.034 },
  ];
  const result = computeEFRegression(entries);
  assert(result !== null, 'Perfect linear: result not null');
  assert(
    result !== null && near(result.slope, 0.001, 1e-9),
    `Perfect linear: slope = ${result?.slope} ≈ 0.001`,
  );
  assert(
    result !== null && near(result.rSquared, 1.0, 1e-9),
    `Perfect linear: rSquared = ${result?.rSquared} ≈ 1.0`,
  );
}

// Flat trend (all same EF value) → slope = 0, rSquared = 1.0
{
  const entries = [
    { date: '2025-01-01', efValue: 0.032 },
    { date: '2025-01-05', efValue: 0.032 },
    { date: '2025-01-10', efValue: 0.032 },
    { date: '2025-01-15', efValue: 0.032 },
  ];
  const result = computeEFRegression(entries);
  assert(result !== null, 'Flat trend: result not null');
  assert(
    result !== null && near(result.slope, 0, 1e-9),
    `Flat trend: slope = ${result?.slope} ≈ 0`,
  );
  assert(
    result !== null && near(result.rSquared, 1.0, 1e-9),
    `Flat trend: rSquared = ${result?.rSquared} = 1.0`,
  );
}

// All entries have same date → null (zero variance in x)
{
  const entries = [
    { date: '2025-01-01', efValue: 0.030 },
    { date: '2025-01-01', efValue: 0.031 },
    { date: '2025-01-01', efValue: 0.032 },
  ];
  const result = computeEFRegression(entries);
  assert(result === null, `All same date → null (got ${JSON.stringify(result)})`);
}

// ── detectEFAlert ─────────────────────────────────────────────────────────────

console.log();
console.log('detectEFAlert tests');

// 5% improvement → true
{
  const avg90d = 0.030;
  const avg30d = avg90d * 1.05;
  const result = detectEFAlert(avg30d, avg90d);
  assert(result === true, `5% improvement: detectEFAlert(${avg30d.toFixed(5)}, ${avg90d}) = true`);
}

// 4.9% improvement → false
{
  const avg90d = 0.030;
  const avg30d = avg90d * 1.049;
  const result = detectEFAlert(avg30d, avg90d);
  assert(result === false, `4.9% improvement: detectEFAlert(${avg30d.toFixed(6)}, ${avg90d}) = false`);
}

// 5% decline → true
{
  const avg90d = 0.030;
  const avg30d = avg90d * 0.95;
  const result = detectEFAlert(avg30d, avg90d);
  assert(result === true, `5% decline: detectEFAlert(${avg30d.toFixed(5)}, ${avg90d}) = true`);
}

// No change → false
{
  const avg90d = 0.030;
  const result = detectEFAlert(avg90d, avg90d);
  assert(result === false, `No change: detectEFAlert(${avg90d}, ${avg90d}) = false`);
}

// avg90d = 0 → false
assert(detectEFAlert(0.030, 0) === false, 'avg90d = 0 → false');

// Non-finite inputs → false
assert(detectEFAlert(Infinity, 0.030) === false, 'Infinity avg30d → false');
assert(detectEFAlert(0.030, Infinity) === false, 'Infinity avg90d → false');
assert(detectEFAlert(NaN, 0.030) === false, 'NaN avg30d → false');

// Custom threshold
{
  const avg90d = 0.030;
  // 3% improvement with threshold=0.02 → true
  const avg30d = avg90d * 1.03;
  assert(detectEFAlert(avg30d, avg90d, 0.02) === true, `3% with threshold=0.02 → true`);
  // 3% improvement with threshold=0.05 → false
  assert(detectEFAlert(avg30d, avg90d, 0.05) === false, `3% with threshold=0.05 → false`);
}

// ── normalizeTempEF (stub) ────────────────────────────────────────────────────

console.log();
console.log('normalizeTempEF (stub) tests');

// Any numeric inputs → returns ef unchanged
{
  const ef = 0.03142;
  assert(normalizeTempEF(ef, 25, 15) === ef, `normalizeTempEF(${ef}, 25, 15) = ${ef} (pass-through)`);
  assert(normalizeTempEF(ef, 0, 15) === ef, `normalizeTempEF(${ef}, 0, 15) = ${ef} (pass-through)`);
  assert(normalizeTempEF(ef, 35, 20) === ef, `normalizeTempEF(${ef}, 35, 20) = ${ef} (pass-through)`);
}

// Changing tempC and refTempC does not alter return value
{
  const ef = 0.02900;
  const r1 = normalizeTempEF(ef, 10, 15);
  const r2 = normalizeTempEF(ef, 30, 15);
  const r3 = normalizeTempEF(ef, 10, 25);
  assert(r1 === ef && r2 === ef && r3 === ef, 'Changing tempC/refTempC does not change return value');
}

// ── Regression Fixture ────────────────────────────────────────────────────────

console.log();
console.log('Regression fixture tests (20 qualifying run entries, 90-day span)');

// 20 qualifying runs spread across 90 days with a gentle linear EF upward trend.
// EF = 0.0300 + dayOffset * 0.00005 (exact linear formula, so rSquared = 1.0).
// Day offsets: i * 4.5 rounded to nearest integer for i in [0..19].
const FIXTURE_ENTRIES: Array<{ date: string; efValue: number }> = [
  { date: '2025-10-01', efValue: 0.03000 },
  { date: '2025-10-06', efValue: 0.03025 },
  { date: '2025-10-10', efValue: 0.03045 },
  { date: '2025-10-15', efValue: 0.03070 },
  { date: '2025-10-19', efValue: 0.03090 },
  { date: '2025-10-24', efValue: 0.03115 },
  { date: '2025-10-28', efValue: 0.03135 },
  { date: '2025-11-02', efValue: 0.03160 },
  { date: '2025-11-06', efValue: 0.03180 },
  { date: '2025-11-11', efValue: 0.03205 },
  { date: '2025-11-15', efValue: 0.03225 },
  { date: '2025-11-20', efValue: 0.03250 },
  { date: '2025-11-24', efValue: 0.03270 },
  { date: '2025-11-29', efValue: 0.03295 },
  { date: '2025-12-03', efValue: 0.03315 },
  { date: '2025-12-08', efValue: 0.03340 },
  { date: '2025-12-12', efValue: 0.03360 },
  { date: '2025-12-17', efValue: 0.03385 },
  { date: '2025-12-21', efValue: 0.03405 },
  { date: '2025-12-26', efValue: 0.03430 },
];

const FIXTURE_LAST_DATE = '2025-12-26';

// Hand-calculated 30-day average:
// Window: [2025-11-27, 2025-12-26], entries: Nov 29, Dec 3, 8, 12, 17, 21, 26 = 7 entries
// Values: 0.03295, 0.03315, 0.03340, 0.03360, 0.03385, 0.03405, 0.03430
// Sum: 0.23530, Mean: 0.23530/7 = 0.033614285714285715
const FIXTURE_EXPECTED_30D = 0.23530 / 7;

// Hand-calculated 90-day average: all 20 entries
// Sum = 0.03*20 + 0.00005*(0+5+9+14+18+23+27+32+36+41+45+50+54+59+63+68+72+77+81+86)
// day offsets sum = 860, * 0.00005 = 0.043
// sum = 0.60 + 0.043 = 0.643
// mean = 0.643/20 = 0.03215
const FIXTURE_EXPECTED_90D = 0.643 / 20;

// Expected regression slope = 0.00005 (exact linear trend per day)
// Expected rSquared = 1.0 (perfect linear fit)
const FIXTURE_EXPECTED_SLOPE = 0.00005;
const FIXTURE_EXPECTED_R2 = 1.0;

{
  const avg30 = computeRollingEFAvg(FIXTURE_ENTRIES, 30, FIXTURE_LAST_DATE);
  assert(
    avg30 !== null && near(avg30, FIXTURE_EXPECTED_30D, 1e-7),
    `Fixture 30d avg = ${avg30?.toFixed(8)}, expected ${FIXTURE_EXPECTED_30D.toFixed(8)}`,
  );
}

{
  const avg90 = computeRollingEFAvg(FIXTURE_ENTRIES, 90, FIXTURE_LAST_DATE);
  assert(
    avg90 !== null && near(avg90, FIXTURE_EXPECTED_90D, 1e-7),
    `Fixture 90d avg = ${avg90?.toFixed(8)}, expected ${FIXTURE_EXPECTED_90D.toFixed(8)}`,
  );
}

{
  const reg = computeEFRegression(FIXTURE_ENTRIES);
  assert(reg !== null, 'Fixture regression: result not null');
  assert(
    reg !== null && near(reg.slope, FIXTURE_EXPECTED_SLOPE, 1e-9),
    `Fixture regression slope = ${reg?.slope}, expected ${FIXTURE_EXPECTED_SLOPE}`,
  );
  assert(
    reg !== null && near(reg.rSquared, FIXTURE_EXPECTED_R2, 1e-6),
    `Fixture regression rSquared = ${reg?.rSquared}, expected ${FIXTURE_EXPECTED_R2}`,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log();
if (process.exitCode === 1) {
  console.log('RESULT: Some ef tests failed');
} else {
  console.log('RESULT: All ef tests passed');
}
