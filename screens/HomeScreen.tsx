import { useState, useEffect, useCallback, useRef } from 'react';
import Svg, { Path, Line, Text as SvgText } from 'react-native-svg';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Dimensions,
  NativeSyntheticEvent,
  NativeScrollEvent,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, MainTabParamList } from '../App';
import { supabase } from '../lib/supabase';
import { triggerSync } from '../lib/syncApi';
import { loadHRZones, getZoneForHR, type HRZones } from '../lib/hrZones';
import { computeActivityDecouplingBatch } from '../lib/decouplingRecalc';

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Home'>,
  NativeStackScreenProps<RootStackParamList>
>;

const SCREEN_WIDTH = Dimensions.get('window').width;

type PMCDay = {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
};

const PMC_START_DATE_KEY = 'pmc_filter_start_v1';

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function defaultStartStr(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().split('T')[0];
}

// YYYY-MM-DD → MM/DD/YYYY for display
function toDisplay(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return iso;
  const [y, m, d] = parts;
  return `${m}/${d}/${y}`;
}

// MM/DD/YYYY → YYYY-MM-DD for storage; returns null if invalid
function toISO(display: string): string | null {
  const parts = display.replace(/\s/g, '').split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts;
  if (y.length !== 4 || isNaN(Number(m)) || isNaN(Number(d)) || isNaN(Number(y))) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function MetricChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ alignItems: 'center', marginLeft: 12 }}>
      <Text style={{ fontSize: 10, color: '#9ca3af' }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '700', color }}>{value}</Text>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 16, height: 2.5, backgroundColor: color, borderRadius: 2 }} />
      <Text style={{ fontSize: 10, color: '#6b7280' }}>{label}</Text>
    </View>
  );
}

