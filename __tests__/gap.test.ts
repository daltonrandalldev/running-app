/**
 * GAP-001 GAP Library — Unit Tests
 *
 * Run with:
 *   node --experimental-strip-types __tests__/gap.test.ts
 */

import {
  minettiCost,
  clampGrade,
  lapGrade,
  lapGapPace,
  computeGAP,
  type GarminLap,
} from '../lib/gap.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── minettiCost tests ─────────────────────────────────────────────────────────

console.log('minettiCost tests');

assert(
  minettiCost(0) === 3.6,
  'minettiCost(0) === 3.6 (exactly)',
);

assert(
  near(minettiCost(0.10), 5.97, 0.1),
  `minettiCost(0.10) ≈ 5.97 (got ${minettiCost(0.10).toFixed(4)})`,
);

// At grade=0.10, pace=360 sec/km should give GAP ~30-40% faster
{
  const gapPace = lapGapPace(360, 0.10);
  assert(
    gapPace < 360 * 0.70 && gapPace > 360 * 0.60,
    `grade=0.10: GAP ${gapPace} is 30-40% faster than raw 360`,
  );
}

assert(
  near(minettiCost(-0.10), 2.15, 0.1),
  `minettiCost(-0.10) ≈ 2.15 (got ${minettiCost(-0.10).toFixed(4)})`,
);

// At grade=-0.10, GAP pace should be ~30% slower than actual
{
  const gapPace = lapGapPace(360, -0.10);
  assert(
    gapPace > 360 * 1.20 && gapPace < 360 * 1.80,
    `grade=-0.10: GAP ${gapPace} is slower than raw 360`,
  );
}

assert(
  minettiCost(0.45) > 3.6,
  `minettiCost(0.45) > 3.6 (got ${minettiCost(0.45).toFixed(4)})`,
);

assert(
  minettiCost(-0.40) > 0,
  `minettiCost(-0.40) > 0 (got ${minettiCost(-0.40).toFixed(4)})`,
);

assert(
  minettiCost(0.20) > minettiCost(0.10),
  `minettiCost(0.20) > minettiCost(0.10) (${minettiCost(0.20).toFixed(4)} > ${minettiCost(0.10).toFixed(4)})`,
);

// ── clampGrade tests ──────────────────────────────────────────────────────────

console.log();
console.log('clampGrade tests');

{
  const result = clampGrade(0.10);
  assert(result.grade === 0.10 && result.clamped === false, 'clampGrade(0.10) → { grade: 0.10, clamped: false }');
}

{
  const result = clampGrade(0.45);
  assert(result.grade === 0.45 && result.clamped === false, 'clampGrade(0.45) → { grade: 0.45, clamped: false }');
}

{
  const result = clampGrade(0.60);
  assert(result.grade === 0.45 && result.clamped === true, 'clampGrade(0.60) → { grade: 0.45, clamped: true }');
}

{
  const result = clampGrade(-0.40);
  assert(result.grade === -0.40 && result.clamped === false, 'clampGrade(-0.40) → { grade: -0.40, clamped: false }');
}

{
  const result = clampGrade(-0.55);
  assert(result.grade === -0.40 && result.clamped === true, 'clampGrade(-0.55) → { grade: -0.40, clamped: true }');
}

{
  const result = clampGrade(0.0);
  assert(result.grade === 0.0 && result.clamped === false, 'clampGrade(0.0) → { grade: 0.0, clamped: false }');
}

// Additional acceptance criteria: clampGrade(0.30) → { grade: 0.30, clamped: false }
{
  const result = clampGrade(0.30);
  assert(result.grade === 0.30 && result.clamped === false, 'clampGrade(0.30) → { grade: 0.30, clamped: false }');
}

// ── lapGrade tests ────────────────────────────────────────────────────────────

console.log();
console.log('lapGrade tests');

assert(
  lapGrade(10, 10, 1) === 0.0,
  'ascent=10, descent=10, dist=1km → 0.0',
);

assert(
  lapGrade(100, 0, 1) === 0.10,
  `ascent=100, descent=0, dist=1km → 0.10 (got ${lapGrade(100, 0, 1)})`,
);

assert(
  lapGrade(0, 100, 1) === -0.10,
  `ascent=0, descent=100, dist=1km → -0.10 (got ${lapGrade(0, 100, 1)})`,
);

