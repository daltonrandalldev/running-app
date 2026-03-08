/**
 * DEC-001 Decoupling Library — Unit Tests
 *
 * Run with:
 *   node --experimental-strip-types __tests__/decoupling.test.ts
 */

import {
  classifyEffortTier,
  computeDecoupling,
  computeBaseline,
  computeRollingTrend,
  type LapRecord,
  type ActivityMetadata,
  type DecouplingInput,
  type EffortTier,
} from '../lib/decoupling.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

function near(a: number, b: number, tol = 0.5): boolean {
  return Math.abs(a - b) <= tol;
}

function makeLap(
  lap: number,
  movingTime: number | null,
  distance: number | null,
  avgHr: number | null,
  elapsedTime?: number | null,
  ascent?: number | null,
  descent?: number | null,
): LapRecord {
  return {
    lap,
    moving_time_seconds: movingTime,
    elapsed_time_seconds: elapsedTime ?? movingTime,
    distance: distance,
    avg_hr: avgHr,
    ascent: ascent ?? 0,
    descent: descent ?? 0,
  };
}

function makeActivity(overrides: Partial<ActivityMetadata> = {}): ActivityMetadata {
  return {
    activity_id: 'test-1',
    date: '2024-06-15',
    avg_hr: 150,
    moving_time_seconds: 3600,
    distance: 10000,
    ascent: 50,
    is_race: false,
    avg_pace_seconds: 360,
    ...overrides,
  };
}

function makeInput(
  laps: LapRecord[],
  activityOverrides: Partial<ActivityMetadata> = {},
  effortTier: EffortTier = 'easy',
): DecouplingInput {
  return {
    activity: makeActivity(activityOverrides),
    laps,
    effort_tier: effortTier,
  };
}

// ── classifyEffortTier tests ─────────────────────────────────────────────────

console.log('classifyEffortTier tests');

assert(
  classifyEffortTier(130, { hrz_3_min: 145, hrz_4_min: 165 }) === 'easy',
  'Easy: avgHR=130, hrz_3_min=145 -> easy',
);

assert(
  classifyEffortTier(155, { hrz_3_min: 145, hrz_4_min: 165 }) === 'moderate',
  'Moderate: avgHR=155, hrz_3_min=145, hrz_4_min=165 -> moderate',
);

assert(
  classifyEffortTier(170, { hrz_3_min: 145, hrz_4_min: 165 }) === 'hard',
  'Hard: avgHR=170, hrz_4_min=165 -> hard',
);

assert(
  classifyEffortTier(145, { hrz_3_min: 145, hrz_4_min: 165 }) === 'moderate',
  'Boundary hrz_3_min: avgHR=145 exactly -> moderate',
);

assert(
  classifyEffortTier(165, { hrz_3_min: 145, hrz_4_min: 165 }) === 'hard',
  'Boundary hrz_4_min: avgHR=165 exactly -> hard',
);

// ── computeDecoupling tests ──────────────────────────────────────────────────

console.log();
console.log('computeDecoupling tests');