function PMCChart({
  data,
  startDate,
  endDate,
  onEditDates,
}: {
  data: PMCDay[];
  startDate: string;
  endDate: string;
  onEditDates: () => void;
}) {
  if (data.length < 2) return null;

  const CHART_W = SCREEN_WIDTH - 32;
  const CHART_H = 180;
  const PAD_L = 28;
  const PAD_B = 22;
  const PAD_T = 8;
  const PAD_R = 8;
  const PLOT_W = CHART_W - PAD_L - PAD_R;
  const PLOT_H = CHART_H - PAD_B - PAD_T;

  const maxY = Math.max(...data.map((d) => Math.max(d.ctl, d.atl)), 1);
  const minY = Math.min(...data.map((d) => d.tsb), 0);
  const range = maxY - minY || 1;

  const xScale = (i: number) => PAD_L + (i / (data.length - 1)) * PLOT_W;
  const yScale = (v: number) => PAD_T + PLOT_H - ((v - minY) / range) * PLOT_H;

  const makePath = (getter: (d: PMCDay) => number) =>
    data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(getter(d)).toFixed(1)}`)
      .join(' ');

  const xLabelStep = Math.ceil(data.length / 4);
  const xLabelIndices: number[] = [];
  for (let i = 0; i < data.length; i += xLabelStep) xLabelIndices.push(i);
  if (xLabelIndices[xLabelIndices.length - 1] !== data.length - 1) {
    xLabelIndices.push(data.length - 1);
  }

  const yTicks = [Math.round(maxY), Math.round(maxY / 2), 0];
  if (minY < -1) yTicks.push(Math.round(minY));

  const latest = data[data.length - 1];
  const tsbColor = latest.tsb >= 5 ? '#2d7a2d' : latest.tsb >= -10 ? '#6b7280' : '#dc2626';

  return (
    <View style={{ marginHorizontal: 16, marginTop: 16, marginBottom: 4 }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: '#111827', flex: 1 }}>
          Performance
        </Text>
        <MetricChip label="Fitness" value={latest.ctl.toFixed(0)} color="#6699cc" />
        <MetricChip label="Fatigue" value={latest.atl.toFixed(0)} color="#7b5ea7" />
        <MetricChip
          label="Form"
          value={(latest.tsb >= 0 ? '+' : '') + latest.tsb.toFixed(0)}
          color={tsbColor}
        />
      </View>

      {/* Date range row */}
      <TouchableOpacity
        onPress={onEditDates}
        style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}
      >
        <Ionicons name="calendar-outline" size={13} color="#9ca3af" style={{ marginRight: 4 }} />
        <Text style={{ fontSize: 12, color: '#9ca3af' }}>
          {toDisplay(startDate)} → {toDisplay(endDate)}
        </Text>
        <Ionicons name="pencil-outline" size={12} color="#9ca3af" style={{ marginLeft: 5 }} />
      </TouchableOpacity>

      {/* SVG */}
      <Svg width={CHART_W} height={CHART_H}>
        {/* Gridlines */}
        {yTicks.map((v) => (
          <Line
            key={`g${v}`}
            x1={PAD_L} y1={yScale(v)}
            x2={PAD_L + PLOT_W} y2={yScale(v)}
            stroke="#f3f4f6" strokeWidth={1}
          />
        ))}
        {/* Zero line (TSB reference) */}
        <Line
          x1={PAD_L} y1={yScale(0)}
          x2={PAD_L + PLOT_W} y2={yScale(0)}
          stroke="#d1d5db" strokeWidth={1} strokeDasharray="4,3"
        />
        {/* Y labels */}
        {yTicks.map((v) => (
          <SvgText
            key={`y${v}`}
            x={PAD_L - 4} y={yScale(v) + 3.5}
            fontSize={8} fill="#9ca3af" textAnchor="end"
          >{v}</SvgText>
        ))}
        {/* ATL (behind CTL) */}
        <Path d={makePath((d) => d.atl)} stroke="#7b5ea7" strokeWidth={1.5} fill="none" />
        {/* CTL */}
        <Path d={makePath((d) => d.ctl)} stroke="#6699cc" strokeWidth={2.5} fill="none" />
        {/* TSB */}
        <Path d={makePath((d) => d.tsb)} stroke="#2d7a2d" strokeWidth={1.5} fill="none" />
        {/* X labels */}
        {xLabelIndices.map((i) => (
          <SvgText
            key={`x${i}`}
            x={xScale(i)} y={CHART_H - 4}
            fontSize={8} fill="#9ca3af" textAnchor="middle"
          >{formatDateLabel(data[i].date)}</SvgText>
        ))}
      </Svg>

      {/* Legend */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 4 }}>
        <LegendDot color="#6699cc" label="Fitness (CTL)" />
        <LegendDot color="#7b5ea7" label="Fatigue (ATL)" />
        <LegendDot color="#2d7a2d" label="Form (TSB)" />
      </View>
    </View>
  );
}

type Activity = {
  id: string;
  name: string;
  start_time: string;
  activity_type: string | null;
  distance_km: number | null;
  duration_seconds: number | null;
  avg_pace_min_per_km: number | null;
  avg_hr: number | null;
  is_pr: boolean | null;
  active_load: number | null;
  hr_tss: number | null;
};

const GARMIN_ACTIVITY_SELECT =
  'activity_id, name, start_time, sport, distance, moving_time_seconds, elapsed_time_seconds, avg_pace_seconds, avg_hr, active_load, hr_tss';

function toActivity(row: any): Activity {
  return {
    id: row.activity_id,
    name: row.name,
    start_time: row.start_time,
    activity_type: row.sport,
    distance_km: row.distance,
    duration_seconds: row.moving_time_seconds ?? row.elapsed_time_seconds,
    avg_pace_min_per_km: row.avg_pace_seconds != null ? row.avg_pace_seconds / 60 : null,
    avg_hr: row.avg_hr,
    is_pr: null,
    active_load: row.active_load,
    hr_tss: row.hr_tss,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLast10WeekStarts(): Date[] {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  const weeks: Date[] = [];
  for (let i = 9; i >= 0; i--) {
    const d = new Date(monday);
    d.setDate(monday.getDate() - i * 7);
    weeks.push(d);
  }
  return weeks;
}

function weekLabel(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekEnd(start: Date): Date {
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d;
}

function kmToMiles(km: number) {
  return km * 0.621371;
}

function secondsToHours(s: number) {
  return s / 3600;
}

// Always HH:MM:SS
function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatPace(minPerKm: number) {
  const minPerMile = minPerKm * 1.60934;
  const min = Math.floor(minPerMile);
  const sec = Math.round((minPerMile - min) * 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function isRunActivity(type: string | null) {
  return type?.toLowerCase().includes('run') ?? false;
}

function isCyclingActivity(type: string | null) {
  const t = type?.toLowerCase() ?? '';
  return t.includes('cycl') || t.includes('bike') || t.includes('ride');
}

function activityTypeLabel(type: string | null): string {
  if (!type) return 'Activity';
  const t = type.toLowerCase();
  if (t === 'trail_run' || t === 'trailrun' || t === 'trail run') return 'Trail run';
  if (t.includes('run')) return 'Run';
  if (t === 'virtual_ride' || t === 'indoor_cycling' || t === 'virtualride') return 'Indoor cycling';
  if (t.includes('cycl') || t.includes('bike') || t.includes('ride')) return 'Cycling';
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

// ── Chart components ──────────────────────────────────────────────────────────

const BAR_COLOR = '#4a90e2';
const BAR_MAX_HEIGHT = 150;
const ZONE_BAR_MAX_HEIGHT = 120;

function BarTooltip({ value, barHeight }: { value: string; barHeight: number }) {
  return (
    <View
      style={{
        position: 'absolute',
        bottom: barHeight + 6,
        left: -40,
        right: -40,
        alignItems: 'center',
        zIndex: 20,
      }}
    >
      <View style={{ backgroundColor: '#111827', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 }}>
        <Text style={{ color: 'white', fontSize: 10, fontWeight: '600' }}>{value}</Text>
      </View>
    </View>
  );
}

function RunMileageChart({ activities }: { activities: Activity[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const weeks = getLast10WeekStarts();
  const data = weeks.map((start) => {
    const end = weekEnd(start);
    return activities
      .filter(
        (a) =>
          isRunActivity(a.activity_type) &&
          new Date(a.start_time) >= start &&
          new Date(a.start_time) < end
      )
      .reduce((sum, a) => sum + kmToMiles(a.distance_km ?? 0), 0);
  });
  const max = Math.max(...data, 1);

  return (
    <View style={{ height: 200 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 4, height: BAR_MAX_HEIGHT, overflow: 'visible' }}>
        {data.map((value, i) => {
          const barHeight = value > 0 ? Math.max((value / max) * BAR_MAX_HEIGHT, 4) : 0;
          const isSelected = selected === i;
          return (
            <TouchableOpacity
              key={i}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: BAR_MAX_HEIGHT }}
              onPress={() => setSelected(isSelected ? null : i)}
              activeOpacity={0.7}
            >
              {isSelected && barHeight > 0 && (
                <BarTooltip value={`${value.toFixed(1)} mi`} barHeight={barHeight} />
              )}
              <View style={{ width: '70%', height: barHeight, backgroundColor: BAR_COLOR, borderRadius: 3 }} />
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 4, paddingTop: 6 }}>
        {weeks.map((w, i) => (
          <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 8, color: '#9ca3af' }}>
            {weekLabel(w)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function CyclingTimeChart({ activities }: { activities: Activity[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const weeks = getLast10WeekStarts();
  const data = weeks.map((start) => {
    const end = weekEnd(start);
    return activities
      .filter(
        (a) =>
          isCyclingActivity(a.activity_type) &&
          new Date(a.start_time) >= start &&
          new Date(a.start_time) < end
      )
      .reduce((sum, a) => sum + secondsToHours(a.duration_seconds ?? 0), 0);
  });
  const max = Math.max(...data, 1);

  function formatHours(h: number) {
    const hrs = Math.floor(h);
    const mins = Math.round((h - hrs) * 60);
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  }

  return (
    <View style={{ height: 200 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 4, height: BAR_MAX_HEIGHT, overflow: 'visible' }}>
        {data.map((value, i) => {
          const barHeight = value > 0 ? Math.max((value / max) * BAR_MAX_HEIGHT, 4) : 0;
          const isSelected = selected === i;
          return (
            <TouchableOpacity
              key={i}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: BAR_MAX_HEIGHT }}
              onPress={() => setSelected(isSelected ? null : i)}
              activeOpacity={0.7}
            >
              {isSelected && barHeight > 0 && (
                <BarTooltip value={formatHours(value)} barHeight={barHeight} />
              )}
              <View style={{ width: '70%', height: barHeight, backgroundColor: BAR_COLOR, borderRadius: 3 }} />
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 4, paddingTop: 6 }}>
        {weeks.map((w, i) => (
          <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 8, color: '#9ca3af' }}>
            {weekLabel(w)}
          </Text>
        ))}
      </View>
    </View>
  );
}

const HR_ZONE_COLORS = ['#60a5fa', '#22c55e', '#eab308', '#f97316', '#ef4444'];

type ZoneSelection = { weekIdx: number; zoneIdx: number } | null;

function HRZoneChart({
  activities,
  hrZones,
}: {
  activities: Activity[];
  hrZones: HRZones | null;
}) {
  const [selected, setSelected] = useState<ZoneSelection>(null);

  if (!hrZones) {
    return (
      <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="heart-outline" size={32} color="#d1d5db" />
        <Text style={{ color: '#9ca3af', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
          Set your HR zones in Key Metrics{'\n'}to see time in zone.
        </Text>
      </View>
    );
  }

  const weeks = getLast10WeekStarts();

  const weekData = weeks.map((start) => {
    const end = weekEnd(start);
    const zoneMins = [0, 0, 0, 0, 0];
    for (const a of activities) {
      if (a.avg_hr == null || a.duration_seconds == null) continue;
      const t = new Date(a.start_time);
      if (t < start || t >= end) continue;
      const zone = getZoneForHR(a.avg_hr, hrZones);
      if (zone != null) {
        zoneMins[zone - 1] += a.duration_seconds / 60;
      }
    }
    return zoneMins;
  });

  const weekTotals = weekData.map((z) => z.reduce((a, b) => a + b, 0));
  const maxTotal = Math.max(...weekTotals, 1);
  const hasAnyData = weekTotals.some((t) => t > 0);

  function formatMins(mins: number) {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return (
    <View style={{ height: 200 }}>
      {/* Legend */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 8 }}>
        {HR_ZONE_COLORS.map((color, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
            <Text style={{ fontSize: 10, color: '#6b7280' }}>Z{i + 1}</Text>
          </View>
        ))}
      </View>

      {/* Bars */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 4, height: ZONE_BAR_MAX_HEIGHT, overflow: 'visible' }}>
        {weekData.map((zoneMins, weekIdx) => {
          const total = weekTotals[weekIdx];
          const barHeight = total > 0 ? Math.max((total / maxTotal) * ZONE_BAR_MAX_HEIGHT, 4) : 0;
          const selZone = selected?.weekIdx === weekIdx ? selected.zoneIdx : null;

          return (
            <View
              key={weekIdx}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: ZONE_BAR_MAX_HEIGHT }}
            >
              {/* Tooltip — sits above the bar, outside overflow:hidden */}
              {selZone !== null && barHeight > 0 && (
                <View
                  style={{
                    position: 'absolute',
                    bottom: barHeight + 6,
                    left: -40,
                    right: -40,
                    alignItems: 'center',
                    zIndex: 20,
                  }}
                >
                  <View style={{ backgroundColor: '#111827', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: HR_ZONE_COLORS[selZone] }}>
                      Z{selZone + 1}: {formatMins(zoneMins[selZone])}
                    </Text>
                  </View>
                </View>
              )}

              {/* Stacked bar — each segment is individually tappable */}
              <View
                style={{
                  width: '70%',
                  height: barHeight,
                  flexDirection: 'column-reverse',
                  overflow: 'hidden',
                  borderRadius: 3,
                }}
              >
                {zoneMins.map((mins, zoneIdx) => {
                  if (mins === 0 || total === 0) return null;
                  const isThisSeg = selZone === zoneIdx;
                  const anySelInWeek = selZone !== null;
                  return (
                    <TouchableOpacity
                      key={zoneIdx}
                      activeOpacity={0.8}
                      onPress={() =>
                        setSelected(isThisSeg ? null : { weekIdx, zoneIdx })
                      }
                      style={{
                        width: '100%',
                        height: (mins / total) * barHeight,
                        backgroundColor: HR_ZONE_COLORS[zoneIdx],
                        opacity: anySelInWeek && !isThisSeg ? 0.35 : 1,
                      }}
                    />
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>

      {/* Week labels */}
      <View style={{ flexDirection: 'row', paddingHorizontal: 4, paddingTop: 5 }}>
        {weeks.map((w, i) => (
          <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 8, color: '#9ca3af' }}>
            {weekLabel(w)}
          </Text>
        ))}
      </View>

      {!hasAnyData && (
        <Text style={{ textAlign: 'center', color: '#9ca3af', fontSize: 12, marginTop: 4 }}>
          No HR data in the last 10 weeks.
        </Text>
      )}
    </View>
  );
}

// ── Chart Carousel ────────────────────────────────────────────────────────────

const CHART_CARDS = [
  { key: 'run', title: 'Weekly mileage' },
  { key: 'cycle', title: 'Weekly cycling time' },
  { key: 'zones', title: 'Time in zone' },
];

function ChartCarousel({ activities, hrZones }: { activities: Activity[]; hrZones: HRZones | null }) {
  const [activeIndex, setActiveIndex] = useState(0);

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setActiveIndex(idx);
  }

  return (
    <View style={{ paddingTop: 20, paddingBottom: 16 }}>
      <FlatList
        data={CHART_CARDS}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.key}
        onScroll={onScroll}
        scrollEventThrottle={16}
        renderItem={({ item }) => (
          <View style={{ width: SCREEN_WIDTH, paddingHorizontal: 16 }}>
            <Text
              style={{
                fontSize: 17,
                fontWeight: '700',
                textAlign: 'center',
                marginBottom: 14,
                color: '#111827',
              }}
            >
              {item.title}
            </Text>
            {item.key === 'run' && <RunMileageChart activities={activities} />}
            {item.key === 'cycle' && <CyclingTimeChart activities={activities} />}
            {item.key === 'zones' && <HRZoneChart activities={activities} hrZones={hrZones} />}
          </View>
        )}
      />
      {/* Pagination dots */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 14 }}>
        {CHART_CARDS.map((_, i) => (
          <View
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: i === activeIndex ? '#111827' : '#d1d5db',
            }}
          />
        ))}
      </View>
    </View>
  );
}

// ── Activity Row ──────────────────────────────────────────────────────────────

function ActivityRow({
  activity,
  onPress,
}: {
  activity: Activity;
  onPress: () => void;
}) {
  const isRun = isRunActivity(activity.activity_type);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        {/* TSS tile */}
        <View
          style={{
            width: 64,
            height: 64,
            backgroundColor: '#E8F0FE',
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
          }}
        >
          <Text style={{ fontSize: 26, fontWeight: '600', color: '#1a1a1a' }}>
            {activity.active_load != null ? Math.round(activity.active_load) : '--'}
          </Text>
        </View>

        {/* Description */}
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, color: '#9ca3af', marginBottom: 3 }}>
            {activityTypeLabel(activity.activity_type)}
          </Text>
          {activity.distance_km != null && (
            <Text style={{ fontSize: 14, color: '#111827' }}>
              {kmToMiles(activity.distance_km).toFixed(1)} mi
            </Text>
          )}
          {activity.avg_pace_min_per_km != null && isRun && (
            <Text style={{ fontSize: 14, color: '#111827' }}>
              Avg pace: {formatPace(activity.avg_pace_min_per_km)}
            </Text>
          )}
          {activity.avg_hr != null && (
            <Text style={{ fontSize: 14, color: '#111827' }}>Avg HR: {activity.avg_hr}</Text>
          )}
        </View>

        {/* Duration */}
        <Text style={{ fontSize: 14, color: '#111827', paddingTop: 22 }}>
          {activity.duration_seconds ? formatDuration(activity.duration_seconds) : '--'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Pill tabs ─────────────────────────────────────────────────────────────────

const PILL_TABS = [
  { label: 'Key metrics', icon: 'document-text-outline' as const },
  { label: 'Activities', icon: 'time-outline' as const },
  { label: 'Training score', icon: 'notifications-outline' as const },
];

// ── HomeScreen ────────────────────────────────────────────────────────────────

export default function HomeScreen({ navigation }: Props) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [recentActivities, setRecentActivities] = useState<Activity[]>([]);
  const [pmcData, setPmcData] = useState<PMCDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState('Activities');
  const [hrZones, setHrZones] = useState<HRZones | null>(null);

  const [pmcStartDate, setPmcStartDate] = useState('');
  const [pmcEndDate, setPmcEndDate] = useState(todayStr());
  const [pmcFilterVisible, setPmcFilterVisible] = useState(false);
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');

  // Keep a ref to the current pmcStartDate/pmcEndDate so fetchPMC doesn't need them as deps
  const pmcRangeRef = useRef({ start: '', end: todayStr() });
  pmcRangeRef.current = { start: pmcStartDate, end: pmcEndDate };

  // Reload HR zones whenever this screen comes into focus (e.g. after editing in Key Metrics)
  useFocusEffect(
    useCallback(() => {
      loadHRZones().then((z) => setHrZones(z));
    }, [])
  );

  // Load persisted start date once on mount
  useEffect(() => {
    AsyncStorage.getItem(PMC_START_DATE_KEY).then((saved) => {
      setPmcStartDate(saved ?? defaultStartStr());
    });
  }, []);

  const fetchActivities = useCallback(async () => {
    const tenWeeksAgo = new Date();
    tenWeeksAgo.setDate(tenWeeksAgo.getDate() - 70);

    const [chartRes, recentRes] = await Promise.all([
      supabase
        .from('garmin_activities')
        .select(GARMIN_ACTIVITY_SELECT)
        .gte('start_time', tenWeeksAgo.toISOString())
        .order('start_time', { ascending: true }),
      supabase
        .from('garmin_activities')
        .select(GARMIN_ACTIVITY_SELECT)
        .order('start_time', { ascending: false })
        .limit(10),
    ]);

    if (chartRes.data) setActivities(chartRes.data.map(toActivity));
    if (recentRes.data) setRecentActivities(recentRes.data.map(toActivity));
  }, []);

  // Fetch activities on mount
  useEffect(() => {
    fetchActivities().then(() => setLoading(false));
  }, [fetchActivities]);

  const fetchPMC = useCallback(() => {
    const { start, end } = pmcRangeRef.current;
    if (!start) return;
    supabase
      .from('pmc_daily')
      .select('date, ctl, atl, tsb')
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true })
      .then(({ data }) => {
        if (data) setPmcData(data);
      });
  }, []);

  // Re-fetch PMC data whenever the date range changes
  useEffect(() => {
    fetchPMC();
  }, [pmcStartDate, pmcEndDate, fetchPMC]);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    const result = await triggerSync();
    setSyncing(false);
    if (result.ok) {
      // Step 2: Decoupling pipeline — run on activities synced since yesterday
      try {
        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);

        const { data: recentActivities } = await supabase
          .from('garmin_activities')
          .select('activity_id')
          .gte('start_time', yesterdayStr)
          .order('start_time', { ascending: false });

        const newActivityIds = (recentActivities ?? []).map(
          (r: { activity_id: string | number }) => r.activity_id,
        );

        const decResult = await computeActivityDecouplingBatch(newActivityIds);
        if (!decResult.ok) {
          console.warn('[Sync] Decoupling batch failed:', decResult);
        }
      } catch (decErr: any) {
        console.warn('[Sync] Decoupling batch error:', decErr?.message ?? decErr);
      }

      await fetchActivities();
      fetchPMC();
    } else if (result.error?.toLowerCase().includes('reachable')) {
      Alert.alert(
        'Sync server not running',
        'Run this once in the project directory to set it up:\n\npython3 setup_sync_server.py\n\nAfter that the server starts automatically at login.',
      );
    } else {
      const step = (result as any).failed_step;
      const detail = (result as any).results?.[step]?.output ?? result.error ?? 'Unknown error';
      Alert.alert(
        'Sync failed' + (step ? ` (${step})` : ''),
        detail.slice(-300),
      );
    }
  }, [syncing, fetchActivities, fetchPMC]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#ffffff' }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <TouchableOpacity style={{ padding: 4 }}>
          <Ionicons name="menu" size={24} color="#111827" />
        </TouchableOpacity>
        <Text
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 18,
            fontWeight: '700',
            color: '#111827',
          }}
        >
          Trainer
        </Text>
        <TouchableOpacity
          onPress={handleSync}
          disabled={syncing}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: syncing ? '#dbeafe' : '#e5e7eb',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {syncing ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <Ionicons name="cloud-download-outline" size={20} color="#6b7280" />
          )}
        </TouchableOpacity>
      </View>

      {/* Pill tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ height: 52 }}
        contentContainerStyle={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          height: 52,
        }}
      >
        {PILL_TABS.map((tab, index) => {
          const isActive = tab.label === activeTab;
          return (
            <TouchableOpacity
              key={tab.label}
              onPress={() => {
                if (tab.label === 'Key metrics') {
                  navigation.navigate('KeyMetrics');
                } else {
                  setActiveTab(tab.label);
                }
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: 36,
                paddingHorizontal: 14,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: isActive ? '#111827' : '#d1d5db',
                marginRight: index < PILL_TABS.length - 1 ? 8 : 0,
              }}
            >
              <Ionicons
                name={tab.icon}
                size={15}
                color={isActive ? '#111827' : '#9ca3af'}
                style={{ marginRight: 6 }}
              />
              <Text style={{ fontSize: 14, lineHeight: 36, color: isActive ? '#111827' : '#6b7280' }}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Top divider */}
      <View style={{ height: 1, backgroundColor: '#f3f4f6' }} />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Charts */}
        {loading ? (
          <View style={{ height: 260, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color="#4A90E2" />
          </View>
        ) : (
          <ChartCarousel activities={activities} hrZones={hrZones} />
        )}

        {/* PMC Chart */}
        {!loading && pmcStartDate !== '' && pmcData.length > 0 && (
          <View>
            <View style={{ height: 1, backgroundColor: '#f3f4f6', marginTop: 4 }} />
            <PMCChart
              data={pmcData}
              startDate={pmcStartDate}
              endDate={pmcEndDate}
              onEditDates={() => {
                setDraftStart(toDisplay(pmcStartDate));
                setDraftEnd(toDisplay(pmcEndDate));
                setPmcFilterVisible(true);
              }}
            />
          </View>
        )}

        {/* Section divider */}
        <View style={{ height: 1, backgroundColor: '#f3f4f6', marginTop: 4 }} />

        {/* Activities heading */}
        <Text
          style={{
            fontSize: 34,
            fontWeight: '700',
            textAlign: 'center',
            marginTop: 20,
            marginBottom: 12,
            color: '#111827',
          }}
        >
          Activities
        </Text>

        {/* Column headers */}
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 16,
            paddingBottom: 8,
          }}
        >
          <Text style={{ width: 78, fontSize: 13, color: '#6b7280' }}>TSS</Text>
          <Text style={{ flex: 1, fontSize: 13, color: '#6b7280' }}>Description</Text>
          <Text style={{ fontSize: 13, color: '#6b7280' }}>Time</Text>
        </View>

        {/* Activity rows */}
        {loading ? (
          <ActivityIndicator
            size="large"
            color="#4A90E2"
            style={{ marginTop: 24 }}
          />
        ) : recentActivities.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 32 }}>
            <Ionicons name="walk-outline" size={36} color="#d1d5db" />
            <Text style={{ color: '#9ca3af', marginTop: 8, fontSize: 14 }}>
              No activities logged yet
            </Text>
          </View>
        ) : (
          recentActivities.map((a) => (
            <ActivityRow
              key={a.id}
              activity={a}
              onPress={() => navigation.navigate('ActivityDetail', { activityId: a.id })}
            />
          ))
        )}

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Date range modal */}
      <Modal
        visible={pmcFilterVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPmcFilterVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View
            style={{
              backgroundColor: '#fff',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 24,
              paddingBottom: 40,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: -2 },
              shadowOpacity: 0.1,
              shadowRadius: 8,
              elevation: 10,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: '700', color: '#111827', marginBottom: 20 }}>
              Edit Date Range
            </Text>

            {/* Start date */}
            <Text style={{ fontSize: 13, color: '#6b7280', marginBottom: 6 }}>Start date</Text>
            <TextInput
              value={draftStart}
              onChangeText={setDraftStart}
              placeholder="MM/DD/YYYY"
              keyboardType="numbers-and-punctuation"
              style={{
                borderWidth: 1,
                borderColor: '#d1d5db',
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
                color: '#111827',
                marginBottom: 16,
              }}
            />

            {/* End date */}
            <Text style={{ fontSize: 13, color: '#6b7280', marginBottom: 6 }}>End date</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24 }}>
              <TextInput
                value={draftEnd}
                onChangeText={setDraftEnd}
                placeholder="MM/DD/YYYY"
                keyboardType="numbers-and-punctuation"
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: '#d1d5db',
                  borderRadius: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  fontSize: 15,
                  color: '#111827',
                }}
              />
              <TouchableOpacity
                onPress={() => setDraftEnd(toDisplay(todayStr()))}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: '#d1d5db',
                }}
              >
                <Text style={{ fontSize: 14, color: '#6b7280' }}>Today</Text>
              </TouchableOpacity>
            </View>

            {/* Buttons */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                onPress={() => setPmcFilterVisible(false)}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: '#d1d5db',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 15, color: '#6b7280' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  const isoStart = toISO(draftStart);
                  const isoEnd = toISO(draftEnd);
                  if (!isoStart || !isoEnd || isoStart > isoEnd) return;
                  setPmcStartDate(isoStart);
                  setPmcEndDate(isoEnd);
                  AsyncStorage.setItem(PMC_START_DATE_KEY, isoStart);
                  setPmcFilterVisible(false);
                }}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: '#111827',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
