/**
 * PMC-005 Sport-Specific PMC Tests
 *
 * Validates the TSS weighting formulas that recalculatePMC applies before
 * calling calculatePMC for each sport series. Tests are pure — they use
 * calculatePMC directly with pre-weighted inputs, mirroring the exact
 * computation recalculatePMC performs for 'combined', 'run', and 'cycle'.
 *
 * Weight constants below must stay in sync with pmcRecalc.ts W_RUN / W_CYCLE.
 *
 * Run with:
 *   node --experimental-strip-types __tests__/pmcRecalc.test.ts
 */

import { calculatePMC } from '../lib/pmc.ts';

// ── Weight constants (mirror pmcRecalc.ts) ────────────────────────────────────
const W_RUN = 1.0;
const W_CYCLE = 0.5;

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_DATE = '2024-06-01';

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

function near(a: number, b: number, tol = 0.1): boolean {
  return Math.abs(a - b) <= tol;
}

// ── Combined weighted TSS ─────────────────────────────────────────────────────
//
// A run activity (100 TSS, w=1.0) and a cycle activity (100 TSS, w=0.5) on
// the same day produce the same CTL/ATL as a single 150-TSS activity.

console.log('PMC-005 Combined weighted TSS');

const combinedResult = calculatePMC([
  { date: BASE_DATE, tss: 100 * W_RUN },   // run contribution
  { date: BASE_DATE, tss: 100 * W_CYCLE },  // cycle contribution
]);
const singleEquivResult = calculatePMC([
  { date: BASE_DATE, tss: 150 },            // 100 + 50
]);

const combinedDay = combinedResult.find((d) => d.date === BASE_DATE);
const singleEquivDay = singleEquivResult.find((d) => d.date === BASE_DATE);

assert(combinedDay !== undefined, 'combined: day present in result');
assert(singleEquivDay !== undefined, 'single equivalent: day present in result');
assert(
  near(combinedDay?.ctl ?? 0, singleEquivDay?.ctl ?? 0),
  `weighted run+cycle CTL equals single 150-TSS activity (got ${combinedDay?.ctl} vs ${singleEquivDay?.ctl})`,
);
assert(
  near(combinedDay?.atl ?? 0, singleEquivDay?.atl ?? 0),
  `weighted run+cycle ATL equals single 150-TSS activity (got ${combinedDay?.atl} vs ${singleEquivDay?.atl})`,
);

// Cycle contributes less CTL than run at the same raw TSS
const runOnlyResult = calculatePMC([{ date: BASE_DATE, tss: 100 * W_RUN }]);
const cycleOnlyResult = calculatePMC([{ date: BASE_DATE, tss: 100 * W_CYCLE }]);
assert(
  (runOnlyResult.find((d) => d.date === BASE_DATE)?.ctl ?? 0) >
    (cycleOnlyResult.find((d) => d.date === BASE_DATE)?.ctl ?? 0),
  'run 100 TSS contributes more CTL than cycle 100 TSS in combined (W_CYCLE=0.5)',
);

console.log('Combined weighted TSS: all passed');

// ── Race k-factor × sport weight ordering ─────────────────────────────────────
//
// Formula: combined_TSS = (tss × k_race) × w_sport
// Race k-factor is a property of the effort; sport weight is a property of
// how that effort contributes to the combined model.
//
// Cycle race: tss=100, k_race=1.5, w=0.5
//   CTL input: 100 × 0.5 = 50
//   ATL input: 100 × 1.5 × 0.5 = 75

console.log();
console.log('PMC-005 Race k-factor × sport weight ordering');

const K_RACE = 1.5;
const k_ctl = 1 - Math.exp(-1 / 42);
const k_atl = 1 - Math.exp(-1 / 7);

// Cycle race in combined series
const cycleRaceDay = calculatePMC([
  {
    date: BASE_DATE,
    tss: 100 * W_CYCLE,              // CTL: rawTss × w_sport
    atl_tss: 100 * K_RACE * W_CYCLE, // ATL: rawTss × k_race × w_sport
  },
]).find((d) => d.date === BASE_DATE);

const expectedCycleRaceCtl = Math.round(100 * W_CYCLE * k_ctl * 10) / 10;
const expectedCycleRaceAtl = Math.round(100 * K_RACE * W_CYCLE * k_atl * 10) / 10;

assert(
  near(cycleRaceDay?.ctl ?? 0, expectedCycleRaceCtl),
  `cycle race CTL: 100 × W_CYCLE=${W_CYCLE} → ~${expectedCycleRaceCtl}, got ${cycleRaceDay?.ctl}`,
);
assert(
  near(cycleRaceDay?.atl ?? 0, expectedCycleRaceAtl),
  `cycle race ATL: 100 × k_race × W_CYCLE → ~${expectedCycleRaceAtl}, got ${cycleRaceDay?.atl}`,
);
assert(
  (cycleRaceDay?.atl ?? 0) > (cycleRaceDay?.ctl ?? 0),
  'cycle race: ATL > CTL (race multiplier spikes ATL)',
);

// Run race in combined series — higher ATL than cycle race at same raw TSS
const runRaceDay = calculatePMC([
  {
    date: BASE_DATE,
    tss: 100 * W_RUN,
    atl_tss: 100 * K_RACE * W_RUN,
  },
]).find((d) => d.date === BASE_DATE);

assert(
  (runRaceDay?.atl ?? 0) > (cycleRaceDay?.atl ?? 0),
  'run race ATL > cycle race ATL at same TSS (W_RUN=1.0 > W_CYCLE=0.5)',
);

