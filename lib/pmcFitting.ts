/**
 * PMC-004: Adaptive Parameter Fitting Engine (pure functions — no DB).
 *
 * Solves for personalized tc_fitness and tc_fatigue by minimizing the
 * sum of squared residuals between predicted and actual benchmark performance.
 *
 * Model: predicted_perf = k1 * CTL(tc_fitness) - k2 * ATL(tc_fatigue) + intercept
 *
 * Optimization strategy: 2D Nelder-Mead over (tc_fitness, tc_fatigue).
 * For each candidate tc pair, k1/k2/intercept are solved analytically via OLS
 * (design matrix X = [CTL, -ATL, 1]), collapsing the search space from 5D → 2D.
 *
 * Performance: activities are pre-aggregated into dense Float64Arrays once
 * before the optimizer starts. The inner loss function walks those arrays
 * directly (no Map creation, no string comparisons, no array allocation per
 * call), reducing 1000-iteration bootstrap from ~30s to ~1-2s in V8/Hermes.
 */

import { computeFittingEligibility } from './benchmarkUtils.ts';
import type { PMCInput } from './pmc.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BenchmarkForFit {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Normalized performance score (VDOT for running, watts/kg for cycling) */
  performance_score: number;
}

export interface ClampEvent {
  parameter: 'tc_fitness' | 'tc_fatigue';
  raw_value: number;
  clamped_value: number;
}

export interface CIBounds {
  tc_fitness_low: number;
  tc_fitness_high: number;
  tc_fatigue_low: number;
  tc_fatigue_high: number;
}

export type FitDecayResult =
  | { eligible: false; count: number; months_span: number }
  | {
      tc_fitness: number;
      tc_fatigue: number;
      k1: number;
      k2: number;
      intercept: number;
      r2: number;
      n_benchmarks: number;
      ci: CIBounds;
      was_clamped: boolean;
      clamp_events: ClampEvent[];
    };

// ── Physiological bounds ──────────────────────────────────────────────────────

const BOUNDS = {
  tc_fitness: [20, 60] as [number, number],
  tc_fatigue: [3, 14] as [number, number],
};

const DAY_MS = 86400000;

// ── Pre-aggregated activity data (built once, reused by all optimizer calls) ──

interface PreAgg {
  /** Dense array of per-day CTL TSS contributions (including zero rest days) */
  ctlTss: Float64Array;
  /** Dense array of per-day ATL TSS contributions */
  atlTss: Float64Array;
  /** Total number of days (earliest activity to today) */
  totalDays: number;
  /** UTC midnight timestamp (ms) of the first day in the arrays */
  startMs: number;
}

/** Aggregate activities into dense typed arrays for fast optimizer inner loops. */
function buildPreAgg(activities: PMCInput[]): PreAgg | null {
  if (activities.length === 0) return null;

  // Aggregate TSS by date using a plain Map (done once)
  const tssMap = new Map<string, [number, number]>(); // date → [ctl_tss, atl_tss]
  for (const act of activities) {
    const curr = tssMap.get(act.date) ?? [0, 0];
    curr[0] += act.tss;
    curr[1] += act.atl_tss ?? act.tss;
    tssMap.set(act.date, curr);
  }

  const dates = [...tssMap.keys()].sort();
  const startMs = new Date(dates[0] + 'T00:00:00Z').getTime();
  const todayMs = new Date(
    new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
  ).getTime();
  const totalDays = Math.floor((todayMs - startMs) / DAY_MS) + 1;

  const ctlTss = new Float64Array(totalDays); // initialized to 0
  const atlTss = new Float64Array(totalDays);

  for (const [date, [ctl, atl]] of tssMap) {
    const i = Math.round(
      (new Date(date + 'T00:00:00Z').getTime() - startMs) / DAY_MS,
    );
    if (i >= 0 && i < totalDays) {
      ctlTss[i] = ctl;
      atlTss[i] = atl;
    }
  }

  return { ctlTss, atlTss, totalDays, startMs };
}

