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
import { Ionicons } from '@expo/vector-icons';
import { BarChart } from 'react-native-chart-kit';
import type { DrawerScreenProps } from '@react-navigation/drawer';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { supabase } from '../lib/supabase';

type Props = CompositeScreenProps<
  DrawerScreenProps<any, 'Home'>,
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
const CHART_WIDTH = SCREEN_WIDTH - 32; // 16px padding each side


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

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
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

const CHART_CONFIG_BASE = {
  backgroundGradientFrom: '#ffffff',
  backgroundGradientTo: '#ffffff',
  decimalPlaces: 1,
  color: (opacity = 1) => `rgba(0,0,0,${opacity})`,
  labelColor: (opacity = 1) => `rgba(107,114,128,${opacity})`,
  style: { borderRadius: 12 },
  propsForLabels: { fontSize: 9 },
  barPercentage: 0.6,
};

// --- Chart 1: Weekly Running Mileage ---
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
    <View>
      <BarChart
        data={{
          labels: weeks.map(weekLabel),
          datasets: [{ data }],
        }}
        width={CHART_WIDTH}
        height={200}
        yAxisLabel=""
        yAxisSuffix=" mi"
        chartConfig={{
          ...CHART_CONFIG_BASE,
          color: (opacity = 1) => `rgba(16,185,129,${opacity})`,
        }}
        style={{ borderRadius: 12 }}
        showValuesOnTopOfBars={false}
        fromZero
      />
    </View>
  );
}

// --- Chart 2: Weekly Cycling Time ---
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
    <View>
      <BarChart
        data={{
          labels: weeks.map(weekLabel),
          datasets: [{ data }],
        }}
        width={CHART_WIDTH}
        height={200}
        yAxisLabel=""
        yAxisSuffix=" h"
        chartConfig={{
          ...CHART_CONFIG_BASE,
          color: (opacity = 1) => `rgba(249,115,22,${opacity})`,
        }}
        style={{ borderRadius: 12 }}
        showValuesOnTopOfBars={false}
        fromZero
      />
    </View>
  );
}

// --- Chart 3: Weekly HR Zone Time (placeholder — no zone data in DB yet) ---
function HRZoneChart({ activities: _activities }: { activities: Activity[] }) {
  return (
    <View className="h-48 items-center justify-center gap-2">
      <Ionicons name="pulse-outline" size={32} color="#d1d5db" />
      <Text className="text-sm text-gray-400 text-center">
        HR Zone data not available.{'\n'}Add zone time columns to enable this chart.
      </Text>
    </View>
  );
}


// --- Chart Carousel ---
const CHART_CARDS = [
  { key: 'run', title: 'Weekly Running Mileage', subtitle: 'Miles per week' },
  { key: 'cycle', title: 'Weekly Cycling Time', subtitle: 'Hours per week' },
  { key: 'zones', title: 'Training Time by HR Zone', subtitle: 'Hours per zone' },
];

function ChartCarousel({ activities }: { activities: Activity[] }) {
  const [activeIndex, setActiveIndex] = useState(0);

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setActiveIndex(idx);
  }

  return (
    <View className="mb-6">
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
            <View className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
              <Text className="text-sm font-semibold text-gray-800 mb-0.5">{item.title}</Text>
              <Text className="text-xs text-gray-400 mb-3">{item.subtitle}</Text>
              {item.key === 'run' && <RunMileageChart activities={activities} />}
              {item.key === 'cycle' && <CyclingTimeChart activities={activities} />}
              {item.key === 'zones' && <HRZoneChart activities={activities} />}
            </View>
          </View>
        )}
      />
      {/* Pagination dots */}
      <View className="flex-row justify-center gap-1.5 mt-3">
        {CHART_CARDS.map((_, i) => (
          <View
            key={i}
            className="rounded-full"
            style={{
              width: i === activeIndex ? 16 : 6,
              height: 6,
              backgroundColor: i === activeIndex ? '#10b981' : '#d1d5db',
            }}
          />
        ))}
      </View>
    </View>
  );
}