// Basic 10-lap easy run with drift (speed decreasing, HR increasing)
{
  // 3 warmup laps (270s each = 810s), then 10 steady laps
  const laps: LapRecord[] = [];
  // Warmup laps
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  // 10 real laps: speed decreases (time increases), HR increases
  for (let i = 4; i <= 13; i++) {
    const idx = i - 4;
    const movingTime = 280 + idx * 5; // 280s to 325s
    const hr = 145 + idx * 2;         // 145 to 163
    laps.push(makeLap(i, movingTime, 1000, hr));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(!result.skipped, 'Basic drift: not skipped');
  assert(
    result.decoupling_pct !== null && result.decoupling_pct > 0,
    `Basic drift: decoupling_pct > 0 (got ${result.decoupling_pct})`,
  );
}

// No drift (constant speed/HR ratio)
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  for (let i = 4; i <= 13; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(!result.skipped, 'No drift: not skipped');
  assert(
    result.decoupling_pct !== null && near(result.decoupling_pct, 0, 0.1),
    `No drift: decoupling_pct ~= 0 (got ${result.decoupling_pct})`,
  );
}

// Negative drift (negative split — faster second half)
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  for (let i = 4; i <= 13; i++) {
    const idx = i - 4;
    const movingTime = 320 - idx * 5; // 320s to 275s (getting faster)
    const hr = 155 - idx * 1;         // 155 to 146 (HR dropping)
    laps.push(makeLap(i, movingTime, 1000, hr));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(!result.skipped, 'Negative drift: not skipped');
  assert(
    result.decoupling_pct !== null && result.decoupling_pct < 0,
    `Negative drift: decoupling_pct < 0 (got ${result.decoupling_pct})`,
  );
}

// Warmup exclusion: first 3 laps totaling 810s
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  for (let i = 4; i <= 13; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(
    result.laps_excluded_warmup === 3,
    `Warmup exclusion: laps_excluded_warmup = 3 (got ${result.laps_excluded_warmup})`,
  );
}

// Straddling warmup lap — excluded entirely
{
  // Laps: 500s, 200s (cumulative 700s at end of lap 2, which is > 600 but
  // lap 2 starts at 500 which is < 600, so it straddles and gets excluded)
  const laps: LapRecord[] = [
    makeLap(1, 500, 1000, 130),
    makeLap(2, 200, 1000, 130), // straddles 600s mark
    ...Array.from({ length: 10 }, (_, i) => makeLap(i + 3, 300, 1000, 150)),
  ];
  const result = computeDecoupling(makeInput(laps));
  assert(
    result.laps_excluded_warmup === 2,
    `Straddling warmup: laps_excluded_warmup = 2 (got ${result.laps_excluded_warmup})`,
  );
}

// Paused lap exclusion (moving_time = 0)
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  laps.push(makeLap(4, 0, 0, 150)); // paused lap
  for (let i = 5; i <= 14; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(!result.skipped, 'Paused lap (moving_time=0): not skipped');
  // The paused lap should be silently excluded, not counted in warmup or HR exclusions
  assert(
    result.laps_excluded_warmup === 3,
    `Paused lap: warmup still 3 (got ${result.laps_excluded_warmup})`,
  );
}

// Paused lap 50% rule
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  // This lap has moving_time < 50% of elapsed_time
  laps.push(makeLap(4, 100, 1000, 150, 250));
  for (let i = 5; i <= 14; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(!result.skipped, 'Paused lap 50% rule: not skipped');
}

// HR coverage below 75% (7 of 10 null HR)
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  // 10 post-warmup laps, 7 with null HR
  for (let i = 4; i <= 6; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  for (let i = 7; i <= 13; i++) {
    laps.push(makeLap(i, 300, 1000, null));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(
    result.hr_data_insufficient === true,
    'HR below 75%: hr_data_insufficient = true',
  );
  assert(result.skipped === true, 'HR below 75%: skipped = true');
  assert(
    result.skip_reason === 'hr_coverage_below_75pct',
    `HR below 75%: skip_reason correct (got ${result.skip_reason})`,
  );
}

// HR coverage exactly 75% -> not insufficient
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  // 8 post-warmup laps, exactly 6 with valid HR (75%)
  for (let i = 4; i <= 9; i++) {
    laps.push(makeLap(i, 350, 1000, 150)); // 6 valid HR laps (6/8 = 75%)
  }
  for (let i = 10; i <= 11; i++) {
    laps.push(makeLap(i, 350, 1000, null)); // 2 null HR laps
  }
  const result = computeDecoupling(makeInput(laps));
  assert(
    result.hr_data_insufficient === false,
    `HR exactly 75%: hr_data_insufficient = false (skipped=${result.skipped}, reason=${result.skip_reason})`,
  );
}

// Min duration check (25 min)
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  // Post-warmup laps totaling 25 min = 1500s (5 laps of 300s each)
  for (let i = 4; i <= 8; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(result.skipped === true, 'Min duration: skipped = true');
  assert(
    result.skip_reason === 'qualifying_duration_below_30min',
    `Min duration: skip_reason correct (got ${result.skip_reason})`,
  );
}

// Quartile for race
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  // 12 post-warmup laps of 300s each (3600s total = 60 min)
  for (let i = 4; i <= 15; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps, { is_race: true }));
  assert(!result.skipped, 'Quartile race: not skipped');
  assert(result.ef_q1 !== null, 'Quartile race: ef_q1 non-null');
  assert(result.ef_q2 !== null, 'Quartile race: ef_q2 non-null');
  assert(result.ef_q3 !== null, 'Quartile race: ef_q3 non-null');
  assert(result.ef_q4 !== null, 'Quartile race: ef_q4 non-null');
}