assert(
  lapGrade(null, 50, 1) === -0.05,
  `ascent=null, descent=50, dist=1km → -0.05 (got ${lapGrade(null, 50, 1)})`,
);

assert(
  lapGrade(50, null, 1) === 0.05,
  `ascent=50, descent=null, dist=1km → 0.05 (got ${lapGrade(50, null, 1)})`,
);

assert(
  lapGrade(null, null, 1) === 0.0,
  `ascent=null, descent=null, dist=1km → 0.0 (got ${lapGrade(null, null, 1)})`,
);

assert(
  lapGrade(50, 0, 0) === 0.0,
  'ascent=50, descent=0, dist=0km → 0.0 (guard)',
);

// ── lapGapPace tests ──────────────────────────────────────────────────────────

console.log();
console.log('lapGapPace tests');

assert(
  lapGapPace(360, 0) === 360,
  'pace=360, grade=0 → 360',
);

{
  const result = lapGapPace(360, 0.10);
  assert(
    near(result, 217, 20),
    `pace=360, grade=0.10 → ~217 sec/km (30-40% faster), got ${result}`,
  );
}

{
  const result = lapGapPace(360, -0.10);
  assert(
    near(result, 602, 20),
    `pace=360, grade=-0.10 → ~602 sec/km (slower), got ${result}`,
  );
}

assert(
  lapGapPace(360, 0.45) < 360,
  `pace=360, grade=0.45 → < 360 (got ${lapGapPace(360, 0.45)})`,
);

// ── computeGAP tests ──────────────────────────────────────────────────────────

console.log();
console.log('computeGAP tests');

// Single flat lap
{
  const laps: GarminLap[] = [
    { lap: 1, moving_time_seconds: 300, distance: 1000, ascent: 0, descent: 0 },
  ];
  const result = computeGAP(laps);
  assert(result.activityGap.gap_applied === false, 'Single flat lap: gap_applied = false');
  assert(
    result.activityGap.avg_gap_pace_seconds === result.activityGap.avg_raw_pace_seconds,
    'Single flat lap: GAP = raw pace',
  );
}

// Single uphill lap
{
  const laps: GarminLap[] = [
    { lap: 1, moving_time_seconds: 300, distance: 1000, ascent: 100, descent: 0 },
  ];
  const result = computeGAP(laps);
  assert(result.activityGap.gap_applied === true, 'Single uphill lap: gap_applied = true');
  assert(
    result.activityGap.avg_gap_pace_seconds !== null &&
    result.activityGap.avg_raw_pace_seconds !== null &&
    result.activityGap.avg_gap_pace_seconds < result.activityGap.avg_raw_pace_seconds,
    `Single uphill lap: GAP (${result.activityGap.avg_gap_pace_seconds}) < raw (${result.activityGap.avg_raw_pace_seconds})`,
  );
}

// Paused lap (moving_time=0): lap_count=0
{
  const laps: GarminLap[] = [
    { lap: 1, moving_time_seconds: 0, distance: 1000, ascent: 0, descent: 0 },
  ];
  const result = computeGAP(laps);
  assert(result.activityGap.lap_count === 0, 'Paused lap (moving_time=0): lap_count = 0');
  assert(result.activityGap.avg_gap_pace_seconds === null, 'Paused lap: avg_gap_pace_seconds = null');
}

// Zero-distance lap: lap_count=0
{
  const laps: GarminLap[] = [
    { lap: 1, moving_time_seconds: 300, distance: 0, ascent: 0, descent: 0 },
  ];
  const result = computeGAP(laps);
  assert(result.activityGap.lap_count === 0, 'Zero-distance lap: lap_count = 0');
  assert(result.activityGap.avg_gap_pace_seconds === null, 'Zero-distance lap: avg_gap_pace_seconds = null');
}

// All null elevation (5 laps): gap_applied = false
{
  const laps: GarminLap[] = Array.from({ length: 5 }, (_, i) => ({
    lap: i + 1,
    moving_time_seconds: 300,
    distance: 1000,
    ascent: null,
    descent: null,
  }));
  const result = computeGAP(laps);
  assert(result.activityGap.gap_applied === false, 'All null elevation: gap_applied = false');
}

