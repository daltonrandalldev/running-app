import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import {
  calculateVdot,
  predictTime,
  getTrainingPaces,
  formatTime,
  formatPaceMile,
  predictedPaceMile,
  parseTime,
  RACE_DISTANCES,
  PREDICTION_DISTANCES,
  TRAINING_ZONES,
  type RaceDistance,
} from '../lib/vdot';

type RaceEntry = {
  id: number;
  distance_name: string;
  distance_m: number;
  finish_time_min: number;
  finish_time_display: string;
  vdot: number;
  created_at: string;
};

type CardProps = {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
};

function Card({ title, icon, children }: CardProps) {
  return (
    <View className="bg-white rounded-2xl p-5 mb-4 shadow-sm border border-gray-100">
      <View className="flex-row items-center mb-4">
        <View className="w-8 h-8 rounded-lg bg-blue-50 items-center justify-center mr-3">
          <Ionicons name={icon} size={18} color="#2563eb" />
        </View>
        <Text className="text-base font-semibold text-gray-800">{title}</Text>
      </View>
      {children}
    </View>
  );
}

type MetricRowProps = {
  label: string;
  value: string;
  accent?: string;
  isLast?: boolean;
};

function MetricRow({ label, value, accent, isLast }: MetricRowProps) {
  return (
    <View
      className={`flex-row items-center justify-between py-2 ${
        isLast ? '' : 'border-b border-gray-50'
      }`}
    >
      <Text className="text-sm text-gray-600">{label}</Text>
      <Text className={`text-sm font-medium ${accent ?? 'text-gray-400'}`}>{value}</Text>
    </View>
  );
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const HR_ZONE_COLORS = [
  'text-blue-400',
  'text-green-500',
  'text-yellow-500',
  'text-orange-500',
  'text-red-500',
];

export default function KeyMetricsScreen() {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(true);
  const [raceEntry, setRaceEntry] = useState<RaceEntry | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedDistance, setSelectedDistance] = useState<RaceDistance | null>(null);
  const [timeInput, setTimeInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    fetchLatestEntry();
  }, []);

  async function fetchLatestEntry() {
    setLoading(true);
    const { data } = await supabase
      .from('race_entries')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    setRaceEntry((data?.[0] as RaceEntry) ?? null);
    setLoading(false);
  }

  function handleOpenModal() {
    setSelectedDistance(null);
    setTimeInput('');
    setInputError(null);
    setShowModal(true);
  }

  function handleCloseModal() {
    setShowModal(false);
  }

  async function handleSave() {
    if (!selectedDistance) {
      setInputError('Please select a race distance.');
      return;
    }
    if (!timeInput.trim()) {
      setInputError('Please enter a finish time.');
      return;
    }

    let timeMin: number;
    try {
      timeMin = parseTime(timeInput);
    } catch {
      setInputError('Invalid format — use MM:SS or H:MM:SS (e.g. 20:30 or 1:34:20).');
      return;
    }

    const vdot = calculateVdot(selectedDistance.meters, timeMin);
    if (vdot < 20 || vdot > 90) {
      setInputError('Time seems off — VDOT out of range (20–90). Check distance and time.');
      return;
    }

    setSaving(true);
    const { data, error } = await supabase
      .from('race_entries')
      .insert({
        distance_name: selectedDistance.name,
        distance_m: selectedDistance.meters,
        finish_time_min: timeMin,
        finish_time_display: timeInput.trim(),
        vdot: Math.round(vdot * 10) / 10,
      })
      .select()
      .single();
    setSaving(false);

    if (error || !data) {
      setInputError('Failed to save. Please try again.');
      return;
    }

    setRaceEntry(data as RaceEntry);
    setShowModal(false);
  }

  const paces = raceEntry ? getTrainingPaces(raceEntry.vdot) : null;

  return (
    <>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#f9fafb' }}>
      {/* Back header */}
      {navigation.canGoBack() && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={{ padding: 8 }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={26} color="#111827" />
          </TouchableOpacity>
        </View>
      )}
      <ScrollView className="flex-1 bg-gray-50">
        <View className="px-5 pt-8 pb-10">

          {/* VDOT Score */}
          <Card title="VDOT Score" icon="speedometer-outline">
            {loading ? (
              <View className="py-4 items-center">
                <ActivityIndicator color="#2563eb" />
              </View>
            ) : (
              <>
                <View className="items-center py-4">
                  <Text className="text-5xl font-bold text-blue-600">
                    {raceEntry ? raceEntry.vdot.toFixed(1) : '—'}
                  </Text>
                  {raceEntry ? (
                    <>
                      <Text className="text-sm text-gray-500 mt-2">
                        {raceEntry.distance_name} in {raceEntry.finish_time_display}
                      </Text>
                      <Text className="text-xs text-gray-400 mt-1">
                        {formatDate(raceEntry.created_at)}
                      </Text>
                    </>
                  ) : (
                    <Text className="text-sm text-gray-400 mt-2">No data yet</Text>
                  )}
                </View>
                <TouchableOpacity
                  className="bg-blue-600 rounded-xl py-3 items-center"
                  onPress={handleOpenModal}
                >
                  <Text className="text-white font-semibold text-sm">
                    {raceEntry ? 'Update Race Time' : 'Set Race Time'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </Card>

          {/* Predicted Race Performances */}
          <Card title="Predicted Race Performances" icon="trophy-outline">
            {loading ? (
              <View className="py-4 items-center">
                <ActivityIndicator color="#2563eb" />
              </View>
            ) : (
              <>
                {PREDICTION_DISTANCES.map((dist, i) => {
                  const isLast = i === PREDICTION_DISTANCES.length - 1;
                  if (!raceEntry) {
                    return (
                      <MetricRow key={dist.name} label={dist.name} value="—" isLast={isLast} />
                    );
                  }
                  const timeMin = predictTime(dist.meters, raceEntry.vdot);
                  const pace = predictedPaceMile(dist.meters, timeMin);
                  return (
                    <MetricRow
                      key={dist.name}
                      label={dist.name}
                      value={`${formatTime(timeMin)}  (${pace})`}
                      accent="text-gray-800"
                      isLast={isLast}
                    />
                  );
                })}
                {!raceEntry && (
                  <Text className="text-xs text-gray-400 mt-3">
                    Projections are based on your current VDOT score.
                  </Text>
                )}
              </>
            )}
          </Card>

          {/* Training Paces */}
          <Card title="Training Paces" icon="walk-outline">
            {loading ? (
              <View className="py-4 items-center">
                <ActivityIndicator color="#2563eb" />
              </View>
            ) : (
              <>
                {TRAINING_ZONES.map((zone, i) => {
                  const isLast = i === TRAINING_ZONES.length - 1;
                  if (!paces) {
                    return (
                      <MetricRow key={zone.key} label={zone.key} value="—" isLast={isLast} />
                    );
                  }
                  const [fast, slow] = paces[zone.key];
                  return (
                    <View
                      key={zone.key}
                      className={`flex-row items-center justify-between py-2 ${
                        isLast ? '' : 'border-b border-gray-50'
                      }`}
                    >
                      <Text className="text-sm text-gray-600">{zone.key}</Text>
                      <Text
                        className="text-sm font-medium"
                        style={{ color: zone.color }}
                      >
                        {formatPaceMile(fast)} – {formatPaceMile(slow)}
                      </Text>
                    </View>
                  );
                })}
                {!paces && (
                  <Text className="text-xs text-gray-400 mt-3">
                    Log a race to see your personalized training paces.
                  </Text>
                )}
              </>
            )}
          </Card>

          {/* HR Zones */}
          <Card title="HR Zones" icon="heart-outline">
            {[1, 2, 3, 4, 5].map((zone, i) => (
              <MetricRow
                key={zone}
                label={`Zone ${zone}`}
                value="— – — bpm"
                accent={HR_ZONE_COLORS[zone - 1]}
                isLast={i === 4}
              />
            ))}
            <Text className="text-xs text-gray-400 mt-3">
              Connect a heart rate monitor or enter your max HR to calculate zones.
            </Text>
          </Card>

          {/* Lactate Threshold */}
          <Card title="Lactate Threshold" icon="pulse-outline">
            <MetricRow label="Threshold Heart Rate" value="— bpm" />
            <MetricRow label="Threshold Pace" value="—:—/mi" isLast />
            <Text className="text-xs text-gray-400 mt-3">
              Estimated from recent race performances or workout data.
            </Text>
          </Card>

        </View>
      </ScrollView>
      </SafeAreaView>

      {/* Race Entry Modal */}
      <Modal
        visible={showModal}
        animationType="slide"
        transparent
        onRequestClose={handleCloseModal}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          {/* Backdrop — tap to dismiss */}
          <TouchableOpacity
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.4)',
            }}
            onPress={handleCloseModal}
            activeOpacity={1}
          />

          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View className="bg-white rounded-t-3xl px-6 pt-5 pb-8">

              {/* Header */}
              <View className="flex-row items-center justify-between mb-5">
                <Text className="text-base font-semibold text-gray-800">Log Race Time</Text>
                <TouchableOpacity
                  onPress={handleCloseModal}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle-outline" size={24} color="#9ca3af" />
                </TouchableOpacity>
              </View>

              {/* Distance picker */}
              <Text className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Race Distance
              </Text>
              <ScrollView style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
                {RACE_DISTANCES.map((dist) => {
                  const selected = selectedDistance?.name === dist.name;
                  return (
                    <TouchableOpacity
                      key={dist.name}
                      onPress={() => setSelectedDistance(dist)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingVertical: 10,
                        paddingHorizontal: 12,
                        marginBottom: 6,
                        borderRadius: 8,
                        borderWidth: 1,
                        backgroundColor: selected ? '#eff6ff' : '#f9fafb',
                        borderColor: selected ? '#93c5fd' : '#e5e7eb',
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 14,
                          color: selected ? '#1d4ed8' : '#374151',
                          fontWeight: selected ? '500' : '400',
                        }}
                      >
                        {dist.name}
                      </Text>
                      {selected && (
                        <Ionicons name="checkmark-circle" size={18} color="#2563eb" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Time input */}
              <Text className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-2">
                Finish Time
              </Text>
              <TextInput
                value={timeInput}
                onChangeText={(t) => {
                  setTimeInput(t);
                  setInputError(null);
                }}
                placeholder="e.g. 20:30 or 1:34:20"
                keyboardType="numbers-and-punctuation"
                placeholderTextColor="#9ca3af"
                style={{
                  borderWidth: 1,
                  borderColor: '#e5e7eb',
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 14,
                  color: '#1f2937',
                  backgroundColor: '#f9fafb',
                }}
              />
              {inputError && (
                <Text className="text-red-500 text-xs mt-1.5">{inputError}</Text>
              )}

              {/* Save button */}
              <TouchableOpacity
                onPress={handleSave}
                disabled={saving}
                style={{
                  backgroundColor: saving ? '#93c5fd' : '#2563eb',
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginTop: 20,
                }}
              >
                {saving ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text style={{ color: 'white', fontWeight: '600', fontSize: 14 }}>
                    Calculate & Save
                  </Text>
                )}
              </TouchableOpacity>

            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}
