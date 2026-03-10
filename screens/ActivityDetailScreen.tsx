import { useState, useEffect } from 'react';
import { View, Text, ScrollView, ActivityIndicator, TouchableOpacity, Switch, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { supabase } from '../lib/supabase';
import { getKRace } from '../lib/raceDetection';
import { recalculatePMC } from '../lib/pmcRecalc';
import {
  calculatePerformanceScore,
  getBenchmarkForActivity,
  saveBenchmarkEffort,
  removeBenchmarkEffort,
  type BenchmarkEffort,
} from '../lib/benchmarkEfforts';

type Props = NativeStackScreenProps<RootStackParamList, 'ActivityDetail'>;

type ActivityDetail = {
  id: string;
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
  hrss: number | null;
  hr_tss: number | null;
  trimp: number | null;
  pace_load_flat: number | null;
  pace_load_gap: number | null;
  is_race: boolean | null;
  race_detection_source: 'user' | 'auto' | 'none' | null;
  k_race_applied: number | null;
  effective_tss_race: number | null;
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

  // Race detection state (PMC-002)
  const [isRace, setIsRace] = useState(false);
  const [kRace, setKRace] = useState(1.0);
  const [raceSaving, setRaceSaving] = useState(false);

  // Benchmark effort state (PMC-003)
  const [isBenchmark, setIsBenchmark] = useState(false);
  const [existingBenchmark, setExistingBenchmark] = useState<BenchmarkEffort | null>(null);
  const [autoScore, setAutoScore] = useState<number | null>(null);
  const [manualScoreText, setManualScoreText] = useState('');
  const [benchmarkNotes, setBenchmarkNotes] = useState('');
  const [benchmarkSaving, setBenchmarkSaving] = useState(false);

  useEffect(() => {
    async function fetchActivity() {
      const { data } = await supabase
        .from('garmin_activities')
        .select(
          'activity_id, name, start_time, sport, moving_time_seconds, elapsed_time_seconds, ' +
          'distance, avg_pace_seconds, avg_speed, calories, avg_hr, max_hr, ascent, descent, ' +
          'avg_cadence, max_cadence, steps, avg_step_length, min_temperature, max_temperature, ' +
          'start_lat, start_long, active_load, hrss, hr_tss, trimp, pace_load_flat, pace_load_gap, ' +
          'is_race, race_detection_source, k_race_applied, effective_tss_race'
        )
        .eq('activity_id', activityId.toString())
        .single();
      if (data) {
        setActivity({
          id: data.activity_id,
          name: data.name,
          start_time: data.start_time,
          activity_type: data.sport,
          duration_seconds: data.moving_time_seconds ?? data.elapsed_time_seconds,
          distance_km: data.distance != null ? data.distance / 1000 : null,
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
          hrss: data.hrss,
          hr_tss: data.hr_tss,
          trimp: data.trimp,
          pace_load_flat: data.pace_load_flat,
          pace_load_gap: data.pace_load_gap,
          is_race: data.is_race ?? false,
          race_detection_source: data.race_detection_source ?? 'none',
          k_race_applied: data.k_race_applied,
          effective_tss_race: data.effective_tss_race,
        });
        // Initialise race UI state from persisted values
        setIsRace(data.is_race ?? false);
        const durationHours = ((data.moving_time_seconds ?? data.elapsed_time_seconds) ?? 0) / 3600;
        setKRace(data.k_race_applied ?? getKRace(durationHours));

        // Initialise benchmark state
        const computed = calculatePerformanceScore(
          data.sport,
          data.distance,
          data.moving_time_seconds ?? data.elapsed_time_seconds,
        );
        setAutoScore(computed);

        const benchmark = await getBenchmarkForActivity(activityId.toString());
        if (benchmark) {
          setExistingBenchmark(benchmark);
          setIsBenchmark(true);
          setBenchmarkNotes(benchmark.notes ?? '');
          // If auto-score differs from stored score, show stored score in manual field
          if (computed == null) {
            setManualScoreText(String(benchmark.performance_score));
          }
        }
      }
      setLoading(false);
    }
    fetchActivity();
  }, [activityId]);

  async function toggleFavorite() {
    // garmin_activities does not have is_favorite — toggle is visual only
    setFavorite((prev) => !prev);
  }

  async function saveRaceSettings() {
    if (!activity) return;
    setRaceSaving(true);
    const durationHours = (activity.duration_seconds ?? 0) / 3600;
    const k_race_applied = isRace ? kRace : null;
    const effective_tss_race =
      isRace && k_race_applied != null && activity.active_load != null
        ? activity.active_load * k_race_applied
        : null;

    await supabase
      .from('garmin_activities')
      .update({
        is_race: isRace,
        race_detection_source: 'user',
        k_race_applied,
        effective_tss_race,
      })
      .eq('activity_id', activityId.toString());

    // Trigger PMC recalculation from this activity's date onward
    await recalculatePMC(activity.start_time.slice(0, 10));

    setActivity((prev) =>
      prev
        ? { ...prev, is_race: isRace, race_detection_source: 'user', k_race_applied, effective_tss_race }
        : prev
    );
    // Default k_race for next toggle-on, based on duration
    if (!isRace) setKRace(getKRace(durationHours));
    setRaceSaving(false);
  }

  function handleToggleRace(value: boolean) {
    setIsRace(value);
    if (value && activity) {
      // Pre-fill default k_race based on duration when enabling race flag
      const durationHours = (activity.duration_seconds ?? 0) / 3600;
      setKRace(getKRace(durationHours));
    }
  }

  function adjustKRace(delta: number) {
    setKRace((prev) => {
      const next = Math.round((prev + delta) * 10) / 10;
      return Math.min(3.0, Math.max(1.0, next));
    });
  }

  async function saveBenchmarkSettings() {
    if (!activity) return;
    setBenchmarkSaving(true);

    if (!isBenchmark) {
      // User toggled OFF — remove the benchmark row if it exists
      if (existingBenchmark) {
        await removeBenchmarkEffort(activityId.toString());
        setExistingBenchmark(null);
      }
      setBenchmarkSaving(false);
      return;
    }

    // Determine performance score: auto-calculated or manually entered
    const score = autoScore ?? parseFloat(manualScoreText);
    if (!isFinite(score) || score <= 0) {
      setBenchmarkSaving(false);
      return;
    }

    const result = await saveBenchmarkEffort({
      activity_id: activityId.toString(),
      date: activity.start_time.slice(0, 10),
      sport: activity.activity_type ?? 'unknown',
      duration_seconds: activity.duration_seconds ?? 0,
      performance_score: score,
      effort_level: 'user_confirmed',
      notes: benchmarkNotes.trim() || undefined,
    });

    if (result.ok && result.data) {
      setExistingBenchmark(result.data);
    }
    setBenchmarkSaving(false);
  }

  function handleToggleBenchmark(value: boolean) {
    setIsBenchmark(value);
    if (value && autoScore == null && existingBenchmark == null) {
      setManualScoreText('');
    }
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
        {(activity.active_load != null || activity.hrss != null || activity.trimp != null) && (
          <Section title="Training Load">
            <StatCard
              label="Load (PMC)"
              value={activity.active_load != null ? activity.active_load.toFixed(1) : null}
            />
            <StatCard
              label="HRSS"
              value={activity.hrss != null ? activity.hrss.toFixed(1) : null}
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

        {/* Race Settings (PMC-002) */}
        <View className="mb-5">
          <Text className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Race Settings
          </Text>
          <View className="bg-white rounded-xl p-4 border border-gray-100">

            {/* Race toggle row */}
            <View className="flex-row items-center justify-between mb-1">
              <View className="flex-1 pr-3">
                <Text className="text-sm font-semibold text-gray-800">Mark as Race</Text>
                {activity.race_detection_source === 'auto' && !isRace && (
                  <Text className="text-xs text-blue-500 mt-0.5">Auto-detected as race</Text>
                )}
                {activity.race_detection_source === 'user' && (
                  <Text className="text-xs text-gray-400 mt-0.5">Manually set</Text>
                )}
              </View>
              <Switch
                value={isRace}
                onValueChange={handleToggleRace}
                trackColor={{ false: '#e5e7eb', true: '#2563eb' }}
                thumbColor="#ffffff"
              />
            </View>

            {/* k_race multiplier — only shown when is_race = true */}
            {isRace && (
              <View className="mt-3 pt-3 border-t border-gray-100">
                <Text className="text-xs text-gray-500 mb-2">
                  Fatigue Multiplier (k_race) · applies to ATL only
                </Text>
                <View className="flex-row items-center gap-3">
                  <TouchableOpacity
                    onPress={() => adjustKRace(-0.1)}
                    className="w-9 h-9 rounded-full bg-gray-100 items-center justify-center"
                  >
                    <Text className="text-lg font-bold text-gray-700">−</Text>
                  </TouchableOpacity>
                  <View className="flex-1 items-center">
                    <Text className="text-xl font-bold text-gray-900">{kRace.toFixed(1)}×</Text>
                    <Text className="text-xs text-gray-400">effective TSS = {
                      activity.active_load != null
                        ? (activity.active_load * kRace).toFixed(1)
                        : '—'
                    }</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => adjustKRace(0.1)}
                    className="w-9 h-9 rounded-full bg-gray-100 items-center justify-center"
                  >
                    <Text className="text-lg font-bold text-gray-700">+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Save button */}
            <TouchableOpacity
              onPress={saveRaceSettings}
              disabled={raceSaving}
              className="mt-4 rounded-lg py-2.5 items-center"
              style={{ backgroundColor: raceSaving ? '#93c5fd' : '#2563eb' }}
            >
              <Text className="text-white text-sm font-semibold">
                {raceSaving ? 'Saving…' : 'Save Race Settings'}
              </Text>
            </TouchableOpacity>

          </View>
        </View>

        {/* Benchmark Effort (PMC-003) */}
        <View className="mb-5">
          <Text className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Benchmark Effort
          </Text>
          <View className="bg-white rounded-xl p-4 border border-gray-100">

            {/* Toggle row */}
            <View className="flex-row items-center justify-between mb-1">
              <View className="flex-1 pr-3">
                <Text className="text-sm font-semibold text-gray-800">Mark as Benchmark Effort</Text>
                {existingBenchmark?.effort_level === 'auto_detected' && (
                  <Text className="text-xs text-blue-500 mt-0.5">Auto-detected</Text>
                )}
                {existingBenchmark?.effort_level === 'user_confirmed' && (
                  <Text className="text-xs text-gray-400 mt-0.5">User confirmed</Text>
                )}
              </View>
              <Switch
                value={isBenchmark}
                onValueChange={handleToggleBenchmark}
                trackColor={{ false: '#e5e7eb', true: '#2563eb' }}
                thumbColor="#ffffff"
              />
            </View>

            {isBenchmark && (
              <View className="mt-3 pt-3 border-t border-gray-100">

                {/* Performance score */}
                {autoScore != null ? (
                  <View className="mb-3">
                    <Text className="text-xs text-gray-500 mb-1">Performance Score (VDOT)</Text>
                    <Text className="text-2xl font-bold text-gray-900">{autoScore.toFixed(1)}</Text>
                    <Text className="text-xs text-gray-400 mt-0.5">
                      Auto-calculated · higher is better · comparable across distances
                    </Text>
                  </View>
                ) : (
                  <View className="mb-3">
                    <Text className="text-xs text-gray-500 mb-1">Performance Score (required)</Text>
                    <TextInput
                      className="border border-gray-200 rounded-lg px-3 py-2 text-base text-gray-900 bg-gray-50"
                      value={manualScoreText}
                      onChangeText={setManualScoreText}
                      keyboardType="decimal-pad"
                      placeholder="e.g. 4.5 for cycling (watts/kg)"
                      placeholderTextColor="#9ca3af"
                    />
                    <Text className="text-xs text-gray-400 mt-1">
                      Running: VDOT · Cycling: normalized power (W/kg) · must be consistent across efforts
                    </Text>
                  </View>
                )}

                {/* CTL / ATL snapshot */}
                {existingBenchmark && (existingBenchmark.ctl_on_date != null || existingBenchmark.atl_on_date != null) && (
                  <View className="flex-row gap-4 mb-3">
                    <View>
                      <Text className="text-xs text-gray-500">CTL on date</Text>
                      <Text className="text-sm font-semibold text-gray-800">
                        {existingBenchmark.ctl_on_date?.toFixed(1) ?? '—'}
                      </Text>
                    </View>
                    <View>
                      <Text className="text-xs text-gray-500">ATL on date</Text>
                      <Text className="text-sm font-semibold text-gray-800">
                        {existingBenchmark.atl_on_date?.toFixed(1) ?? '—'}
                      </Text>
                    </View>
                  </View>
                )}

                {/* Notes */}
                <View className="mb-1">
                  <Text className="text-xs text-gray-500 mb-1">Notes (optional)</Text>
                  <TextInput
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-gray-50"
                    value={benchmarkNotes}
                    onChangeText={setBenchmarkNotes}
                    placeholder="e.g. A race, 20-min FTP test, all-out interval"
                    placeholderTextColor="#9ca3af"
                    multiline
                    numberOfLines={2}
                  />
                </View>
              </View>
            )}

            {/* Save button */}
            <TouchableOpacity
              onPress={saveBenchmarkSettings}
              disabled={benchmarkSaving || (isBenchmark && autoScore == null && manualScoreText.trim() === '')}
              className="mt-4 rounded-lg py-2.5 items-center"
              style={{
                backgroundColor:
                  benchmarkSaving || (isBenchmark && autoScore == null && manualScoreText.trim() === '')
                    ? '#93c5fd'
                    : '#2563eb',
              }}
            >
              <Text className="text-white text-sm font-semibold">
                {benchmarkSaving ? 'Saving…' : 'Save Benchmark Settings'}
              </Text>
            </TouchableOpacity>

          </View>
        </View>

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