// Quartile for >2h
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  // 25 post-warmup laps of 300s each (7500s > 7200s)
  for (let i = 4; i <= 28; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps, { is_race: false }));
  assert(!result.skipped, 'Quartile >2h: not skipped');
  assert(result.ef_q1 !== null, 'Quartile >2h: ef_q1 non-null');
  assert(result.ef_q4 !== null, 'Quartile >2h: ef_q4 non-null');
}

// Quartile skipped for 60min non-race
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  // 12 laps of 300s (3600s = 60 min, < 7200)
  for (let i = 4; i <= 15; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps, { is_race: false }));
  assert(!result.skipped, 'Quartile 60min non-race: not skipped');
  assert(result.ef_q1 === null, 'Quartile 60min non-race: ef_q1 null');
  assert(result.ef_q2 === null, 'Quartile 60min non-race: ef_q2 null');
  assert(result.ef_q3 === null, 'Quartile 60min non-race: ef_q3 null');
  assert(result.ef_q4 === null, 'Quartile 60min non-race: ef_q4 null');
}

// No laps
{
  const result = computeDecoupling(makeInput([]));
  assert(result.skipped === true, 'No laps: skipped = true');
  assert(
    result.skip_reason === 'no_laps',
    `No laps: skip_reason = no_laps (got ${result.skip_reason})`,
  );
}

// Single qualifying lap
{
  const laps: LapRecord[] = [
    makeLap(1, 700, 1000, 130), // warmup (700s > 600s but starts at 0 < 600, so it straddles = excluded)
    makeLap(2, 2000, 5000, 150), // single qualifying lap
  ];
  const result = computeDecoupling(makeInput(laps));
  assert(result.skipped === true, 'Single lap: skipped = true');
  assert(
    result.skip_reason === 'insufficient_laps_for_split',
    `Single lap: skip_reason correct (got ${result.skip_reason})`,
  );
}

// All laps warmup
{
  const laps: LapRecord[] = [
    makeLap(1, 200, 1000, 130),
    makeLap(2, 200, 1000, 130),
    makeLap(3, 150, 1000, 130),
  ]; // total = 550s < 600s
  const result = computeDecoupling(makeInput(laps));
  assert(result.skipped === true, 'All warmup: skipped = true');
  assert(
    result.skip_reason === 'all_laps_warmup',
    `All warmup: skip_reason correct (got ${result.skip_reason})`,
  );
}

// Zero distance lap -> excluded, computation continues
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130)); // warmup
  }
  laps.push(makeLap(4, 300, 0, 150)); // zero distance -> excluded as paused
  for (let i = 5; i <= 14; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps));
  assert(!result.skipped, 'Zero distance lap: not skipped, computation continues');
}

// awaiting_gap = true when ascent = 150
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  for (let i = 4; i <= 13; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps, { ascent: 150 }));
  assert(
    result.awaiting_gap === true,
    'awaiting_gap = true when ascent = 150',
  );
}

// awaiting_gap = false when ascent = 50
{
  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  for (let i = 4; i <= 13; i++) {
    laps.push(makeLap(i, 300, 1000, 150));
  }
  const result = computeDecoupling(makeInput(laps, { ascent: 50 }));
  assert(
    result.awaiting_gap === false,
    'awaiting_gap = false when ascent = 50',
  );
}