/** Map benchmark dates to day indices within the preAgg arrays. */
function buildBenchmarkIndices(
  preAgg: PreAgg,
  benchmarks: BenchmarkForFit[],
): { indices: Int32Array; scores: Float64Array } {
  const indices: number[] = [];
  const scores: number[] = [];

  for (const b of benchmarks) {
    const ms = new Date(b.date + 'T00:00:00Z').getTime();
    const i = Math.round((ms - preAgg.startMs) / DAY_MS);
    if (i >= 0 && i < preAgg.totalDays) {
      indices.push(i);
      scores.push(b.performance_score);
    }
  }

  // Sort by day index so the forward walk hits them in order
  const order = indices.map((_, j) => j).sort((a, b) => indices[a] - indices[b]);
  return {
    indices: new Int32Array(order.map((j) => indices[j])),
    scores: new Float64Array(order.map((j) => scores[j])),
  };
}

// ── OLS: 3×3 matrix inversion + linear solve ──────────────────────────────────

function invert3x3(m: number[][]): number[][] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    [
      (e * i - f * h) / det,
      (c * h - b * i) / det,
      (b * f - c * e) / det,
    ],
    [
      (f * g - d * i) / det,
      (a * i - c * g) / det,
      (c * d - a * f) / det,
    ],
    [
      (d * h - e * g) / det,
      (b * g - a * h) / det,
      (a * e - b * d) / det,
    ],
  ];
}

interface LinearFit {
  /** Coefficient on CTL (positive = fitness builds performance) */
  k1: number;
  /** Coefficient on ATL (positive = fatigue suppresses performance) */
  k2: number;
  intercept: number;
  ssr: number;
  r2: number;
}

/**
 * Given pre-computed CTL and ATL values at N benchmark dates, solve OLS for
 * k1, k2, intercept that minimize Σ(k1*CTL_i - k2*ATL_i + intercept - score_i)².
 *
 * Design matrix: X[i] = [CTL_i, -ATL_i, 1]  →  β = [k1, k2, intercept]
 * β is solved via the 3×3 normal equations. Returns null if singular.
 */
function solveOLS(
  ctlAtBm: Float64Array,
  atlAtBm: Float64Array,
  scores: Float64Array,
  n: number,
): LinearFit | null {
  if (n < 3) return null;

  // Compute X'X (3×3) and X'y (3×1)
  // Row i of X: [CTL_i, -ATL_i, 1]
  let xx00 = 0, xx01 = 0, xx02 = 0;
  let xx11 = 0, xx12 = 0, xx22 = 0;
  let xy0 = 0, xy1 = 0, xy2 = 0;
  let ySum = 0;

  for (let i = 0; i < n; i++) {
    const c = ctlAtBm[i];
    const a = -atlAtBm[i];
    const y = scores[i];
    xx00 += c * c;
    xx01 += c * a;
    xx02 += c;
    xx11 += a * a;
    xx12 += a;
    xx22 += 1;
    xy0 += c * y;
    xy1 += a * y;
    xy2 += y;
    ySum += y;
  }

  const XtX = [
    [xx00, xx01, xx02],
    [xx01, xx11, xx12],
    [xx02, xx12, xx22],
  ];
  const inv = invert3x3(XtX);
  if (!inv) return null;

  const k1 = inv[0][0] * xy0 + inv[0][1] * xy1 + inv[0][2] * xy2;
  const k2 = inv[1][0] * xy0 + inv[1][1] * xy1 + inv[1][2] * xy2;
  const intercept = inv[2][0] * xy0 + inv[2][1] * xy1 + inv[2][2] * xy2;

  const yMean = ySum / n;
  let ssr = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const pred = k1 * ctlAtBm[i] + k2 * (-atlAtBm[i]) + intercept;
    ssr += (pred - scores[i]) ** 2;
    sst += (scores[i] - yMean) ** 2;
  }
  const r2 = sst > 0 ? Math.max(0, 1 - ssr / sst) : 0;

  return { k1, k2, intercept, ssr, r2 };
}

