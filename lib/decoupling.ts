/**
 * DEC-001: Core Aerobic Decoupling Calculation Library
 *
 * Pure TypeScript — zero I/O, zero external dependencies.
 * Implements Friel's Efficiency Factor (EF) method for measuring
 * heart rate drift relative to speed during steady-state exercise.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface LapRecord {
  lap: number;
  moving_time_seconds: number | null;
  elapsed_time_seconds: number | null;
  distance: number | null;
  avg_hr: number | null;
  ascent: number | null;
  descent: number | null;
}

export interface ActivityMetadata {
  activity_id: string;
  date: string;
  avg_hr: number | null;
  moving_time_seconds: number | null;
  distance: number | null;
  ascent: number | null;
  is_race: boolean;
  avg_pace_seconds: number | null;
}

export interface DecouplingInput {
  activity: ActivityMetadata;
  laps: LapRecord[];
  effort_tier: EffortTier;
}

export type EffortTier = 'easy' | 'moderate' | 'hard';

export interface HRZoneThresholds {
  hrz_3_min: number;
  hrz_4_min: number;
}

export interface DecouplingResult {
  ef_h1: number | null;
  ef_h2: number | null;
  decoupling_pct: number | null;
  ef_q1: number | null;
  ef_q2: number | null;
  ef_q3: number | null;
  ef_q4: number | null;
  decoupling_q1q4_pct: number | null;
  decoupling_q1q2_pct: number | null;
  effort_tier: EffortTier;
  gap_used: boolean;
  awaiting_gap: boolean;
  hr_data_insufficient: boolean;
  laps_excluded_warmup: number;
  laps_excluded_hr: number;
  qualifying_duration_s: number;
  skipped: boolean;
  skip_reason: string | null;
}

export interface QualifiedLap {
  lap: number;
  moving_time_seconds: number;
  distance_km: number;
  speed_mps: number;
  avg_hr: number;
}

export interface BaselineResult {
  n_qualifying_runs: number;
  mean_decoupling_pct: number;
  stdev_decoupling_pct: number;
  lower_bound: number;
  upper_bound: number;
  is_established: boolean;
}

export interface TrendEntry {
  date: string;
  rolling_30d_mean: number;
  n_activities: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function makeSkippedResult(
  effortTier: EffortTier,
  awaitingGap: boolean,
  skipReason: string,
  lapsExcludedWarmup: number,
  lapsExcludedHr: number,
  qualifyingDurationS: number,
  hrDataInsufficient: boolean,
): DecouplingResult {
  return {
    ef_h1: null,
    ef_h2: null,
    decoupling_pct: null,
    ef_q1: null,
    ef_q2: null,
    ef_q3: null,
    ef_q4: null,
    decoupling_q1q4_pct: null,
    decoupling_q1q2_pct: null,
    effort_tier: effortTier,
    gap_used: false,
    awaiting_gap: awaitingGap,
    hr_data_insufficient: hrDataInsufficient,
    laps_excluded_warmup: lapsExcludedWarmup,
    laps_excluded_hr: lapsExcludedHr,
    qualifying_duration_s: round2(qualifyingDurationS),
    skipped: true,
    skip_reason: skipReason,
  };
}

// ── Exported Functions ───────────────────────────────────────────────────────

export function classifyEffortTier(
  avgHR: number,
  thresholds: HRZoneThresholds,
): EffortTier {
  if (avgHR >= thresholds.hrz_4_min) return 'hard';
  if (avgHR >= thresholds.hrz_3_min) return 'moderate';
  return 'easy';
}

export function computeDecoupling(input: DecouplingInput): DecouplingResult {
  const { activity, laps, effort_tier } = input;
  const awaitingGap = (activity.ascent ?? 0) > 100;

  // Edge case: no laps
  if (laps.length === 0) {
    return makeSkippedResult(effort_tier, awaitingGap, 'no_laps', 0, 0, 0, false);
  }

  // ── Step 1: Warmup Lap Exclusion ─────────────────────────────────────────
  const sortedLaps = [...laps].sort((a, b) => a.lap - b.lap);
  let cumulativeTime = 0;
  let lapsExcludedWarmup = 0;
  const afterWarmup: LapRecord[] = [];

  for (const lap of sortedLaps) {
    const mt = lap.moving_time_seconds ?? 0;
    const prevCumulative = cumulativeTime;
    cumulativeTime += mt;

    if (cumulativeTime <= 600) {
      // Entirely within warmup
      lapsExcludedWarmup++;
    } else if (prevCumulative < 600) {
      // Straddles the 10-minute mark — exclude in full
      lapsExcludedWarmup++;
    } else {
      afterWarmup.push(lap);
    }
  }

  // Edge case: all laps are warmup
  if (afterWarmup.length === 0) {
    return makeSkippedResult(effort_tier, awaitingGap, 'all_laps_warmup', lapsExcludedWarmup, 0, 0, false);
  }

  // ── Step 2: Paused/Stopped Segment Exclusion ─────────────────────────────
  const afterPaused: LapRecord[] = afterWarmup.filter((lap) => {
    if (lap.moving_time_seconds === null || lap.moving_time_seconds === 0) return false;
    if (lap.distance === null || lap.distance === 0) return false;
    if (
      lap.elapsed_time_seconds !== null &&
      lap.moving_time_seconds < 0.5 * lap.elapsed_time_seconds
    ) {
      return false;
    }
    return true;
  });

  const totalRemainingLaps = afterPaused.length;

  // ── Step 3: HR Validity Check ────────────────────────────────────────────
  const lapsWithValidHr = afterPaused.filter(
    (l) => l.avg_hr !== null && l.avg_hr > 0,
  );
  const lapsExcludedHr = totalRemainingLaps - lapsWithValidHr.length;

  if (lapsWithValidHr.length < 0.75 * totalRemainingLaps) {
    return makeSkippedResult(
      effort_tier,
      awaitingGap,
      'hr_coverage_below_75pct',
      lapsExcludedWarmup,
      lapsExcludedHr,
      0,
      true,
    );
  }

  // Build QualifiedLap array from HR-valid laps
  const qualifiedLaps: QualifiedLap[] = lapsWithValidHr.map((l) => {
    const distKm = (l.distance ?? 0) / 1000;
    const mt = l.moving_time_seconds!;
    const speedMps = (distKm * 1000) / mt;
    return {
      lap: l.lap,
      moving_time_seconds: mt,
      distance_km: distKm,
      speed_mps: speedMps,
      avg_hr: l.avg_hr!,
    };
  });

  // ── Step 4: Minimum Duration Check ───────────────────────────────────────
  const qualifyingDurationS = qualifiedLaps.reduce(
    (acc, l) => acc + l.moving_time_seconds,
    0,
  );

  if (qualifyingDurationS < 1800) {
    return makeSkippedResult(
      effort_tier,
      awaitingGap,
      'qualifying_duration_below_30min',
      lapsExcludedWarmup,
      lapsExcludedHr,
      qualifyingDurationS,
      false,
    );
  }

  // Edge case: need at least 2 qualifying laps for a split
  if (qualifiedLaps.length < 2) {
    return makeSkippedResult(
      effort_tier,
      awaitingGap,
      'insufficient_laps_for_split',
      lapsExcludedWarmup,
      lapsExcludedHr,
      qualifyingDurationS,
      false,
    );
  }

  // ── Half-Split Decoupling ────────────────────────────────────────────────
  const totalTime = qualifiedLaps.reduce(
    (acc, l) => acc + l.moving_time_seconds,
    0,
  );
  const halfTime = totalTime / 2;

  let cumulative = 0;
  let splitIndex = qualifiedLaps.length;
  let straddleLap: QualifiedLap | null = null;
  let straddleFractionH1 = 1.0;

  for (let i = 0; i < qualifiedLaps.length; i++) {
    const prevCumulative = cumulative;
    cumulative += qualifiedLaps[i].moving_time_seconds;
    if (prevCumulative < halfTime && cumulative >= halfTime) {
      straddleLap = qualifiedLaps[i];
      straddleFractionH1 =
        (halfTime - prevCumulative) / qualifiedLaps[i].moving_time_seconds;
      splitIndex = i;
      break;
    }
  }

  const firstHalf = qualifiedLaps.slice(0, splitIndex);
  const secondHalf = qualifiedLaps.slice(splitIndex + 1);

  function twMeanWithStraddle(
    fullHalfLaps: QualifiedLap[],
    straddle: QualifiedLap | null,
    straddleFraction: number,
  ): { speed: number; hr: number } {
    const straddleTimeForHalf = straddle
      ? straddle.moving_time_seconds * straddleFraction
      : 0;
    const totalWeight =
      fullHalfLaps.reduce((acc, l) => acc + l.moving_time_seconds, 0) +
      straddleTimeForHalf;

    if (totalWeight === 0) return { speed: 0, hr: 0 };

    const weightedSpeed =
      fullHalfLaps.reduce(
        (acc, l) => acc + l.speed_mps * l.moving_time_seconds,
        0,
      ) + (straddle ? straddle.speed_mps * straddleTimeForHalf : 0);
    const weightedHr =
      fullHalfLaps.reduce(
        (acc, l) => acc + l.avg_hr * l.moving_time_seconds,
        0,
      ) + (straddle ? straddle.avg_hr * straddleTimeForHalf : 0);

    return { speed: weightedSpeed / totalWeight, hr: weightedHr / totalWeight };
  }

  // Guard: if either half is empty AND no straddle lap
  if (
    (firstHalf.length === 0 || secondHalf.length === 0) &&
    straddleLap === null
  ) {
    return makeSkippedResult(
      effort_tier,
      awaitingGap,
      'insufficient_laps_for_split',
      lapsExcludedWarmup,
      lapsExcludedHr,
      qualifyingDurationS,
      false,
    );
  }

  const h1Stats = twMeanWithStraddle(firstHalf, straddleLap, straddleFractionH1);
  const h2Stats = twMeanWithStraddle(
    secondHalf,
    straddleLap,
    1 - straddleFractionH1,
  );

  const efH1 = h1Stats.hr === 0 ? 0 : h1Stats.speed / h1Stats.hr;
  const efH2 = h2Stats.hr === 0 ? 0 : h2Stats.speed / h2Stats.hr;

  let decouplingPct: number | null;
  if (efH1 === 0) {
    decouplingPct = null;
  } else {
    decouplingPct = round2(((efH1 - efH2) / efH1) * 100);
  }

  // ── Quartile Decoupling ──────────────────────────────────────────────────
  let efQ1: number | null = null;
  let efQ2: number | null = null;
  let efQ3: number | null = null;
  let efQ4: number | null = null;
  let decouplingQ1Q4Pct: number | null = null;
  let decouplingQ1Q2Pct: number | null = null;

  const shouldComputeQuartiles =
    activity.is_race === true || qualifyingDurationS > 7200;

  if (shouldComputeQuartiles && qualifiedLaps.length >= 4) {
    const quarterTime = totalTime / 4;

    // Build quartiles with straddle handling
    const quartileLaps: QualifiedLap[][] = [[], [], [], []];
    const quartileFractions: Array<{
      lap: QualifiedLap;
      fraction: number;
      quartile: number;
    }[]> = [[], [], [], []];

    let qCumulative = 0;
    let currentQuartile = 0;

    for (const lap of qualifiedLaps) {
      const prevQCumulative = qCumulative;
      qCumulative += lap.moving_time_seconds;

      // Check if this lap straddles a quartile boundary
      let lapAssigned = false;
      while (
        currentQuartile < 3 &&
        prevQCumulative < (currentQuartile + 1) * quarterTime &&
        qCumulative >= (currentQuartile + 1) * quarterTime
      ) {
        const boundary = (currentQuartile + 1) * quarterTime;
        const fractionInCurrent =
          (boundary - prevQCumulative) / lap.moving_time_seconds;
        quartileFractions[currentQuartile].push({
          lap,
          fraction: fractionInCurrent,
          quartile: currentQuartile,
        });
        const fractionInNext = 1 - fractionInCurrent;
        // The remaining fraction goes to the next quartile
        if (currentQuartile + 1 <= 3) {
          quartileFractions[currentQuartile + 1].push({
            lap,
            fraction: fractionInNext,
            quartile: currentQuartile + 1,
          });
        }
        currentQuartile++;
        lapAssigned = true;
        break;
      }

      if (!lapAssigned) {
        quartileLaps[currentQuartile].push(lap);
      }
    }

    function computeSegmentEF(
      fullLaps: QualifiedLap[],
      fractions: { lap: QualifiedLap; fraction: number }[],
    ): number | null {
      let totalWeight = fullLaps.reduce(
        (acc, l) => acc + l.moving_time_seconds,
        0,
      );
      let weightedSpeed = fullLaps.reduce(
        (acc, l) => acc + l.speed_mps * l.moving_time_seconds,
        0,
      );
      let weightedHr = fullLaps.reduce(
        (acc, l) => acc + l.avg_hr * l.moving_time_seconds,
        0,
      );

      for (const f of fractions) {
        const ft = f.lap.moving_time_seconds * f.fraction;
        totalWeight += ft;
        weightedSpeed += f.lap.speed_mps * ft;
        weightedHr += f.lap.avg_hr * ft;
      }

      if (totalWeight === 0) return null;
      const avgSpeed = weightedSpeed / totalWeight;
      const avgHr = weightedHr / totalWeight;
      if (avgHr === 0) return null;
      return avgSpeed / avgHr;
    }

    const q1 = computeSegmentEF(quartileLaps[0], quartileFractions[0]);
    const q2 = computeSegmentEF(quartileLaps[1], quartileFractions[1]);
    const q3 = computeSegmentEF(quartileLaps[2], quartileFractions[2]);
    const q4 = computeSegmentEF(quartileLaps[3], quartileFractions[3]);

    if (q1 !== null && q2 !== null && q3 !== null && q4 !== null) {
      efQ1 = round2(q1);
      efQ2 = round2(q2);
      efQ3 = round2(q3);
      efQ4 = round2(q4);
      decouplingQ1Q4Pct =
        q1 === 0 ? null : round2(((q1 - q4) / q1) * 100);
      decouplingQ1Q2Pct =
        q1 === 0 ? null : round2(((q1 - q2) / q1) * 100);
    }
  }

  return {
    ef_h1: round2(efH1),
    ef_h2: round2(efH2),
    decoupling_pct: decouplingPct,
    ef_q1: efQ1,
    ef_q2: efQ2,
    ef_q3: efQ3,
    ef_q4: efQ4,
    decoupling_q1q4_pct: decouplingQ1Q4Pct,
    decoupling_q1q2_pct: decouplingQ1Q2Pct,
    effort_tier,
    gap_used: false,
    awaiting_gap: awaitingGap,
    hr_data_insufficient: false,
    laps_excluded_warmup: lapsExcludedWarmup,
    laps_excluded_hr: lapsExcludedHr,
    qualifying_duration_s: round2(qualifyingDurationS),
    skipped: false,
    skip_reason: null,
  };
}

export function computeBaseline(decouplingValues: number[]): BaselineResult {
  const n = decouplingValues.length;
  if (n === 0) {
    return {
      n_qualifying_runs: 0,
      mean_decoupling_pct: 0,
      stdev_decoupling_pct: 0,
      lower_bound: 0,
      upper_bound: 0,
      is_established: false,
    };
  }

  const mean = decouplingValues.reduce((a, b) => a + b, 0) / n;
  const sumSqDiff = decouplingValues.reduce(
    (acc, v) => acc + (v - mean) ** 2,
    0,
  );
  const stdev = Math.sqrt(sumSqDiff / n);

  return {
    n_qualifying_runs: n,
    mean_decoupling_pct: round2(mean),
    stdev_decoupling_pct: round2(stdev),
    lower_bound: round2(mean - 2 * stdev),
    upper_bound: round2(mean + 2 * stdev),
    is_established: n >= 20,
  };
}

export function computeRollingTrend(
  entries: Array<{ date: string; decoupling_pct: number }>,
  lookbackDays: number = 90,
): TrendEntry[] {
  if (entries.length === 0) return [];

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const lookbackStart = new Date(today);
  lookbackStart.setDate(lookbackStart.getDate() - lookbackDays);
  const lookbackStartStr = lookbackStart.toISOString().slice(0, 10);

  // Filter to entries within lookback period
  const filtered = entries
    .filter((e) => e.date >= lookbackStartStr)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (filtered.length === 0) return [];

  // Get unique dates
  const uniqueDates = [...new Set(filtered.map((e) => e.date))].sort();

  const result: TrendEntry[] = [];

  for (const date of uniqueDates) {
    const dateObj = new Date(date + 'T00:00:00Z');
    const windowStart = new Date(dateObj);
    windowStart.setUTCDate(windowStart.getUTCDate() - 30);
    const windowStartStr = windowStart.toISOString().slice(0, 10);

    const windowEntries = filtered.filter(
      (d) => d.date > windowStartStr && d.date <= date,
    );

    if (windowEntries.length === 0) continue;

    const mean =
      windowEntries.reduce((acc, e) => acc + e.decoupling_pct, 0) /
      windowEntries.length;

    result.push({
      date,
      rolling_30d_mean: round2(mean),
      n_activities: windowEntries.length,
    });
  }

  return result;
}