// ── computeBaseline tests ────────────────────────────────────────────────────

console.log();
console.log('computeBaseline tests');

// 25 values -> is_established = true
{
  const values = Array.from({ length: 25 }, (_, i) => 3.0 + i * 0.2); // 3.0 to 7.8
  const result = computeBaseline(values);
  assert(result.is_established === true, '25 values: is_established = true');
  assert(result.n_qualifying_runs === 25, '25 values: n_qualifying_runs = 25');
  const expectedMean = values.reduce((a, b) => a + b, 0) / 25;
  assert(
    near(result.mean_decoupling_pct, expectedMean, 0.01),
    `25 values: mean correct (got ${result.mean_decoupling_pct})`,
  );
  // Verify bounds = mean +/- 2*stdev
  assert(
    near(
      result.upper_bound - result.lower_bound,
      4 * result.stdev_decoupling_pct,
      0.02,
    ),
    '25 values: bounds span = 4 * stdev',
  );
}

// 15 values -> is_established = false
{
  const values = Array.from({ length: 15 }, (_, i) => 4.0 + i * 0.3);
  const result = computeBaseline(values);
  assert(result.is_established === false, '15 values: is_established = false');
  assert(result.n_qualifying_runs === 15, '15 values: n = 15');
}

// Exactly 20 values -> is_established = true
{
  const values = Array.from({ length: 20 }, (_, i) => 5.0 + i * 0.1);
  const result = computeBaseline(values);
  assert(result.is_established === true, '20 values: is_established = true');
}

// Single value [5.0] -> stdev = 0, bounds = mean
{
  const result = computeBaseline([5.0]);
  assert(result.stdev_decoupling_pct === 0, '[5.0]: stdev = 0');
  assert(
    result.lower_bound === result.mean_decoupling_pct,
    '[5.0]: lower_bound = mean',
  );
  assert(
    result.upper_bound === result.mean_decoupling_pct,
    '[5.0]: upper_bound = mean',
  );
}

// Empty -> n=0, is_established = false
{
  const result = computeBaseline([]);
  assert(result.n_qualifying_runs === 0, 'empty: n = 0');
  assert(result.is_established === false, 'empty: is_established = false');
  assert(result.mean_decoupling_pct === 0, 'empty: mean = 0');
  assert(result.stdev_decoupling_pct === 0, 'empty: stdev = 0');
  assert(result.lower_bound === 0, 'empty: lower_bound = 0');
  assert(result.upper_bound === 0, 'empty: upper_bound = 0');
}

// ── computeRollingTrend tests ────────────────────────────────────────────────

console.log();
console.log('computeRollingTrend tests');

// Helper: date string N days before today
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// 10 entries over 60 days
{
  const entries = Array.from({ length: 10 }, (_, i) => ({
    date: daysAgo(60 - i * 6), // every 6 days over 60 days
    decoupling_pct: 3.0 + i * 0.5,
  }));
  const result = computeRollingTrend(entries);
  assert(result.length > 0, '10 entries over 60 days: non-empty result');
  assert(
    result.every((e) => e.n_activities > 0),
    '10 entries: all entries have n_activities > 0',
  );
}

// 3 entries over 90 days
{
  const entries = [
    { date: daysAgo(80), decoupling_pct: 4.0 },
    { date: daysAgo(40), decoupling_pct: 3.5 },
    { date: daysAgo(5), decoupling_pct: 2.8 },
  ];
  const result = computeRollingTrend(entries);
  assert(result.length === 3, `3 entries: 3 trend entries (got ${result.length})`);
}

// Empty -> returns []
{
  const result = computeRollingTrend([]);
  assert(result.length === 0, 'empty: returns []');
}