// ── Fast inner loss function (no allocation per call) ─────────────────────────

/** Reusable scratch buffers shared across all optimizer calls (avoids GC). */
const _ctlAtBm = new Float64Array(64); // supports up to 64 benchmarks
const _atlAtBm = new Float64Array(64);

/**
 * Compute SSR for candidate (tc_fitness, tc_fatigue) using pre-aggregated data.
 *
 * Walks the dense activity arrays forward, recording CTL/ATL at benchmark
 * indices, then solves OLS analytically. No Map creation, no string ops,
 * no array allocation per call.
 */
function computeLoss(
  preAgg: PreAgg,
  bmIndices: Int32Array,
  bmScores: Float64Array,
  tc_fitness: number,
  tc_fatigue: number,
): number {
  const k_ctl = 1 - Math.exp(-1 / tc_fitness);
  const k_atl = 1 - Math.exp(-1 / tc_fatigue);
  const { ctlTss, atlTss, totalDays } = preAgg;
  const N = bmIndices.length;

  let ctl = 0;
  let atl = 0;
  let bmPtr = 0;

  for (let i = 0; i < totalDays && bmPtr < N; i++) {
    ctl = ctl + (ctlTss[i] - ctl) * k_ctl;
    atl = atl + (atlTss[i] - atl) * k_atl;
    if (bmIndices[bmPtr] === i) {
      _ctlAtBm[bmPtr] = ctl;
      _atlAtBm[bmPtr] = atl;
      bmPtr++;
    }
  }

  const fit = solveOLS(_ctlAtBm, _atlAtBm, bmScores, bmPtr);
  return fit?.ssr ?? 1e12;
}

// ── 2D bounded Nelder-Mead ────────────────────────────────────────────────────

type Point2D = [number, number];

function clampPt(
  p: Point2D,
  lo: [number, number],
  hi: [number, number],
): Point2D {
  return [
    Math.max(lo[0], Math.min(hi[0], p[0])),
    Math.max(lo[1], Math.min(hi[1], p[1])),
  ];
}

/**
 * Minimize fn(tc_fitness, tc_fatigue) via bounded Nelder-Mead simplex.
 * Points are projected onto bounds after each step.
 * Initial simplex: step [5, 2] from `initial`.
 */
function nelderMead(
  fn: (tcf: number, tca: number) => number,
  initial: Point2D,
  bounds: { tcf: [number, number]; tca: [number, number] },
  maxIter = 1000,
  tol = 1e-6,
): Point2D {
  const lo: [number, number] = [bounds.tcf[0], bounds.tca[0]];
  const hi: [number, number] = [bounds.tcf[1], bounds.tca[1]];
  const cp = (p: Point2D): Point2D => clampPt(p, lo, hi);

  let S: Point2D[] = [
    cp(initial),
    cp([initial[0] + 5, initial[1]]),
    cp([initial[0], initial[1] + 2]),
  ];
  let F = S.map(([a, b]) => fn(a, b));

  for (let iter = 0; iter < maxIter; iter++) {
    const idx = [0, 1, 2].sort((a, b) => F[a] - F[b]);
    S = idx.map((i) => S[i]) as [Point2D, Point2D, Point2D];
    F = idx.map((i) => F[i]);

    if (Math.abs(F[2] - F[0]) < tol) break;

    const C: Point2D = [(S[0][0] + S[1][0]) / 2, (S[0][1] + S[1][1]) / 2];
    const R = cp([C[0] + (C[0] - S[2][0]), C[1] + (C[1] - S[2][1])]);
    const fR = fn(R[0], R[1]);

    if (fR < F[0]) {
      const E = cp([C[0] + 2 * (C[0] - S[2][0]), C[1] + 2 * (C[1] - S[2][1])]);
      const fE = fn(E[0], E[1]);
      S[2] = fE < fR ? E : R;
      F[2] = fE < fR ? fE : fR;
    } else if (fR < F[1]) {
      S[2] = R;
      F[2] = fR;
    } else {
      const K = cp([C[0] + 0.5 * (S[2][0] - C[0]), C[1] + 0.5 * (S[2][1] - C[1])]);
      const fK = fn(K[0], K[1]);
      if (fK < F[2]) {
        S[2] = K;
        F[2] = fK;
      } else {
        for (let i = 1; i < 3; i++) {
          S[i] = cp([
            S[0][0] + 0.5 * (S[i][0] - S[0][0]),
            S[0][1] + 0.5 * (S[i][1] - S[0][1]),
          ]);
          F[i] = fn(S[i][0], S[i][1]);
        }
      }
    }
  }

  return S[0];
}

