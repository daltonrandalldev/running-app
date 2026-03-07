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
import { loadHRZones, saveHRZones, type HRZones } from '../lib/hrZones';
import { loadLTHR, saveLTHR } from '../lib/lthr';
import PMCChart from '../components/PMCChart';
import PMCSettingsModal from '../components/PMCSettingsModal';
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
  action?: React.ReactNode;
};

function Card({ title, icon, children, action }: CardProps) {
  return (
    <View className="bg-white rounded-2xl p-5 mb-4 shadow-sm border border-gray-100">
      <View className="flex-row items-center mb-4">
        <View className="w-8 h-8 rounded-lg bg-blue-50 items-center justify-center mr-3">
          <Ionicons name={icon} size={18} color="#2563eb" />
        </View>
        <Text className="text-base font-semibold text-gray-800 flex-1">{title}</Text>
        {action}
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

const HR_ZONE_COLORS = ['#60a5fa', '#22c55e', '#eab308', '#f97316', '#ef4444'];
const HR_ZONE_TEXT_CLASSES = [
  'text-blue-400',
  'text-green-500',
  'text-yellow-500',
  'text-orange-500',
  'text-red-500',
];

type ZoneInputs = { min: string; max: string };

function defaultZoneInputs(): ZoneInputs[] {
  return [
    { min: '', max: '' },
    { min: '', max: '' },
    { min: '', max: '' },
    { min: '', max: '' },
    { min: '', max: '' },
  ];
}

function hrZonesToInputs(zones: HRZones): ZoneInputs[] {
  return zones.map((z) => ({ min: String(z.min), max: String(z.max) }));
}

export default function KeyMetricsScreen() {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(true);
  const [raceEntry, setRaceEntry] = useState<RaceEntry | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedDistance, setSelectedDistance] = useState<RaceDistance | null>(null);
  const [timeInput, setTimeInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  // HR zone state
  const [hrZones, setHrZones] = useState<HRZones | null>(null);
  const [showHRModal, setShowHRModal] = useState(false);
  const [zoneInputs, setZoneInputs] = useState<ZoneInputs[]>(defaultZoneInputs());
  const [hrSaveError, setHrSaveError] = useState<string | null>(null);

  // PMC state
  const [showPMCSettings, setShowPMCSettings] = useState(false);
  const [pmcRefreshTrigger, setPmcRefreshTrigger] = useState(0);

  // LTHR state
  const [lthr, setLthr] = useState<number | null>(null);
  const [showLTHRModal, setShowLTHRModal] = useState(false);
  const [lthrInput, setLthrInput] = useState('');
  const [lthrSaveError, setLthrSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetchLatestEntry();
    loadHRZones().then((z) => {
      if (z) setHrZones(z);
    });
    loadLTHR().then((v) => {
      if (v !== null) setLthr(v);
    });
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

  // ── HR zone modal ──────────────────────────────────────────────────────────

  function handleOpenHRModal() {
    setZoneInputs(hrZones ? hrZonesToInputs(hrZones) : defaultZoneInputs());
    setHrSaveError(null);
    setShowHRModal(true);
  }

  function updateZoneInput(index: number, field: 'min' | 'max', value: string) {
    setZoneInputs((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setHrSaveError(null);
  }

  async function handleSaveHRZones() {
    const parsed: { min: number; max: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const minVal = parseInt(zoneInputs[i].min, 10);
      const maxVal = parseInt(zoneInputs[i].max, 10);
      if (isNaN(minVal) || isNaN(maxVal)) {
        setHrSaveError(`Zone ${i + 1}: enter valid BPM numbers.`);
        return;
      }
      if (minVal >= maxVal) {
        setHrSaveError(`Zone ${i + 1}: min must be less than max.`);
        return;
      }
      parsed.push({ min: minVal, max: maxVal });
    }
    const zones = parsed as HRZones;
    await saveHRZones(zones);
    setHrZones(zones);
    setShowHRModal(false);
  }

  // ── LTHR modal ──────────────────────────────────────────────────────────────

  function handleOpenLTHRModal() {
    setLthrInput(lthr !== null ? String(lthr) : '');
    setLthrSaveError(null);
    setShowLTHRModal(true);
  }

  async function handleSaveLTHR() {
    const val = parseInt(lthrInput, 10);
    if (isNaN(val) || val < 60 || val > 220) {
      setLthrSaveError('Enter a valid heart rate (60–220 bpm).');
      return;
    }
    await saveLTHR(val);
    setLthr(val);
    setShowLTHRModal(false);
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

          {/* Performance Management Chart */}
          <Card
            title="Performance Management"
            icon="analytics-outline"
            action={
              <TouchableOpacity
                onPress={() => setShowPMCSettings(true)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ padding: 4 }}
              >
                <Ionicons name="settings-outline" size={18} color="#2563eb" />
              </TouchableOpacity>
            }
          >
            <PMCChart
              refreshTrigger={pmcRefreshTrigger}
              onOpenSettings={() => setShowPMCSettings(true)}
            />
          </Card>

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

          {/* Sweet Spot Interval Guidelines */}
          <Card title="Sweet Spot Interval Guidelines" icon="timer-outline">
            {loading ? (
              <View className="py-4 items-center">
                <ActivityIndicator color="#2563eb" />
              </View>
            ) : raceEntry ? (
              <>
                {(() => {
                  const v = raceEntry.vdot;
                  const pace12k = predictedPaceMile(12000, predictTime(12000, v));
                  const pace15k = predictedPaceMile(15000, predictTime(15000, v));
                  const pace20k = predictedPaceMile(20000, predictTime(20000, v));
                  const pace25k = predictedPaceMile(25000, predictTime(25000, v));
                  const pace30k = predictedPaceMile(30000, predictTime(30000, v));
                  return (
                    <>
                      <MetricRow
                        label="3 Min Reps  (12k–15k effort)"
                        value={`${pace12k} – ${pace15k}`}
                        accent="text-gray-800"
                      />
                      <MetricRow
                        label="6 Min Reps  (20k effort)"
                        value={pace20k}
                        accent="text-gray-800"
                      />
                      <MetricRow
                        label="10 Min Reps  (25k–30k effort)"
                        value={`${pace25k} – ${pace30k}`}
                        accent="text-gray-800"
                        isLast
                      />
                    </>
                  );
                })()}
              </>
            ) : (
              <Text className="text-xs text-gray-400 mt-1 mb-1">
                Log a race to see your sweet spot interval paces.
              </Text>
            )}
          </Card>

          {/* HR Zones */}
          <Card
            title="HR Zones"
            icon="heart-outline"
            action={
              <TouchableOpacity
                onPress={handleOpenHRModal}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ padding: 4 }}
              >
                <Ionicons name="pencil-outline" size={18} color="#2563eb" />
              </TouchableOpacity>
            }
          >
            {[1, 2, 3, 4, 5].map((zone, i) => {
              const z = hrZones?.[i];
              const value = z ? `${z.min} – ${z.max} bpm` : '— – — bpm';
              return (
                <MetricRow
                  key={zone}
                  label={`Zone ${zone}`}
                  value={value}
                  accent={z ? undefined : HR_ZONE_TEXT_CLASSES[i]}
                  isLast={i === 4}
                />
              );
            })}
            {!hrZones && (
              <Text className="text-xs text-gray-400 mt-3">
                Tap the edit button to set your heart rate zones.
              </Text>
            )}
          </Card>

          {/* Lactate Threshold */}
          <Card
            title="Lactate Threshold"
            icon="pulse-outline"
            action={
              <TouchableOpacity
                onPress={handleOpenLTHRModal}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ padding: 4 }}
              >
                <Ionicons name="pencil-outline" size={18} color="#2563eb" />
              </TouchableOpacity>
            }
          >
            <MetricRow
              label="Threshold Heart Rate"
              value={lthr !== null ? `${lthr} bpm` : '— bpm'}
              accent={lthr !== null ? 'text-gray-800' : undefined}
              isLast
            />
            {!lthr && (
              <Text className="text-xs text-gray-400 mt-3">
                Tap the edit button to set your lactate threshold heart rate.
              </Text>
            )}
          </Card>

        </View>
      </ScrollView>
      </SafeAreaView>

      {/* PMC Settings Modal */}
      <PMCSettingsModal
        visible={showPMCSettings}
        onClose={() => setShowPMCSettings(false)}
        onRefitComplete={() => {
          setPmcRefreshTrigger((t) => t + 1);
          setShowPMCSettings(false);
        }}
      />

      {/* Race Entry Modal */}
      <Modal
        visible={showModal}
        animationType="slide"
        transparent
        onRequestClose={handleCloseModal}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
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

              <View className="flex-row items-center justify-between mb-5">
                <Text className="text-base font-semibold text-gray-800">Log Race Time</Text>
                <TouchableOpacity
                  onPress={handleCloseModal}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle-outline" size={24} color="#9ca3af" />
                </TouchableOpacity>
              </View>

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

      {/* LTHR Edit Modal */}
      <Modal
        visible={showLTHRModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowLTHRModal(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <TouchableOpacity
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.4)',
            }}
            onPress={() => setShowLTHRModal(false)}
            activeOpacity={1}
          />

          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View
              style={{
                backgroundColor: 'white',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingHorizontal: 24,
                paddingTop: 20,
                paddingBottom: 36,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#111827' }}>
                  Edit LTHR
                </Text>
                <TouchableOpacity
                  onPress={() => setShowLTHRModal(false)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle-outline" size={24} color="#9ca3af" />
                </TouchableOpacity>
              </View>

              <Text style={{ fontSize: 11, color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                Threshold Heart Rate (BPM)
              </Text>
              <TextInput
                value={lthrInput}
                onChangeText={(v) => {
                  setLthrInput(v);
                  setLthrSaveError(null);
                }}
                keyboardType="number-pad"
                placeholder="e.g. 162"
                placeholderTextColor="#d1d5db"
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
              {lthrSaveError && (
                <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>
                  {lthrSaveError}
                </Text>
              )}

              <TouchableOpacity
                onPress={handleSaveLTHR}
                style={{
                  backgroundColor: '#2563eb',
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginTop: 20,
                }}
              >
                <Text style={{ color: 'white', fontWeight: '600', fontSize: 14 }}>
                  Save
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* HR Zone Edit Modal */}
      <Modal
        visible={showHRModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowHRModal(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <TouchableOpacity
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.4)',
            }}
            onPress={() => setShowHRModal(false)}
            activeOpacity={1}
          />

          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View
              style={{
                backgroundColor: 'white',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingHorizontal: 24,
                paddingTop: 20,
                paddingBottom: 36,
              }}
            >
              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#111827' }}>
                  Edit HR Zones
                </Text>
                <TouchableOpacity
                  onPress={() => setShowHRModal(false)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle-outline" size={24} color="#9ca3af" />
                </TouchableOpacity>
              </View>

              {/* Column labels */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <View style={{ width: 64 }} />
                <Text style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Min BPM
                </Text>
                <View style={{ width: 24 }} />
                <Text style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Max BPM
                </Text>
              </View>

              {/* Zone rows */}
              {[0, 1, 2, 3, 4].map((i) => (
                <View
                  key={i}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 10,
                  }}
                >
                  {/* Zone label */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', width: 64 }}>
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: HR_ZONE_COLORS[i],
                        marginRight: 6,
                      }}
                    />
                    <Text style={{ fontSize: 13, fontWeight: '500', color: '#374151' }}>
                      Zone {i + 1}
                    </Text>
                  </View>

                  {/* Min input */}
                  <TextInput
                    value={zoneInputs[i].min}
                    onChangeText={(v) => updateZoneInput(i, 'min', v)}
                    keyboardType="number-pad"
                    placeholder="—"
                    placeholderTextColor="#d1d5db"
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: '#e5e7eb',
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      fontSize: 14,
                      color: '#1f2937',
                      backgroundColor: '#f9fafb',
                      textAlign: 'center',
                    }}
                  />

                  {/* Separator */}
                  <Text style={{ width: 24, textAlign: 'center', color: '#9ca3af', fontSize: 16 }}>
                    –
                  </Text>

                  {/* Max input */}
                  <TextInput
                    value={zoneInputs[i].max}
                    onChangeText={(v) => updateZoneInput(i, 'max', v)}
                    keyboardType="number-pad"
                    placeholder="—"
                    placeholderTextColor="#d1d5db"
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: '#e5e7eb',
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      fontSize: 14,
                      color: '#1f2937',
                      backgroundColor: '#f9fafb',
                      textAlign: 'center',
                    }}
                  />
                </View>
              ))}

              {hrSaveError && (
                <Text style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>
                  {hrSaveError}
                </Text>
              )}

              {/* Save button */}
              <TouchableOpacity
                onPress={handleSaveHRZones}
                style={{
                  backgroundColor: '#2563eb',
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginTop: 8,
                }}
              >
                <Text style={{ color: 'white', fontWeight: '600', fontSize: 14 }}>
                  Save Zones
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}