// Entry 31 days before another -> outside 30-day window
{
  const baseDate = daysAgo(10);
  const oldDate = daysAgo(41); // 31 days before baseDate
  const entries = [
    { date: oldDate, decoupling_pct: 5.0 },
    { date: baseDate, decoupling_pct: 3.0 },
  ];
  const result = computeRollingTrend(entries);
  // The baseDate entry's 30-day window should NOT include oldDate
  const baseTrend = result.find((e) => e.date === baseDate);
  assert(
    baseTrend !== undefined && baseTrend.n_activities === 1,
    `31 days apart: baseDate window has 1 entry (got ${baseTrend?.n_activities})`,
  );
}

// ── Regression Fixture ───────────────────────────────────────────────────────

console.log();
console.log('Regression fixture test');

{
  // 20 laps, each 1 km
  // Laps 1-3: 270s each (total 810s -> all 3 excluded as warmup)
  // Laps 4-20: moving_time increases linearly from 280s to 310s (17 laps)
  //            HR increases linearly from 145 to 165 bpm

  const laps: LapRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    laps.push(makeLap(i, 270, 1000, 130));
  }
  for (let i = 4; i <= 20; i++) {
    const idx = i - 4; // 0 to 16
    const movingTime = 280 + (idx / 16) * 30; // 280 to 310
    const hr = 145 + (idx / 16) * 20;          // 145 to 165
    laps.push(makeLap(i, movingTime, 1000, hr));
  }

  const result = computeDecoupling(makeInput(laps));

  assert(result.laps_excluded_warmup === 3, 'Regression: 3 warmup laps excluded');
  assert(!result.skipped, 'Regression: not skipped');

  // Pre-compute expected decoupling:
  // Qualified laps 4-20 (17 laps), each 1km
  // Speed = 1000 / moving_time for each lap
  // Half-split by time
  const qualifiedLaps: Array<{ mt: number; speed: number; hr: number }> = [];
  for (let i = 0; i < 17; i++) {
    const mt = 280 + (i / 16) * 30;
    const hr = 145 + (i / 16) * 20;
    const speed = 1000 / mt;
    qualifiedLaps.push({ mt, speed, hr });
  }
  const totalTime = qualifiedLaps.reduce((a, l) => a + l.mt, 0);
  const halfTime = totalTime / 2;

  // Find straddle
  let cumulative = 0;
  let splitIdx = 0;
  let straddleFracH1 = 1.0;
  for (let i = 0; i < qualifiedLaps.length; i++) {
    const prev = cumulative;
    cumulative += qualifiedLaps[i].mt;
    if (prev < halfTime && cumulative >= halfTime) {
      straddleFracH1 = (halfTime - prev) / qualifiedLaps[i].mt;
      splitIdx = i;
      break;
    }
  }

  const h1Laps = qualifiedLaps.slice(0, splitIdx);
  const h2Laps = qualifiedLaps.slice(splitIdx + 1);
  const straddle = qualifiedLaps[splitIdx];

  function twMean(
    full: typeof qualifiedLaps,
    s: typeof straddle | null,
    frac: number,
  ) {
    const sTime = s ? s.mt * frac : 0;
    const tw = full.reduce((a, l) => a + l.mt, 0) + sTime;
    const ws =
      full.reduce((a, l) => a + l.speed * l.mt, 0) +
      (s ? s.speed * sTime : 0);
    const wh =
      full.reduce((a, l) => a + l.hr * l.mt, 0) +
      (s ? s.hr * sTime : 0);
    return { speed: ws / tw, hr: wh / tw };
  }

  const h1 = twMean(h1Laps, straddle, straddleFracH1);
  const h2 = twMean(h2Laps, straddle, 1 - straddleFracH1);
  const efH1 = h1.speed / h1.hr;
  const efH2 = h2.speed / h2.hr;
  const expectedDec = ((efH1 - efH2) / efH1) * 100;

  assert(
    result.decoupling_pct !== null &&
      near(result.decoupling_pct, expectedDec, 0.5),
    `Regression: decoupling_pct = ${result.decoupling_pct}, expected ~${Math.round(expectedDec * 100) / 100} (within +/-0.5)`,
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log();
if (process.exitCode === 1) {
  console.log('RESULT: Some tests failed');
} else {
  console.log('RESULT: All tests passed');
}