// ── Bootstrap CI ──────────────────────────────────────────────────────────────

/**
 * Estimate 95% confidence intervals via bootstrap resampling (N=1000).
 *
 * Each iteration resamples the benchmark set with replacement and re-optimizes.
 * Uses the same pre-aggregated activity data for all iterations — only the
 * benchmark indices/scores array changes per iteration.
 *
 * CI = [2.5th, 97.5th] percentile of the 1000-sample distributions.
 */
export function bootstrapCI(
  activities: PMCInput[],
  benchmarks: BenchmarkForFit[],
  fittedParams: Point2D,
  n = 1000,
): CIBounds {
  const preAgg = buildPreAgg(activities);
  if (!preAgg) {
    return {
      tc_fitness_low: fittedParams[0],
      tc_fitness_high: fittedParams[0],
      tc_fatigue_low: fittedParams[1],
      tc_fatigue_high: fittedParams[1],
    };
  }

  const { indices: origIdx, scores: origScores } = buildBenchmarkIndices(
    preAgg,
    benchmarks,
  );
  const N = origIdx.length;

  const tcfSamples: number[] = [];
  const tcaSamples: number[] = [];

  // Scratch buffers for bootstrap resamples (avoid allocation in hot loop)
  const rsIdx = new Int32Array(N);
  const rsScores = new Float64Array(N);

  for (let iter = 0; iter < n; iter++) {
    // Resample with replacement into scratch buffers
    for (let j = 0; j < N; j++) {
      const pick = Math.floor(Math.random() * N);
      rsIdx[j] = origIdx[pick];
      rsScores[j] = origScores[pick];
    }
    // Re-sort by day index (required for the forward-walk inner loop)
    const order = Array.from({ length: N }, (_, i) => i).sort(
      (a, b) => rsIdx[a] - rsIdx[b],
    );
    const sortedIdx = new Int32Array(order.map((i) => rsIdx[i]));
    const sortedScores = new Float64Array(order.map((i) => rsScores[i]));

    const [tcf, tca] = nelderMead(
      (tcf, tca) => computeLoss(preAgg, sortedIdx, sortedScores, tcf, tca),
      fittedParams,
      { tcf: BOUNDS.tc_fitness, tca: BOUNDS.tc_fatigue },
      200,
      1e-4,
    );
    tcfSamples.push(tcf);
    tcaSamples.push(tca);
  }

  tcfSamples.sort((a, b) => a - b);
  tcaSamples.sort((a, b) => a - b);

  const lo = Math.floor(0.025 * n);
  const hi = Math.min(Math.ceil(0.975 * n), n - 1);

  return {
    tc_fitness_low: tcfSamples[lo],
    tc_fitness_high: tcfSamples[hi],
    tc_fatigue_low: tcaSamples[lo],
    tc_fatigue_high: tcaSamples[hi],
  };
}

// ── Main exported fitting function ────────────────────────────────────────────

