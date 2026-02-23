import { useState, useEffect } from 'react';
import { View, Text, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { supabase } from '../lib/supabase';

type Props = NativeStackScreenProps<RootStackParamList, 'ActivityDetail'>;

type ActivityDetail = {
  id: number;
  name: string;
  start_time: string;
  activity_type: string | null;
  duration_seconds: number | null;
  distance_km: number | null;
  avg_pace_min_per_km: number | null;
  avg_speed_ms: number | null;
  calories: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  min_elevation_m: number | null;
  max_elevation_m: number | null;
  avg_cadence: number | null;
  max_cadence: number | null;
  steps: number | null;
  avg_stride_length_m: number | null;
  min_temperature_c: number | null;
  max_temperature_c: number | null;
  location_name: string | null;
  start_latitude: number | null;
  start_longitude: number | null;
  is_pr: boolean | null;
  is_favorite: boolean | null;
  active_load: number | null;
  hr_tss: number | null;
  trimp: number | null;
  pace_load_flat: number | null;
  pace_load_gap: number | null;
};

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
  return `${min}:${String(sec).padStart(2, '0')} /mi`;
}

function kmToMiles(km: number) {
  return (km * 0.621371).toFixed(2);
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isRunning(type: string | null) {
  return type?.toLowerCase().includes('run') ?? false;
}

function StatCard({ label, value }: { label: string; value: string | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <View className="bg-white rounded-xl p-4 border border-gray-100 flex-1 min-w-[44%]">
      <Text className="text-xs text-gray-500 mb-1">{label}</Text>
      <Text className="text-base font-semibold text-gray-800">{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-5">
      <Text className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</Text>
      <View className="flex-row flex-wrap gap-2">{children}</View>
    </View>
  );
}

export default function ActivityDetailScreen({ route, navigation }: Props) {
  const { activityId } = route.params;
  const [activity, setActivity] = useState<ActivityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [favorite, setFavorite] = useState(false);

  useEffect(() => {
    async function fetchActivity() {
      const { data } = await supabase
        .from('garmin_activities')
        .select(
          'activity_id, name, start_time, sport, moving_time_seconds, elapsed_time_seconds, ' +
          'distance, avg_pace_seconds, avg_speed, calories, avg_hr, max_hr, ascent, descent, ' +
          'avg_cadence, max_cadence, steps, avg_step_length, min_temperature, max_temperature, ' +
          'start_lat, start_long, active_load, hr_tss, trimp, pace_load_flat, pace_load_gap'
        )
        .eq('activity_id', activityId.toString())
        .single();
      if (data) {
        setActivity({
          id: parseInt(data.activity_id, 10),
          name: data.name,
          start_time: data.start_time,
          activity_type: data.sport,
          duration_seconds: data.moving_time_seconds ?? data.elapsed_time_seconds,
          distance_km: data.distance,
          avg_pace_min_per_km: data.avg_pace_seconds != null ? data.avg_pace_seconds / 60 : null,
          avg_speed_ms: data.avg_speed != null ? data.avg_speed / 3.6 : null,
          calories: data.calories,
          avg_hr: data.avg_hr,
          max_hr: data.max_hr,
          elevation_gain_m: data.ascent,
          elevation_loss_m: data.descent,
          min_elevation_m: null,
          max_elevation_m: null,
          avg_cadence: data.avg_cadence,
          max_cadence: data.max_cadence,
          steps: data.steps,
          avg_stride_length_m: data.avg_step_length,
          min_temperature_c: data.min_temperature,
          max_temperature_c: data.max_temperature,
          location_name: null,
          start_latitude: data.start_lat,
          start_longitude: data.start_long,
          is_pr: null,
          is_favorite: null,
          active_load: data.active_load,
          hr_tss: data.hr_tss,
          trimp: data.trimp,
          pace_load_flat: data.pace_load_flat,
          pace_load_gap: data.pace_load_gap,
        });
      }
      setLoading(false);
    }
    fetchActivity();
  }, [activityId]);

  async function toggleFavorite() {
    // garmin_activities does not have is_favorite — toggle is visual only
    setFavorite((prev) => !prev);
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-gray-50">
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!activity) {
    return (
      <View className="flex-1 items-center justify-center bg-gray-50">
        <Text className="text-gray-500">Activity not found.</Text>
      </View>
    );
  }

  const typeLabel = activity.activity_type
    ? activity.activity_type.charAt(0).toUpperCase() + activity.activity_type.slice(1).toLowerCase()
    : 'Activity';
  const typeColor = isRunning(activity.activity_type) ? '#10b981' : '#f97316';

  return (
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-4 pt-5 pb-12">

        {/* Header */}
        <View className="bg-white rounded-2xl p-5 border border-gray-100 mb-5">
          <View className="flex-row items-start justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-lg font-bold text-gray-900" numberOfLines={2}>
                {activity.name || 'Activity'}
              </Text>
              <Text className="text-sm text-gray-500 mt-1">{formatDateTime(activity.start_time)}</Text>
            </View>
            <TouchableOpacity onPress={toggleFavorite} className="p-1">
              <Ionicons
                name={favorite ? 'star' : 'star-outline'}
                size={24}
                color={favorite ? '#f59e0b' : '#9ca3af'}
              />
            </TouchableOpacity>
          </View>
          <View className="flex-row items-center gap-2 mt-3">
            <View
              className="rounded-full px-3 py-1"
              style={{ backgroundColor: typeColor + '20' }}
            >
              <Text className="text-xs font-semibold" style={{ color: typeColor }}>
                {typeLabel}
              </Text>
            </View>
            {activity.is_pr && (
              <View className="bg-yellow-50 rounded-full px-3 py-1 border border-yellow-300">
                <Text className="text-xs font-bold text-yellow-700">PR</Text>
              </View>
            )}
          </View>
        </View>

        {/* Core Stats */}
        <Section title="Performance">
          <StatCard
            label="Duration"
            value={activity.duration_seconds ? formatDuration(activity.duration_seconds) : null}
          />
          <StatCard
            label="Distance"
            value={activity.distance_km ? `${kmToMiles(activity.distance_km)} mi` : null}
          />
          <StatCard
            label="Avg Pace"
            value={activity.avg_pace_min_per_km ? formatPace(activity.avg_pace_min_per_km) : null}
          />
          <StatCard
            label="Avg Speed"
            value={
              activity.avg_speed_ms
                ? `${(activity.avg_speed_ms * 2.237).toFixed(1)} mph`
                : null
            }
          />
          <StatCard
            label="Calories"
            value={activity.calories ? `${activity.calories} kcal` : null}
          />
        </Section>

        {/* Heart Rate */}
        <Section title="Heart Rate">
          <StatCard label="Avg HR" value={activity.avg_hr ? `${activity.avg_hr} bpm` : null} />
          <StatCard label="Max HR" value={activity.max_hr ? `${activity.max_hr} bpm` : null} />
        </Section>

        {/* Training Load */}
        {(activity.active_load != null || activity.hr_tss != null || activity.trimp != null) && (
          <Section title="Training Load">
            <StatCard
              label="Load (PMC)"
              value={activity.active_load != null ? activity.active_load.toFixed(1) : null}
            />
            <StatCard
              label="hrTSS"
              value={activity.hr_tss != null ? activity.hr_tss.toFixed(1) : null}
            />
            <StatCard
              label="TRIMP"
              value={activity.trimp != null ? activity.trimp.toFixed(1) : null}
            />
            <StatCard
              label="Pace Load (GAP)"
              value={activity.pace_load_gap != null ? activity.pace_load_gap.toFixed(1) : null}
            />
            <StatCard
              label="Pace Load (Flat)"
              value={activity.pace_load_flat != null ? activity.pace_load_flat.toFixed(1) : null}
            />
          </Section>
        )}

        {/* Elevation */}
        <Section title="Elevation">
          <StatCard
            label="Gain"
            value={activity.elevation_gain_m != null ? `${activity.elevation_gain_m} m` : null}
          />
          <StatCard
            label="Loss"
            value={activity.elevation_loss_m != null ? `${activity.elevation_loss_m} m` : null}
          />
          <StatCard
            label="Min"
            value={activity.min_elevation_m != null ? `${activity.min_elevation_m} m` : null}
          />
          <StatCard
            label="Max"
            value={activity.max_elevation_m != null ? `${activity.max_elevation_m} m` : null}
          />
        </Section>

        {/* Cadence & Stride */}
        <Section title="Cadence & Stride">
          <StatCard
            label="Avg Cadence"
            value={activity.avg_cadence ? `${activity.avg_cadence} spm` : null}
          />
          <StatCard
            label="Max Cadence"
            value={activity.max_cadence ? `${activity.max_cadence} spm` : null}
          />
          <StatCard
            label="Steps"
            value={activity.steps ? activity.steps.toLocaleString() : null}
          />
          <StatCard
            label="Avg Stride"
            value={
              activity.avg_stride_length_m
                ? `${activity.avg_stride_length_m.toFixed(2)} m`
                : null
            }
          />
        </Section>

        {/* Temperature */}
        <Section title="Temperature">
          <StatCard
            label="Min"
            value={
              activity.min_temperature_c != null
                ? `${activity.min_temperature_c}°C`
                : null
            }
          />
          <StatCard
            label="Max"
            value={
              activity.max_temperature_c != null
                ? `${activity.max_temperature_c}°C`
                : null
            }
          />
        </Section>

        {/* Location */}
        {(activity.location_name || activity.start_latitude) && (
          <Section title="Location">
            {activity.location_name && (
              <View className="bg-white rounded-xl p-4 border border-gray-100 w-full">
                <Text className="text-xs text-gray-500 mb-1">Location</Text>
                <Text className="text-base font-semibold text-gray-800">{activity.location_name}</Text>
              </View>
            )}
            {activity.start_latitude != null && activity.start_longitude != null && (
              <View className="bg-white rounded-xl p-4 border border-gray-100 w-full">
                <Text className="text-xs text-gray-500 mb-1">Coordinates</Text>
                <Text className="text-sm font-medium text-gray-700">
                  {activity.start_latitude.toFixed(5)}, {activity.start_longitude.toFixed(5)}
                </Text>
              </View>
            )}
          </Section>
        )}

      </View>
    </ScrollView>
  );
}