// Grade clamping: 2 laps with grade > 0.45
{
  // grade = (200 - 0) / (1000) = 0.20 — not clamped
  // need grade > 0.45: ascent=500, distance=1000 → grade = 500/1000 = 0.50 > 0.45 ✓
  const laps: GarminLap[] = [
    { lap: 1, moving_time_seconds: 300, distance: 1000, ascent: 500, descent: 0 },
    { lap: 2, moving_time_seconds: 300, distance: 1000, ascent: 500, descent: 0 },
  ];
  const result = computeGAP(laps);
  assert(
    result.activityGap.laps_grade_clamped === 2,
    `Grade clamping: laps_grade_clamped = 2 (got ${result.activityGap.laps_grade_clamped})`,
  );
}

// Empty array
{
  const result = computeGAP([]);
  assert(result.lapGapResults.length === 0, 'Empty array: lapGapResults = []');
  assert(result.activityGap.lap_count === 0, 'Empty array: lap_count = 0');
  assert(result.activityGap.gap_applied === false, 'Empty array: gap_applied = false');
  assert(result.activityGap.avg_gap_pace_seconds === null, 'Empty array: avg_gap_pace_seconds = null');
  assert(result.activityGap.avg_raw_pace_seconds === null, 'Empty array: avg_raw_pace_seconds = null');
  assert(result.activityGap.total_ascent_m === 0, 'Empty array: total_ascent_m = 0');
  assert(result.activityGap.laps_grade_clamped === 0, 'Empty array: laps_grade_clamped = 0');
}

// ── Regression Fixture ────────────────────────────────────────────────────────

console.log();
console.log('Regression fixture test');

{
  const fixtureLaps: GarminLap[] = [
    { lap: 1,  moving_time_seconds: 240, distance: 1000, ascent: 0,  descent: 0 },
    { lap: 2,  moving_time_seconds: 260, distance: 1000, ascent: 40, descent: 0 },
    { lap: 3,  moving_time_seconds: 250, distance: 1000, ascent: 80, descent: 0 },
    { lap: 4,  moving_time_seconds: 270, distance: 1000, ascent: 0,  descent: 40 },
    { lap: 5,  moving_time_seconds: 255, distance: 1000, ascent: 60, descent: 0 },
    { lap: 6,  moving_time_seconds: 265, distance: 1000, ascent: 0,  descent: 60 },
    { lap: 7,  moving_time_seconds: 280, distance: 1000, ascent: 50, descent: 10 },
    { lap: 8,  moving_time_seconds: 245, distance: 1000, ascent: 10, descent: 50 },
    { lap: 9,  moving_time_seconds: 300, distance: 1000, ascent: 0,  descent: 0 },
    { lap: 10, moving_time_seconds: 290, distance: 1000, ascent: 30, descent: 20 },
  ];

  const result = computeGAP(fixtureLaps);

  assert(result.activityGap.lap_count === 10, `Regression: lap_count = 10 (got ${result.activityGap.lap_count})`);
  assert(result.activityGap.gap_applied === true, 'Regression: gap_applied = true');
  assert(
    result.activityGap.total_ascent_m === 270,
    `Regression: total_ascent_m = 270 (got ${result.activityGap.total_ascent_m})`,
  );

  // Compute expected avg_gap_pace_seconds by iterating over the fixture
  let expectedWeightedGapPace = 0;
  let expectedTotalDistance = 0;
  for (const lap of fixtureLaps) {
    const distanceKm = (lap.distance ?? 0) / 1000;
    const movingTime = lap.moving_time_seconds ?? 0;
    if (distanceKm <= 0 || movingTime <= 0) continue;
    const rawPace = movingTime / distanceKm;
    const rawGradeVal = lapGrade(lap.ascent, lap.descent, distanceKm);
    const { grade: clampedGradeVal } = clampGrade(rawGradeVal);
    const gapPaceVal = lapGapPace(rawPace, clampedGradeVal);
    expectedWeightedGapPace += gapPaceVal * distanceKm;
    expectedTotalDistance += distanceKm;
  }
  const expectedAvgGapPace = Math.round((expectedWeightedGapPace / expectedTotalDistance) * 100) / 100;

  assert(
    result.activityGap.avg_gap_pace_seconds !== null &&
    near(result.activityGap.avg_gap_pace_seconds, expectedAvgGapPace, 0.5),
    `Regression: avg_gap_pace_seconds = ${result.activityGap.avg_gap_pace_seconds}, expected ~${expectedAvgGapPace} (within ±0.5)`,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log();
if (process.exitCode === 1) {
  console.log('RESULT: Some gap tests failed');
} else {
  console.log('RESULT: All gap tests passed');
}