/**
 * Fit personalized tc_fitness and tc_fatigue from benchmark performance history.
 *
 * @param activities  Full activity history with TSS (fetch from garmin_activities
 *                    before calling — not re-fetched per optimizer step).
 * @param benchmarks  Ground-truth performance observations from benchmark_efforts.
 *
 * @returns {eligible: false} when < 6 benchmarks or < 6 months span.
 *          Otherwise returns fitted params, R², bootstrap CI, and clamp events.
 */
export function fitDecayConstants(
  activities: PMCInput[],
  benchmarks: BenchmarkForFit[],
): FitDecayResult {
  // Data gate (R2): ≥ 6 benchmarks spanning ≥ 6 months
  const dates = benchmarks.map((b) => b.date);
  const eligibility = computeFittingEligibility(dates);
  if (!eligibility.eligible) {
    return {
      eligible: false,
      count: eligibility.count,
      months_span: eligibility.months_span,
    };
  }

  const preAgg = buildPreAgg(activities);
  if (!preAgg) {
    return { eligible: false, count: 0, months_span: 0 };
  }

  const { indices: bmIndices, scores: bmScores } = buildBenchmarkIndices(
    preAgg,
    benchmarks,
  );

  // 2D Nelder-Mead starting from defaults
  const [raw_tcf, raw_tca] = nelderMead(
    (tcf, tca) => computeLoss(preAgg, bmIndices, bmScores, tcf, tca),
    [42, 7],
    { tcf: BOUNDS.tc_fitness, tca: BOUNDS.tc_fatigue },
  );

  // Clamp to physiological bounds (R5) and record events
  const clamp_events: ClampEvent[] = [];

  const tc_fitness = Math.max(
    BOUNDS.tc_fitness[0],
    Math.min(BOUNDS.tc_fitness[1], raw_tcf),
  );
  if (Math.abs(tc_fitness - raw_tcf) > 0.001) {
    clamp_events.push({
      parameter: 'tc_fitness',
      raw_value: raw_tcf,
      clamped_value: tc_fitness,
    });
  }

  const tc_fatigue = Math.max(
    BOUNDS.tc_fatigue[0],
    Math.min(BOUNDS.tc_fatigue[1], raw_tca),
  );
  if (Math.abs(tc_fatigue - raw_tca) > 0.001) {
    clamp_events.push({
      parameter: 'tc_fatigue',
      raw_value: raw_tca,
      clamped_value: tc_fatigue,
    });
  }

  // Compute final linear fit with clamped tc values
  const finalIdx = buildBenchmarkIndices(preAgg, benchmarks);
  const finalN = finalIdx.indices.length;
  const finalCtl = new Float64Array(finalN);
  const finalAtl = new Float64Array(finalN);
  {
    const k_ctl = 1 - Math.exp(-1 / tc_fitness);
    const k_atl = 1 - Math.exp(-1 / tc_fatigue);
    let c = 0, a = 0, ptr = 0;
    for (let i = 0; i < preAgg.totalDays && ptr < finalN; i++) {
      c = c + (preAgg.ctlTss[i] - c) * k_ctl;
      a = a + (preAgg.atlTss[i] - a) * k_atl;
      if (finalIdx.indices[ptr] === i) {
        finalCtl[ptr] = c;
        finalAtl[ptr] = a;
        ptr++;
      }
    }
  }
  const linear = solveOLS(finalCtl, finalAtl, finalIdx.scores, finalN);

  if (!linear) {
    return { eligible: false, count: benchmarks.length, months_span: 0 };
  }

  // Bootstrap CI (R6)
  const ci = bootstrapCI(activities, benchmarks, [tc_fitness, tc_fatigue]);

  return {
    tc_fitness,
    tc_fatigue,
    k1: linear.k1,
    k2: linear.k2,
    intercept: linear.intercept,
    r2: linear.r2,
    n_benchmarks: benchmarks.length,
    ci,
    was_clamped: clamp_events.length > 0,
    clamp_events,
  };
}
