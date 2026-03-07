/**
 * PMC-007: Performance Management Chart component.
 *
 * Self-contained: fetches its own data, renders sport selector, model badge,
 * SVG chart (CTL / ATL / TSB lines + CI band + benchmark/race markers), and
 * a personalization onboarding banner.
 *
 * Chart is built entirely with react-native-svg so that we have full control
 * over marker overlays and the confidence band — chart-kit does not expose
 * the internal pixel coordinates needed for those features.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  LayoutChangeEvent,
} from 'react-native';
import Svg, {
  Path,
  Line,
  G,
  Text as SvgText,
  Polygon,
  Rect,
} from 'react-native-svg';
import { calculatePMC } from '../lib/pmc';
import {
  fetchPMCData,
  fetchAthleteParams,
  fetchBenchmarkMarkers,
  fetchRaceMarkers,
  fetchRawActivitiesForCI,
  getUnreadNotifications,
  markNotificationRead,
  runFitting,
  type PMCDataRow,
  type AthleteParams,
  type BenchmarkMarker,
  type RaceMarker,
  type AthleteNotification,
} from '../lib/pmcFittingDb';

// ── Types ─────────────────────────────────────────────────────────────────────

type SportKey = 'run' | 'cycle' | 'combined';

interface CIBand {
  /** Date-keyed lookup — covers the same dates as daily_pmc_values. */
  lowByDate: Map<string, number>;
  highByDate: Map<string, number>;
}

interface TooltipState {
  type: 'benchmark' | 'race';
  /** Pixel x within the chart container. */
  x: number;
  date: string;
  detail: string;
}

interface Props {
  refreshTrigger?: number;
  onOpenSettings?: () => void;
}

// ── Layout constants ──────────────────────────────────────────────────────────

const CHART_H = 220;
const PAD = { left: 44, right: 10, top: 12, bottom: 30 } as const;
const DISPLAY_DAYS = 90;

const SPORT_TABS: { key: SportKey; label: string }[] = [
  { key: 'run', label: 'Run' },
  { key: 'cycle', label: 'Cycle' },
  { key: 'combined', label: 'Combined' },
];

// ── Scale helpers (pure functions) ────────────────────────────────────────────

function scaleX(idx: number, n: number, width: number): number {
  if (n <= 1) return PAD.left + (width - PAD.left - PAD.right) / 2;
  return PAD.left + (idx / (n - 1)) * (width - PAD.left - PAD.right);
}

function scaleY(value: number, minVal: number, maxVal: number): number {
  if (maxVal === minVal) return (CHART_H - PAD.bottom + PAD.top) / 2;
  const chartH = CHART_H - PAD.top - PAD.bottom;
  return CHART_H - PAD.bottom - ((value - minVal) / (maxVal - minVal)) * chartH;
}

function buildPath(xs: number[], ys: number[]): string {
  if (xs.length === 0) return '';
  return xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`)
    .join(' ');
}

/** Catmull-Rom–inspired smooth path: control points at horizontal midpoints. */
function buildSmoothPath(xs: number[], ys: number[]): string {
  if (xs.length === 0) return '';
  if (xs.length === 1) return `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  let d = `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 1; i < xs.length; i++) {
    const cx = ((xs[i - 1] + xs[i]) / 2).toFixed(1);
    d += ` C ${cx} ${ys[i - 1].toFixed(1)}, ${cx} ${ys[i].toFixed(1)}, ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
  }
  return d;
}

function buildBandPath(
  dates: string[],
  lowByDate: Map<string, number>,
  highByDate: Map<string, number>,
  n: number,
  width: number,
  minVal: number,
  maxVal: number,
): string {
  if (dates.length === 0) return '';
  // Forward along highCTL
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = scaleX(i, n, width).toFixed(1);
    const v = highByDate.get(dates[i]) ?? 0;
    const y = scaleY(v, minVal, maxVal).toFixed(1);
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  }
  // Backward along lowCTL
  for (let i = n - 1; i >= 0; i--) {
    const x = scaleX(i, n, width).toFixed(1);
    const v = lowByDate.get(dates[i]) ?? 0;
    const y = scaleY(v, minVal, maxVal).toFixed(1);
    d += `L ${x} ${y} `;
  }
  return d + 'Z';
}