// --- Activity Card ---
function ActivityCard({
  activity,
  onPress,
}: {
  activity: Activity;
  onPress: () => void;
}) {
  const running = isRunActivity(activity.activity_type);
  const borderColor = running ? '#10b981' : '#f97316';
  const iconName = running ? 'footsteps-outline' : 'bicycle-outline';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-3"
    >
      {/* Colored left border strip */}
      <View className="flex-row">
        <View style={{ width: 4, backgroundColor: borderColor }} />
        <View className="flex-1 p-4">
          {/* Top row: icon + name + date */}
          <View className="flex-row items-center mb-2">
            <Ionicons name={iconName as any} size={18} color={borderColor} />
            <Text className="flex-1 text-sm font-semibold text-gray-800 ml-2" numberOfLines={1}>
              {activity.name || (running ? 'Run' : 'Ride')}
            </Text>
            {activity.is_pr && (
              <View className="bg-yellow-50 border border-yellow-300 rounded-full px-2 py-0.5 ml-2">
                <Text className="text-xs font-bold text-yellow-700">PR</Text>
              </View>
            )}
          </View>

          {/* Date */}
          <Text className="text-xs text-gray-400 mb-3">
            {new Date(activity.start_time).toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </Text>

          {/* Stats row */}
          <View className="flex-row flex-wrap gap-x-4 gap-y-1">
            {activity.distance_km != null && (
              <StatPill
                value={`${kmToMiles(activity.distance_km).toFixed(2)} mi`}
                icon="map-outline"
              />
            )}
            {activity.duration_seconds != null && (
              <StatPill value={formatDuration(activity.duration_seconds)} icon="time-outline" />
            )}
            {activity.avg_pace_min_per_km != null && running && (
              <StatPill value={`${formatPace(activity.avg_pace_min_per_km)} /mi`} icon="speedometer-outline" />
            )}
            {activity.avg_hr != null && (
              <StatPill value={`${activity.avg_hr} bpm`} icon="heart-outline" />
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function StatPill({ value, icon }: { value: string; icon: string }) {
  return (
    <View className="flex-row items-center gap-0.5">
      <Ionicons name={icon as any} size={11} color="#9ca3af" />
      <Text className="text-xs text-gray-600">{value}</Text>
    </View>
  );
}

// --- Main HomeScreen ---
export default function HomeScreen({ navigation }: Props) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [recentActivities, setRecentActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

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
          .limit(3),
      ]);

      if (chartRes.data) setActivities(chartRes.data);
      if (recentRes.data) setRecentActivities(recentRes.data);
      setLoading(false);
    }

    fetchData();
  }, []);

  return (
    <ScrollView className="flex-1 bg-gray-50" showsVerticalScrollIndicator={false}>
      <View className="pt-5 pb-12">

        {/* Chart Carousel */}
        {loading ? (
          <View className="mx-4 bg-white rounded-2xl border border-gray-100 h-64 items-center justify-center mb-6">
            <ActivityIndicator size="large" color="#10b981" />
            <Text className="text-xs text-gray-400 mt-3">Loading charts…</Text>
          </View>
        ) : (
          <ChartCarousel activities={activities} />
        )}

        {/* Recent Activities */}
        <View className="px-4">
          <Text className="text-base font-semibold text-gray-800 mb-3">Recent Activities</Text>

          {loading ? (
            <ActivityIndicator size="large" color="#10b981" />
          ) : recentActivities.length === 0 ? (
            <View className="bg-white rounded-xl p-6 border border-gray-100 items-center">
              <Ionicons name="walk-outline" size={36} color="#d1d5db" />
              <Text className="text-gray-400 mt-2 text-sm">No activities logged yet</Text>
            </View>
          ) : (
            recentActivities.map((a) => (
              <ActivityCard
                key={a.id}
                activity={a}
                onPress={() => navigation.navigate('ActivityDetail', { activityId: a.id })}
              />
            ))
          )}
        </View>

      </View>
    </ScrollView>
  );
}
