import { useState, useEffect } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';

type Activity = {
  id: number;
  name: string;
  start_time: string;
  distance_km: number;
  duration_seconds: number;
  avg_pace_min_per_km: number;
};

function kmToMiles(km: number) {
  return km * 0.621371;
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

function formatDate(isoString: string) {
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function HomeScreen() {
  const [weekMiles, setWeekMiles] = useState<number | null>(null);
  const [weekRuns, setWeekRuns] = useState<number | null>(null);
  const [recentActivities, setRecentActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      const startOfWeek = new Date();
      const day = startOfWeek.getDay();
      startOfWeek.setDate(startOfWeek.getDate() - (day === 0 ? 6 : day - 1));
      startOfWeek.setHours(0, 0, 0, 0);

      const [weekRes, recentRes] = await Promise.all([
        supabase
          .from('activities')
          .select('distance_km')
          .gte('start_time', startOfWeek.toISOString()),
        supabase
          .from('activities')
          .select('id, name, start_time, distance_km, duration_seconds, avg_pace_min_per_km')
          .order('start_time', { ascending: false })
          .limit(5),
      ]);

      if (weekRes.data) {
        const totalKm = weekRes.data.reduce((sum, a) => sum + (a.distance_km || 0), 0);
        setWeekMiles(kmToMiles(totalKm));
        setWeekRuns(weekRes.data.length);
      }

      if (recentRes.data) {
        setRecentActivities(recentRes.data);
      }

      setLoading(false);
    }

    fetchData();
  }, []);

  return (
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-5 pt-6 pb-10">
        {/* Welcome Banner */}
        <View className="bg-blue-600 rounded-2xl p-6 mb-6">
          <Text className="text-white text-lg font-medium mb-1">Welcome back!</Text>
          <Text className="text-blue-100 text-sm">Here's how your week is going.</Text>
          <View className="mt-4 flex-row items-center">
            <Ionicons name="trending-up" size={20} color="#bfdbfe" />
            <Text className="text-blue-200 text-sm ml-2">Keep it up!</Text>
          </View>
        </View>

        {/* This Week Stats */}
        <Text className="text-base font-semibold text-gray-700 mb-3">This Week</Text>
        <View className="flex-row gap-3 mb-6">
          {[
            { label: 'Miles', value: weekMiles !== null ? `${weekMiles.toFixed(1)}` : '—', icon: 'map-outline' as const },
            { label: 'Runs', value: weekRuns !== null ? String(weekRuns) : '—', icon: 'footsteps-outline' as const },
          ].map((stat) => (
            <View key={stat.label} className="flex-1 bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <Ionicons name={stat.icon} size={20} color="#9ca3af" />
              <Text className="text-2xl font-bold text-gray-800 mt-2">{stat.value}</Text>
              <Text className="text-xs text-gray-500 mt-0.5">{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Recent Activity */}
        <Text className="text-base font-semibold text-gray-700 mb-3">Recent Activity</Text>
        {loading ? (
          <ActivityIndicator color="#2563eb" size="large" />
        ) : recentActivities.length === 0 ? (
          <View className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 items-center">
            <Ionicons name="walk-outline" size={36} color="#d1d5db" />
            <Text className="text-gray-400 mt-2 text-sm">No runs logged yet</Text>
          </View>
        ) : (
          <View className="gap-3">
            {recentActivities.map((activity) => (
              <View key={activity.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-sm font-semibold text-gray-800" numberOfLines={1}>{activity.name || 'Run'}</Text>
                  <Text className="text-xs text-gray-400 ml-2">{formatDate(activity.start_time)}</Text>
                </View>
                <View className="flex-row gap-4">
                  <View>
                    <Text className="text-lg font-bold text-gray-800">{kmToMiles(activity.distance_km).toFixed(1)}</Text>
                    <Text className="text-xs text-gray-500">miles</Text>
                  </View>
                  <View>
                    <Text className="text-lg font-bold text-gray-800">{formatDuration(activity.duration_seconds)}</Text>
                    <Text className="text-xs text-gray-500">time</Text>
                  </View>
                  {activity.avg_pace_min_per_km ? (
                    <View>
                      <Text className="text-lg font-bold text-gray-800">{formatPace(activity.avg_pace_min_per_km)}</Text>
                      <Text className="text-xs text-gray-500">min/mi</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
