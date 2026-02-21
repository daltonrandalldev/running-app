import { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BarChart } from 'react-native-chart-kit';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, MainTabParamList } from '../App';
import { supabase } from '../lib/supabase';

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Home'>,
  NativeStackScreenProps<RootStackParamList>
>;

type Activity = {
  id: number;
  name: string;
  start_time: string;
  activity_type: string | null;
  distance_km: number | null;
  duration_seconds: number | null;
  avg_pace_min_per_km: number | null;
  avg_hr: number | null;
  is_pr: boolean | null;
};

const SCREEN_WIDTH = Dimensions.get('window').width;
const CHART_WIDTH = SCREEN_WIDTH - 32;

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

// ── Chart config ──────────────────────────────────────────────────────────────

const CHART_CONFIG = {
  backgroundGradientFrom: '#ffffff',
  backgroundGradientTo: '#ffffff',
  decimalPlaces: 0,
  color: (opacity = 1) => `rgba(74, 144, 226, ${opacity})`,
  labelColor: (opacity = 1) => `rgba(107, 114, 128, ${opacity})`,
  propsForLabels: { fontSize: 10 },
  barPercentage: 0.7,
  propsForBackgroundLines: { strokeWidth: 0 },
};

// ── Chart components ──────────────────────────────────────────────────────────

function RunMileageChart({ activities }: { activities: Activity[] }) {
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

  return (
    <BarChart
      data={{ labels: weeks.map(weekLabel), datasets: [{ data }] }}
      width={CHART_WIDTH}
      height={200}
      yAxisLabel=""
      yAxisSuffix=""
      chartConfig={CHART_CONFIG}
      showValuesOnTopOfBars={false}
      fromZero
      withHorizontalLines={false}
      withVerticalLines={false}
      style={{ marginLeft: -16 }}
    />
  );
}

function CyclingTimeChart({ activities }: { activities: Activity[] }) {
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

  return (
    <BarChart
      data={{ labels: weeks.map(weekLabel), datasets: [{ data }] }}
      width={CHART_WIDTH}
      height={200}
      yAxisLabel=""
      yAxisSuffix=""
      chartConfig={CHART_CONFIG}
      showValuesOnTopOfBars={false}
      fromZero
      withHorizontalLines={false}
      withVerticalLines={false}
      style={{ marginLeft: -16 }}
    />
  );
}

function HRZoneChart() {
  return (
    <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="pulse-outline" size={32} color="#d1d5db" />
      <Text style={{ color: '#9ca3af', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
        HR Zone data not available.{'\n'}Add zone time columns to enable this chart.
      </Text>
    </View>
  );
}

// ── Chart Carousel ────────────────────────────────────────────────────────────

const CHART_CARDS = [
  { key: 'run', title: 'Weekly mileage' },
  { key: 'cycle', title: 'Weekly cycling time' },
  { key: 'zones', title: 'Time in zone' },
];

function ChartCarousel({ activities }: { activities: Activity[] }) {
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
            {item.key === 'zones' && <HRZoneChart />}
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
        {/* TSS tile — placeholder until tss column is added */}
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
          <Text style={{ fontSize: 26, fontWeight: '600', color: '#1a1a1a' }}>--</Text>
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
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('Activities');

  useEffect(() => {
    async function fetchData() {
      const tenWeeksAgo = new Date();
      tenWeeksAgo.setDate(tenWeeksAgo.getDate() - 70);

      const [chartRes, recentRes] = await Promise.all([
        supabase
          .from('activities')
          .select(
            'id, name, start_time, activity_type, distance_km, duration_seconds, avg_pace_min_per_km, avg_hr, is_pr'
          )
          .gte('start_time', tenWeeksAgo.toISOString())
          .order('start_time', { ascending: true }),
        supabase
          .from('activities')
          .select(
            'id, name, start_time, activity_type, distance_km, duration_seconds, avg_pace_min_per_km, avg_hr, is_pr'
          )
          .order('start_time', { ascending: false })
          .limit(10),
      ]);

      if (chartRes.data) setActivities(chartRes.data);
      if (recentRes.data) setRecentActivities(recentRes.data);
      setLoading(false);
    }

    fetchData();
  }, []);

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
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: '#e5e7eb',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="person" size={20} color="#6b7280" />
        </View>
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
          <ChartCarousel activities={activities} />
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
    </SafeAreaView>
  );
}