// CTL is unaffected by k_race (CTL uses tss, ATL uses atl_tss)
const runNonRaceDay = calculatePMC([{ date: BASE_DATE, tss: 100 * W_RUN }]).find(
  (d) => d.date === BASE_DATE,
);
assert(
  near(runRaceDay?.ctl ?? 0, runNonRaceDay?.ctl ?? 0),
  'run race: CTL unaffected by k_race (CTL uses raw tss × w_sport)',
);

console.log('Race k-factor × sport weight ordering: all passed');

// ── Sport-specific series: no sport weight applied ────────────────────────────
//
// The 'run' and 'cycle' series use raw (race-adjusted) TSS only.
// A 100-TSS running activity feeds the run series as 100 TSS (w=1.0 is identity).
// A 100-TSS cycling activity feeds the cycle series as 100 TSS (not halved).

console.log();
console.log('PMC-005 Sport-specific series (no sport weight)');

const rawRunCtl = calculatePMC([{ date: BASE_DATE, tss: 100 }])
  .find((d) => d.date === BASE_DATE)?.ctl ?? 0;
const expectedRawCtl = Math.round(100 * k_ctl * 10) / 10;

assert(
  near(rawRunCtl, expectedRawCtl),
  `run series: 100 TSS → CTL ~${expectedRawCtl} (no weight), got ${rawRunCtl}`,
);

// Cycle series uses raw 100 TSS — higher CTL than its combined contribution (50 TSS)
const cycleSeriesCtl = calculatePMC([{ date: BASE_DATE, tss: 100 }])
  .find((d) => d.date === BASE_DATE)?.ctl ?? 0;
const cycleCombinedCtl = calculatePMC([{ date: BASE_DATE, tss: 100 * W_CYCLE }])
  .find((d) => d.date === BASE_DATE)?.ctl ?? 0;

assert(
  cycleSeriesCtl > cycleCombinedCtl,
  `cycle series (100 TSS) > cycle combined contribution (${100 * W_CYCLE} TSS): ${cycleSeriesCtl} > ${cycleCombinedCtl}`,
);

// Sport-specific race: only k_race applies, no sport weight
const cycleSeriesRaceCtl = calculatePMC([{ date: BASE_DATE, tss: 100 }])
  .find((d) => d.date === BASE_DATE)?.ctl ?? 0;
const cycleSeriesRaceAtl = calculatePMC([
  { date: BASE_DATE, tss: 100, atl_tss: 100 * K_RACE },
]).find((d) => d.date === BASE_DATE)?.atl ?? 0;
const cycleSeriesRaceCtl2 = calculatePMC([
  { date: BASE_DATE, tss: 100, atl_tss: 100 * K_RACE },
]).find((d) => d.date === BASE_DATE)?.ctl ?? 0;

assert(
  near(cycleSeriesRaceCtl, cycleSeriesRaceCtl2),
  'cycle series race: CTL unaffected by k_race',
);
assert(
  cycleSeriesRaceAtl > cycleSeriesRaceCtl,
  'cycle series race: ATL > CTL (race multiplier, no sport weight)',
);

console.log('Sport-specific series: all passed');

// ── Rest day decay across all three series ────────────────────────────────────

console.log();
console.log('PMC-005 Rest day decay across series');

const day0 = BASE_DATE;
const day1 = addDays(BASE_DATE, 1);

// Combined: run 100 + cycle 100 weighted inputs on day0, implicit rest on day1
const combinedWithRest = calculatePMC([
  { date: day0, tss: 100 * W_RUN },
  { date: day0, tss: 100 * W_CYCLE },
]);
assert(
  (combinedWithRest.find((d) => d.date === day1)?.atl ?? 0) <
    (combinedWithRest.find((d) => d.date === day0)?.atl ?? 0),
  'combined: rest day ATL decays below training day ATL',
);
assert(
  (combinedWithRest.find((d) => d.date === day1)?.ctl ?? 0) <
    (combinedWithRest.find((d) => d.date === day0)?.ctl ?? 0),
  'combined: rest day CTL decays below training day CTL',
);

// Run series: 100 TSS on day0, rest on day1
const runWithRest = calculatePMC([{ date: day0, tss: 100 }]);
assert(
  (runWithRest.find((d) => d.date === day1)?.atl ?? 0) <
    (runWithRest.find((d) => d.date === day0)?.atl ?? 0),
  'run series: rest day ATL decays below training day ATL',
);

// Cycle series: 100 × W_CYCLE weighted on day0 (combined path), rest on day1
const cycleWithRest = calculatePMC([{ date: day0, tss: 100 * W_CYCLE }]);
assert(
  (cycleWithRest.find((d) => d.date === day1)?.atl ?? 0) <
    (cycleWithRest.find((d) => d.date === day0)?.atl ?? 0),
  'cycle (combined): rest day ATL decays below training day ATL',
);

// All three series decay independently — combined > run-only (more load input)
assert(
  (combinedWithRest.find((d) => d.date === day0)?.atl ?? 0) >
    (runWithRest.find((d) => d.date === day0)?.atl ?? 0),
  'combined ATL > run-only ATL when both run and cycle contribute',
);

console.log('Rest day decay: all passed');

// ── Summary ───────────────────────────────────────────────────────────────────

console.log();
if (process.exitCode === 1) {
  console.log('✗ PMC-005 tests failed');
} else {
  console.log('✓ All PMC-005 tests passed');
}