function niceYTicks(minVal: number, maxVal: number, count = 5): number[] {
  const range = maxVal - minVal;
  if (range === 0) return [Math.round(minVal)];
  const rawStep = range / (count - 1);
  const exp = Math.floor(Math.log10(rawStep));
  const frac = rawStep / Math.pow(10, exp);
  const niceF = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  const step = niceF * Math.pow(10, exp);
  const start = Math.floor(minVal / step) * step;
  const ticks: number[] = [];
  for (let t = start; ticks.length < count + 2 && t <= maxVal + step; t += step) {
    ticks.push(Math.round(t * 10) / 10);
  }
  return ticks;
}

function formatChartDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Confidence badge helper ───────────────────────────────────────────────────

function r2Badge(r2: number | null): { label: string; bg: string; fg: string } {
  if (r2 === null) return { label: '—', bg: '#f3f4f6', fg: '#9ca3af' };
  if (r2 > 0.75) return { label: 'High', bg: '#dcfce7', fg: '#16a34a' };
  if (r2 >= 0.5) return { label: 'Medium', bg: '#fef9c3', fg: '#a16207' };
  return { label: 'Low', bg: '#fee2e2', fg: '#dc2626' };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PMCChart({ refreshTrigger = 0, onOpenSettings }: Props) {
  const [sport, setSport] = useState<SportKey>('combined');
  const [loading, setLoading] = useState(true);

  const [pmcData, setPmcData] = useState<Record<SportKey, PMCDataRow[]>>({
    run: [],
    cycle: [],
    combined: [],
  });
  const [params, setParams] = useState<Record<SportKey, AthleteParams>>({
    run: defaultParams(),
    cycle: defaultParams(),
    combined: defaultParams(),
  });
  const [benchmarks, setBenchmarks] = useState<BenchmarkMarker[]>([]);
  const [races, setRaces] = useState<RaceMarker[]>([]);
  const [ciBand, setCiBand] = useState<Partial<Record<SportKey, CIBand>>>({});
  const [personalizationNotif, setPersonalizationNotif] =
    useState<AthleteNotification | null>(null);
  const [enablingPersonalization, setEnablingPersonalization] = useState(false);

  const [containerWidth, setContainerWidth] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // ── Data loading ─────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [runData, cycleData, combinedData, runP, cycleP, combinedP, bms, raceMs, notifs] =
        await Promise.all([
          fetchPMCData('run'),
          fetchPMCData('cycle'),
          fetchPMCData('combined'),
          fetchAthleteParams('run'),
          fetchAthleteParams('cycle'),
          fetchAthleteParams('combined'),
          fetchBenchmarkMarkers('combined'),
          fetchRaceMarkers(),
          getUnreadNotifications(),
        ]);

      setPmcData({ run: runData, cycle: cycleData, combined: combinedData });
      setParams({ run: runP, cycle: cycleP, combined: combinedP });
      setBenchmarks(bms);
      setRaces(raceMs);

      const notif = notifs.find((n) => n.type === 'personalization_available') ?? null;
      setPersonalizationNotif(notif);

      // Lazy CI band: compute for any personalized sport
      computeCIBands({ run: runP, cycle: cycleP, combined: combinedP });
    } catch (e) {
      console.warn('[PMCChart] loadData error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, refreshTrigger]);

  async function computeCIBands(paramMap: Record<SportKey, AthleteParams>) {
    const needsCI = (['run', 'cycle', 'combined'] as SportKey[]).filter(
      (s) =>
        paramMap[s].is_personalized &&
        paramMap[s].ci_tc_fitness_low != null &&
        paramMap[s].ci_tc_fitness_high != null,
    );
    if (needsCI.length === 0) return;

    try {
      const rawActivities = await fetchRawActivitiesForCI();

      const bands: Partial<Record<SportKey, CIBand>> = {};
      for (const s of needsCI) {
        const p = paramMap[s];
        const low = p.ci_tc_fitness_low!;
        const high = p.ci_tc_fitness_high!;
        const tc_fatigue = p.tc_fatigue;

        const lowDays = calculatePMC(rawActivities, { tc_fitness: low, tc_fatigue });
        const highDays = calculatePMC(rawActivities, { tc_fitness: high, tc_fatigue });

        bands[s] = {
          lowByDate: new Map(lowDays.map((d) => [d.date, d.ctl])),
          highByDate: new Map(highDays.map((d) => [d.date, d.ctl])),
        };
      }
      setCiBand(bands);
    } catch (e) {
      console.warn('[PMCChart] CI band error:', e);
    }
  }

  // ── Personalization onboarding ────────────────────────────────────────────

  async function handleEnablePersonalization() {
    setEnablingPersonalization(true);
    try {
      const result = await runFitting(undefined, sport);
      if (result.ok && personalizationNotif) {
        await markNotificationRead(personalizationNotif.id);
      }
      await loadData();
    } catch (e) {
      console.warn('[PMCChart] personalization error:', e);
    } finally {
      setEnablingPersonalization(false);
    }
  }

  // ── Derived display values ─────────────────────────────────────────────────

  const displayedDays = pmcData[sport].slice(-DISPLAY_DAYS);
  const currentParams = params[sport];
  const band = ciBand[sport] ?? null;

  const isEmpty = !loading && displayedDays.length === 0;

  // Compute scale range from all visible values
  let minVal = 0;
  let maxVal = 100;
  if (displayedDays.length > 0) {
    const allVals = displayedDays.flatMap((d) => [d.ctl, d.atl, d.tsb]);
    if (band) {
      for (const d of displayedDays) {
        const low = band.lowByDate.get(d.date);
        const high = band.highByDate.get(d.date);
        if (low != null) allVals.push(low);
        if (high != null) allVals.push(high);
      }
    }
    const rawMin = Math.min(...allVals);
    const rawMax = Math.max(...allVals);
    const margin = Math.max((rawMax - rawMin) * 0.12, 5);
    minVal = rawMin - margin;
    maxVal = rawMax + margin;
  }

  const N = displayedDays.length;

  // X-axis: ~5 evenly spaced labels
  const xLabelIndices =
    N <= 1
      ? [0]
      : [0, Math.floor(N * 0.25), Math.floor(N * 0.5), Math.floor(N * 0.75), N - 1].filter(
          (v, i, arr) => arr.indexOf(v) === i,
        );

  const yTicks = niceYTicks(minVal, maxVal, 5);

  // Pre-compute chart x/y arrays
  const xs = displayedDays.map((_, i) => scaleX(i, N, containerWidth));
  const ctlYs = displayedDays.map((d) => scaleY(d.ctl, minVal, maxVal));
  const atlYs = displayedDays.map((d) => scaleY(d.atl, minVal, maxVal));
  const tsbYs = displayedDays.map((d) => scaleY(d.tsb, minVal, maxVal));

  const ctlPath = buildSmoothPath(xs, ctlYs);
  const atlPath = buildSmoothPath(xs, atlYs);
  const tsbPath = buildPath(xs, tsbYs);

  const bandPath =
    band && N > 0
      ? buildBandPath(
          displayedDays.map((d) => d.date),
          band.lowByDate,
          band.highByDate,
          N,
          containerWidth,
          minVal,
          maxVal,
        )
      : null;

  const zeroY = scaleY(0, minVal, maxVal);

  // Markers filtered to display window
  const displayedDates = new Set(displayedDays.map((d) => d.date));
  const visibleBenchmarks = benchmarks.filter((b) => displayedDates.has(b.date));
  const visibleRaces = races.filter((r) => displayedDates.has(r.date));

  function dateToX(date: string): number | null {
    const idx = displayedDays.findIndex((d) => d.date === date);
    if (idx === -1) return null;
    return scaleX(idx, N, containerWidth);
  }

  // ── Badge ────────────────────────────────────────────────────────────────

  const { label: confLabel, bg: confBg, fg: confFg } = r2Badge(currentParams.r_squared);
  const isPersonalized = currentParams.is_personalized;
  const modelLabel = isPersonalized
    ? `Personalized  tc=${Math.round(currentParams.tc_fitness)}/${Math.round(currentParams.tc_fatigue)}`
    : 'Standard  42/7';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View>
      {/* Sport selector tabs */}
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: '#f3f4f6',
          borderRadius: 10,
          padding: 2,
          marginBottom: 12,
        }}
      >
        {SPORT_TABS.map(({ key, label }) => {
          const active = key === sport;
          return (
            <TouchableOpacity
              key={key}
              onPress={() => {
                setSport(key);
                setTooltip(null);
              }}
              style={{
                flex: 1,
                paddingVertical: 6,
                borderRadius: 8,
                alignItems: 'center',
                backgroundColor: active ? '#ffffff' : 'transparent',
                shadowColor: active ? '#000' : 'transparent',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: active ? 0.08 : 0,
                shadowRadius: 2,
                elevation: active ? 2 : 0,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: active ? '600' : '400',
                  color: active ? '#111827' : '#6b7280',
                }}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Model badge row */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: isPersonalized ? '#eff6ff' : '#f9fafb',
            borderRadius: 6,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderWidth: 1,
            borderColor: isPersonalized ? '#bfdbfe' : '#e5e7eb',
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: isPersonalized ? '#2563eb' : '#9ca3af',
              marginRight: 5,
            }}
          />
          <Text
            style={{
              fontSize: 11,
              fontWeight: '500',
              color: isPersonalized ? '#1d4ed8' : '#6b7280',
            }}
          >
            {modelLabel}
          </Text>
          {isPersonalized && currentParams.r_squared != null && (
            <Text style={{ fontSize: 11, color: '#6b7280', marginLeft: 6 }}>
              R²={currentParams.r_squared.toFixed(2)}
            </Text>
          )}
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: confBg,
            borderRadius: 6,
            paddingHorizontal: 8,
            paddingVertical: 4,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '500', color: confFg }}>
            {confLabel} confidence
          </Text>
        </View>
      </View>

      {/* Personalization onboarding banner */}
      {personalizationNotif && !isPersonalized && (
        <View
          style={{
            backgroundColor: '#eff6ff',
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
            borderWidth: 1,
            borderColor: '#bfdbfe',
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#1d4ed8', marginBottom: 2 }}>
              Your data is ready for personalization
            </Text>
            <Text style={{ fontSize: 11, color: '#3b82f6' }}>
              Tap to fit a model to your physiology.
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleEnablePersonalization}
            disabled={enablingPersonalization}
            style={{
              backgroundColor: '#2563eb',
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
              marginLeft: 8,
            }}
          >
            {enablingPersonalization ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Text style={{ color: 'white', fontSize: 11, fontWeight: '600' }}>Enable</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Chart area */}
      {loading ? (
        <View style={{ height: CHART_H, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#2563eb" />
        </View>
      ) : isEmpty ? (
        <View
          style={{
            height: CHART_H,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#f9fafb',
            borderRadius: 12,
            paddingHorizontal: 24,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: '#6b7280',
              textAlign: 'center',
              lineHeight: 18,
            }}
          >
            Using standard model (42/7 defaults).{'\n'}Complete 6 benchmark efforts over 6
            months to unlock a model personalized to your physiology.
          </Text>
        </View>
      ) : (
        <View
          onLayout={(e: LayoutChangeEvent) =>
            setContainerWidth(e.nativeEvent.layout.width)
          }
          style={{ position: 'relative' }}
        >
          {containerWidth > 0 && (
            <>
              <Svg width={containerWidth} height={CHART_H}>
                {/* Background tap target to dismiss tooltip */}
                <Rect
                  x={0}
                  y={0}
                  width={containerWidth}
                  height={CHART_H}
                  fill="transparent"
                  onPress={() => setTooltip(null)}
                />

                {/* Horizontal gridlines + y-axis labels */}
                {yTicks.map((tick) => {
                  const y = scaleY(tick, minVal, maxVal);
                  if (y < PAD.top - 4 || y > CHART_H - PAD.bottom + 4) return null;
                  return (
                    <G key={`grid-${tick}`}>
                      <Line
                        x1={PAD.left}
                        y1={y}
                        x2={containerWidth - PAD.right}
                        y2={y}
                        stroke={tick === 0 ? '#d1d5db' : '#f3f4f6'}
                        strokeWidth={tick === 0 ? 1.5 : 1}
                        strokeDasharray={tick === 0 ? '4,3' : undefined}
                      />
                      <SvgText
                        x={PAD.left - 5}
                        y={y + 4}
                        fill="#9ca3af"
                        fontSize={9}
                        textAnchor="end"
                      >
                        {Math.round(tick)}
                      </SvgText>
                    </G>
                  );
                })}

                {/* X-axis date labels */}
                {xLabelIndices.map((i) => {
                  if (i >= displayedDays.length) return null;
                  const x = scaleX(i, N, containerWidth);
                  return (
                    <SvgText
                      key={`xlabel-${i}`}
                      x={x}
                      y={CHART_H - 4}
                      fill="#9ca3af"
                      fontSize={9}
                      textAnchor="middle"
                    >
                      {formatChartDate(displayedDays[i].date)}
                    </SvgText>
                  );
                })}

                {/* Confidence band (personalized only) */}
                {bandPath && (
                  <Path d={bandPath} fill="rgba(37,99,235,0.10)" stroke="none" />
                )}

                {/* ATL line (orange) */}
                <Path
                  d={atlPath}
                  stroke="#f97316"
                  strokeWidth={1.5}
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {/* CTL line (blue) */}
                <Path
                  d={ctlPath}
                  stroke="#2563eb"
                  strokeWidth={2.5}
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {/* TSB line (green, dashed) */}
                <Path
                  d={tsbPath}
                  stroke="#16a34a"
                  strokeWidth={1.5}
                  fill="none"
                  strokeDasharray="5,3"
                  strokeLinecap="round"
                />

                {/* Benchmark markers (purple diamond + dotted vertical) */}
                {visibleBenchmarks.map((bm) => {
                  const x = dateToX(bm.date);
                  if (x === null) return null;
                  const detail = `Score: ${bm.performance_score.toFixed(1)}`;
                  return (
                    <G
                      key={`bm-${bm.date}`}
                      onPress={() =>
                        setTooltip({ type: 'benchmark', x, date: bm.date, detail })
                      }
                    >
                      <Line
                        x1={x}
                        y1={PAD.top}
                        x2={x}
                        y2={CHART_H - PAD.bottom}
                        stroke="#7c3aed"
                        strokeWidth={1}
                        strokeDasharray="3,3"
                      />
                      {/* Diamond */}
                      <Polygon
                        points={`${x},${CHART_H - PAD.bottom - 14} ${x + 5},${CHART_H - PAD.bottom - 7} ${x},${CHART_H - PAD.bottom} ${x - 5},${CHART_H - PAD.bottom - 7}`}
                        fill="#7c3aed"
                      />
                      {/* Tap area */}
                      <Rect
                        x={x - 10}
                        y={PAD.top}
                        width={20}
                        height={CHART_H - PAD.top - PAD.bottom}
                        fill="transparent"
                        onPress={() =>
                          setTooltip({ type: 'benchmark', x, date: bm.date, detail })
                        }
                      />
                    </G>
                  );
                })}

                {/* Race markers (red flag + dotted vertical) */}
                {visibleRaces.map((race) => {
                  const x = dateToX(race.date);
                  if (x === null) return null;
                  const hrs = race.moving_time_seconds
                    ? (race.moving_time_seconds / 3600).toFixed(1) + 'h'
                    : '—';
                  const detail = `k_race ×${race.k_race_applied.toFixed(1)}  ${hrs}`;
                  return (
                    <G
                      key={`race-${race.date}`}
                      onPress={() =>
                        setTooltip({ type: 'race', x, date: race.date, detail })
                      }
                    >
                      <Line
                        x1={x}
                        y1={PAD.top}
                        x2={x}
                        y2={CHART_H - PAD.bottom}
                        stroke="#ef4444"
                        strokeWidth={1}
                        strokeDasharray="3,3"
                      />
                      {/* Flag triangle */}
                      <Polygon
                        points={`${x},${CHART_H - PAD.bottom - 16} ${x + 9},${CHART_H - PAD.bottom - 10} ${x},${CHART_H - PAD.bottom - 4}`}
                        fill="#ef4444"
                      />
                      {/* Tap area */}
                      <Rect
                        x={x - 10}
                        y={PAD.top}
                        width={20}
                        height={CHART_H - PAD.top - PAD.bottom}
                        fill="transparent"
                        onPress={() =>
                          setTooltip({ type: 'race', x, date: race.date, detail })
                        }
                      />
                    </G>
                  );
                })}

                {/* Y-axis border line */}
                <Line
                  x1={PAD.left}
                  y1={PAD.top}
                  x2={PAD.left}
                  y2={CHART_H - PAD.bottom}
                  stroke="#e5e7eb"
                  strokeWidth={1}
                />
              </Svg>

              {/* Floating tooltip — rendered outside Svg for proper stacking */}
              {tooltip && (
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: Math.min(
                      Math.max(tooltip.x - 56, PAD.left),
                      containerWidth - 120,
                    ),
                    top: 6,
                    backgroundColor: 'rgba(17,24,39,0.92)',
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    minWidth: 110,
                  }}
                >
                  <Text style={{ color: '#d1d5db', fontSize: 10, marginBottom: 2 }}>
                    {formatChartDate(tooltip.date)}
                  </Text>
                  <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '600' }}>
                    {tooltip.type === 'benchmark' ? '◆ Benchmark' : '⚑ Race'}
                  </Text>
                  <Text style={{ color: '#d1d5db', fontSize: 11, marginTop: 1 }}>
                    {tooltip.detail}
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      )}

      {/* Legend */}
      {!isEmpty && !loading && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            marginTop: 8,
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <LegendDot color="#2563eb" label="Fitness (CTL)" />
          <LegendDot color="#f97316" label="Fatigue (ATL)" dashed />
          <LegendDot color="#16a34a" label="Form (TSB)" dashed />
          {visibleBenchmarks.length > 0 && (
            <LegendDot color="#7c3aed" label="Benchmark" marker="diamond" />
          )}
          {visibleRaces.length > 0 && (
            <LegendDot color="#ef4444" label="Race" marker="flag" />
          )}
        </View>
      )}
    </View>
  );
}

// ── Legend dot ────────────────────────────────────────────────────────────────

function LegendDot({
  color,
  label,
  dashed,
  marker,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  marker?: 'diamond' | 'flag';
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {marker ? (
        <View
          style={{
            width: 8,
            height: 8,
            backgroundColor: color,
            transform: marker === 'diamond' ? [{ rotate: '45deg' }] : [],
          }}
        />
      ) : (
        <View
          style={{
            width: 16,
            height: dashed ? 0 : 2,
            borderBottomWidth: dashed ? 2 : 0,
            borderBottomColor: color,
            borderStyle: dashed ? 'dashed' : 'solid',
            backgroundColor: dashed ? undefined : color,
          }}
        />
      )}
      <Text style={{ fontSize: 10, color: '#6b7280' }}>{label}</Text>
    </View>
  );
}

// ── Default params helper ─────────────────────────────────────────────────────

function defaultParams(): AthleteParams {
  return {
    tc_fitness: 42,
    tc_fatigue: 7,
    r_squared: null,
    is_personalized: false,
    n_benchmarks: null,
    ci_tc_fitness_low: null,
    ci_tc_fitness_high: null,
    ci_tc_fatigue_low: null,
    ci_tc_fatigue_high: null,
    fitted_at: null,
  };
}
