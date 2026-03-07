/**
 * PMC-007: Training model settings bottom-sheet modal.
 *
 * Sections:
 *  1. Current parameters — tc_fitness, tc_fatigue, R², last fitted, n_benchmarks
 *  2. Refit model now — triggers runFitting(), shows loading state
 *  3. Manual override — direct tc_fitness / tc_fatigue inputs (user_override audit log)
 *  4. k_race defaults — per-duration-band multiplier overrides
 *
 * Follows the same bottom-sheet pattern as the HR Zones and LTHR modals in
 * KeyMetricsScreen (slide-up, transparent backdrop, flex-end layout).
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  runFitting,
  fetchAthleteParams,
  upsertManualParams,
  getParameterHistory,
  type AthleteParams,
  type ParameterHistoryRow,
} from '../lib/pmcFittingDb';
import {
  loadKRaceOverrides,
  saveKRaceOverrides,
  DEFAULT_KRACE_OVERRIDES,
  type KRaceOverrides,
} from '../lib/kRaceOverrides';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after a successful refit or manual override — parent should increment
   *  its refreshTrigger to re-fetch chart data. */
  onRefitComplete?: () => void;
}

// ── Duration band rows for k_race table ──────────────────────────────────────

const KRACE_BANDS: {
  label: string;
  key: keyof KRaceOverrides;
}[] = [
  { label: '< 4 hours', key: 'under4h' },
  { label: '4 – 8 hours', key: 'h4to8' },
  { label: '8 – 12 hours', key: 'h8to12' },
  { label: '> 12 hours', key: 'over12h' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function PMCSettingsModal({ visible, onClose, onRefitComplete }: Props) {
  // Loading states
  const [loadingParams, setLoadingParams] = useState(false);
  const [refitting, setRefitting] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);

  // Current params (displayed in the Training Model section)
  const [currentParams, setCurrentParams] = useState<AthleteParams | null>(null);
  const [recentHistory, setRecentHistory] = useState<ParameterHistoryRow[]>([]);

  // Manual override inputs
  const [overrideTcf, setOverrideTcf] = useState('');
  const [overrideTca, setOverrideTca] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideSuccess, setOverrideSuccess] = useState(false);

  // k_race overrides
  const [krace, setKrace] = useState<KRaceOverrides>({ ...DEFAULT_KRACE_OVERRIDES });
  const [kraceInputs, setKraceInputs] = useState<Record<keyof KRaceOverrides, string>>({
    under4h: '',
    h4to8: '',
    h8to12: '',
    over12h: '',
  });
  const [kraceError, setKraceError] = useState<string | null>(null);
  const [kraceSaved, setKraceSaved] = useState(false);

  // Refit result message
  const [refitMessage, setRefitMessage] = useState<string | null>(null);

  // ── Load on open ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    loadModalData();
  }, [visible]);

  async function loadModalData() {
    setLoadingParams(true);
    setRefitMessage(null);
    setOverrideSuccess(false);
    setKraceSaved(false);
    try {
      const [params, history, savedKrace] = await Promise.all([
        fetchAthleteParams('combined'),
        getParameterHistory(),
        loadKRaceOverrides(),
      ]);

      setCurrentParams(params);
      setOverrideTcf(String(Math.round(params.tc_fitness)));
      setOverrideTca(String(Math.round(params.tc_fatigue)));
      setRecentHistory(history.slice(0, 5));

      setKrace(savedKrace);
      setKraceInputs({
        under4h: String(savedKrace.under4h),
        h4to8: String(savedKrace.h4to8),
        h8to12: String(savedKrace.h8to12),
        over12h: String(savedKrace.over12h),
      });
    } catch (e: any) {
      console.warn('[PMCSettingsModal] loadModalData error:', e?.message);
    } finally {
      setLoadingParams(false);
    }
  }

  // ── Refit ───────────────────────────────────────────────────────────────

  async function handleRefit() {
    setRefitting(true);
    setRefitMessage(null);
    try {
      const result = await runFitting(undefined, 'combined');
      if (!result.ok) {
        setRefitMessage(`Refit failed: ${result.error ?? 'unknown error'}`);
        return;
      }
      if (result.result && !('tc_fitness' in result.result)) {
        // eligible: false branch
        const r = result.result;
        setRefitMessage(
          `Not yet eligible — need 6+ benchmarks over 6+ months ` +
            `(current: ${r.count} benchmarks, ${r.months_span.toFixed(1)} months).`,
        );
        return;
      }
      if (result.result && 'tc_fitness' in result.result) {
        const r = result.result;
        setRefitMessage(
          `Model updated — tc=${Math.round(r.tc_fitness)}/${Math.round(r.tc_fatigue)}, R²=${r.r2.toFixed(2)}.`,
        );
      }
      await loadModalData();
      onRefitComplete?.();
    } catch (e: any) {
      setRefitMessage(`Error: ${e?.message ?? 'unknown'}`);
    } finally {
      setRefitting(false);
    }
  }

  // ── Manual override ──────────────────────────────────────────────────────

  async function handleSaveOverride() {
    setOverrideError(null);
    const tcf = parseFloat(overrideTcf);
    const tca = parseFloat(overrideTca);

    if (isNaN(tcf) || tcf < 20 || tcf > 60) {
      setOverrideError('Fitness decay (tc_fitness) must be 20 – 60 days.');
      return;
    }
    if (isNaN(tca) || tca < 3 || tca > 14) {
      setOverrideError('Fatigue decay (tc_fatigue) must be 3 – 14 days.');
      return;
    }

    setSavingOverride(true);
    try {
      const result = await upsertManualParams(tcf, tca, 'combined');
      if (!result.ok) {
        setOverrideError(result.error ?? 'Failed to save.');
        return;
      }
      setOverrideSuccess(true);
      await loadModalData();
      onRefitComplete?.();
    } catch (e: any) {
      setOverrideError(e?.message ?? 'Unknown error.');
    } finally {
      setSavingOverride(false);
    }
  }

  // ── k_race save ──────────────────────────────────────────────────────────

  async function handleSaveKrace() {
    setKraceError(null);
    const parsed: Partial<KRaceOverrides> = {};
    for (const { key } of KRACE_BANDS) {
      const v = parseFloat(kraceInputs[key]);
      if (isNaN(v) || v < 1.0 || v > 5.0) {
        setKraceError(`${key}: multiplier must be between 1.0 and 5.0.`);
        return;
      }
      parsed[key] = Math.round(v * 100) / 100;
    }
    try {
      const next = { ...DEFAULT_KRACE_OVERRIDES, ...parsed } as KRaceOverrides;
      await saveKRaceOverrides(next);
      setKrace(next);
      setKraceSaved(true);
      setTimeout(() => setKraceSaved(false), 2000);
    } catch (e: any) {
      setKraceError(e?.message ?? 'Failed to save.');
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function r2Label(r2: number | null): string {
    if (r2 === null) return '—';
    const label = r2 > 0.75 ? 'High' : r2 >= 0.5 ? 'Medium' : 'Low';
    return `${r2.toFixed(2)} (${label})`;
  }

  function r2Color(r2: number | null): string {
    if (r2 === null) return '#9ca3af';
    if (r2 > 0.75) return '#16a34a';
    if (r2 >= 0.5) return '#d97706';
    return '#dc2626';
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/* Backdrop */}
        <TouchableOpacity
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
          }}
          onPress={onClose}
          activeOpacity={1}
        />

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View
            style={{
              backgroundColor: 'white',
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              maxHeight: '88%',
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 24,
                paddingTop: 20,
                paddingBottom: 16,
                borderBottomWidth: 1,
                borderBottomColor: '#f3f4f6',
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: '600', color: '#111827' }}>
                Training Model Settings
              </Text>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle-outline" size={24} color="#9ca3af" />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ paddingHorizontal: 24 }}
              contentContainerStyle={{ paddingTop: 20, paddingBottom: 40 }}
              showsVerticalScrollIndicator={false}
            >
              {loadingParams ? (
                <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                  <ActivityIndicator color="#2563eb" />
                </View>
              ) : (
                <>
                  {/* ── Section 1: Current Parameters ────────────────── */}
                  <SectionHeader title="Training Model" />

                  <InfoRow
                    label="Status"
                    value={currentParams?.is_personalized ? 'Personalized' : 'Standard defaults'}
                    valueColor={currentParams?.is_personalized ? '#2563eb' : '#6b7280'}
                  />
                  <InfoRow
                    label="Fitness decay (tc_fitness)"
                    value={
                      currentParams
                        ? `${Math.round(currentParams.tc_fitness)} days`
                        : '42 days'
                    }
                  />
                  <InfoRow
                    label="Fatigue decay (tc_fatigue)"
                    value={
                      currentParams
                        ? `${Math.round(currentParams.tc_fatigue)} days`
                        : '7 days'
                    }
                  />
                  <InfoRow
                    label="Model fit (R²)"
                    value={r2Label(currentParams?.r_squared ?? null)}
                    valueColor={r2Color(currentParams?.r_squared ?? null)}
                  />
                  <InfoRow
                    label="Benchmarks used"
                    value={
                      currentParams?.n_benchmarks != null
                        ? String(currentParams.n_benchmarks)
                        : '—'
                    }
                  />
                  <InfoRow
                    label="Last fitted"
                    value={formatDate(currentParams?.fitted_at ?? null)}
                    isLast
                  />

                  {/* ── Section 2: Refit ─────────────────────────────── */}
                  <SectionHeader title="Refit Model" topMargin />

                  <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                    Re-runs the optimizer against all current benchmark efforts. Requires 6+
                    benchmarks spanning 6+ months.
                  </Text>

                  <TouchableOpacity
                    onPress={handleRefit}
                    disabled={refitting}
                    style={{
                      backgroundColor: refitting ? '#93c5fd' : '#2563eb',
                      borderRadius: 12,
                      paddingVertical: 13,
                      alignItems: 'center',
                    }}
                  >
                    {refitting ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <ActivityIndicator size="small" color="white" />
                        <Text style={{ color: 'white', fontWeight: '600', fontSize: 14 }}>
                          Updating model…
                        </Text>
                      </View>
                    ) : (
                      <Text style={{ color: 'white', fontWeight: '600', fontSize: 14 }}>
                        Refit model now
                      </Text>
                    )}
                  </TouchableOpacity>

                  {refitMessage && (
                    <Text
                      style={{
                        fontSize: 12,
                        color: refitMessage.startsWith('Model updated') ? '#16a34a' : '#dc2626',
                        marginTop: 8,
                        lineHeight: 17,
                      }}
                    >
                      {refitMessage}
                    </Text>
                  )}

                  {/* Recent change history */}
                  {recentHistory.length > 0 && (
                    <View style={{ marginTop: 14 }}>
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '600',
                          color: '#9ca3af',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 6,
                        }}
                      >
                        Recent changes
                      </Text>
                      {recentHistory.map((row) => (
                        <View
                          key={row.id}
                          style={{
                            backgroundColor: '#f9fafb',
                            borderRadius: 8,
                            padding: 10,
                            marginBottom: 6,
                          }}
                        >
                          <Text style={{ fontSize: 11, color: '#374151', lineHeight: 16 }}>
                            {row.plain_english}
                          </Text>
                          <Text style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                            {formatDate(row.created_at)} · {row.change_source}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* ── Section 3: Manual Override ────────────────────── */}
                  <SectionHeader title="Manual Override" topMargin />

                  <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
                    For advanced use. Directly set time constants and they will be logged as
                    a user override in the audit log.
                  </Text>

                  <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabel}>Fitness decay (days)</Text>
                      <TextInput
                        value={overrideTcf}
                        onChangeText={(v) => {
                          setOverrideTcf(v);
                          setOverrideError(null);
                          setOverrideSuccess(false);
                        }}
                        keyboardType="decimal-pad"
                        placeholder="20 – 60"
                        placeholderTextColor="#d1d5db"
                        style={styles.input}
                      />
                      <Text style={styles.inputHint}>Range: 20 – 60</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabel}>Fatigue decay (days)</Text>
                      <TextInput
                        value={overrideTca}
                        onChangeText={(v) => {
                          setOverrideTca(v);
                          setOverrideError(null);
                          setOverrideSuccess(false);
                        }}
                        keyboardType="decimal-pad"
                        placeholder="3 – 14"
                        placeholderTextColor="#d1d5db"
                        style={styles.input}
                      />
                      <Text style={styles.inputHint}>Range: 3 – 14</Text>
                    </View>
                  </View>

                  {overrideError && (
                    <Text style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>
                      {overrideError}
                    </Text>
                  )}
                  {overrideSuccess && (
                    <Text style={{ color: '#16a34a', fontSize: 12, marginBottom: 8 }}>
                      Parameters saved and PMC recalculated.
                    </Text>
                  )}

                  <TouchableOpacity
                    onPress={handleSaveOverride}
                    disabled={savingOverride}
                    style={{
                      backgroundColor: savingOverride ? '#e5e7eb' : '#f3f4f6',
                      borderRadius: 12,
                      paddingVertical: 12,
                      alignItems: 'center',
                      borderWidth: 1,
                      borderColor: '#e5e7eb',
                    }}
                  >
                    {savingOverride ? (
                      <ActivityIndicator size="small" color="#6b7280" />
                    ) : (
                      <Text style={{ color: '#374151', fontWeight: '600', fontSize: 14 }}>
                        Apply override
                      </Text>
                    )}
                  </TouchableOpacity>

                  {/* ── Section 4: k_race Defaults ───────────────────── */}
                  <SectionHeader title="Race Load Multipliers (k_race)" topMargin />

                  <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
                    ATL is multiplied by this factor for race activities of each duration.
                    CTL is always based on raw TSS.
                  </Text>

                  {/* Column headers */}
                  <View
                    style={{
                      flexDirection: 'row',
                      marginBottom: 8,
                      paddingHorizontal: 4,
                    }}
                  >
                    <Text style={{ flex: 1, fontSize: 11, color: '#9ca3af', fontWeight: '600' }}>
                      Duration
                    </Text>
                    <Text
                      style={{
                        width: 80,
                        fontSize: 11,
                        color: '#9ca3af',
                        fontWeight: '600',
                        textAlign: 'center',
                      }}
                    >
                      Multiplier
                    </Text>
                  </View>

                  {KRACE_BANDS.map(({ label, key }, i) => (
                    <View
                      key={key}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 8,
                        borderBottomWidth: i < KRACE_BANDS.length - 1 ? 1 : 0,
                        borderBottomColor: '#f3f4f6',
                      }}
                    >
                      <Text style={{ flex: 1, fontSize: 13, color: '#374151' }}>{label}</Text>
                      <TextInput
                        value={kraceInputs[key]}
                        onChangeText={(v) => {
                          setKraceInputs((prev) => ({ ...prev, [key]: v }));
                          setKraceError(null);
                          setKraceSaved(false);
                        }}
                        keyboardType="decimal-pad"
                        style={{
                          width: 80,
                          borderWidth: 1,
                          borderColor: '#e5e7eb',
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          fontSize: 14,
                          color: '#1f2937',
                          backgroundColor: '#f9fafb',
                          textAlign: 'center',
                        }}
                      />
                    </View>
                  ))}

                  {kraceError && (
                    <Text style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>
                      {kraceError}
                    </Text>
                  )}
                  {kraceSaved && (
                    <Text style={{ color: '#16a34a', fontSize: 12, marginTop: 8 }}>
                      Multipliers saved.
                    </Text>
                  )}

                  <TouchableOpacity
                    onPress={handleSaveKrace}
                    style={{
                      backgroundColor: '#f3f4f6',
                      borderRadius: 12,
                      paddingVertical: 12,
                      alignItems: 'center',
                      marginTop: 14,
                      borderWidth: 1,
                      borderColor: '#e5e7eb',
                    }}
                  >
                    <Text style={{ color: '#374151', fontWeight: '600', fontSize: 14 }}>
                      Save multipliers
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ── Small layout helpers ──────────────────────────────────────────────────────

function SectionHeader({ title, topMargin }: { title: string; topMargin?: boolean }) {
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        color: '#6b7280',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginTop: topMargin ? 24 : 0,
        marginBottom: 12,
      }}
    >
      {title}
    </Text>
  );
}

function InfoRow({
  label,
  value,
  valueColor,
  isLast,
}: {
  label: string;
  value: string;
  valueColor?: string;
  isLast?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 9,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: '#f3f4f6',
      }}
    >
      <Text style={{ fontSize: 13, color: '#6b7280' }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '500', color: valueColor ?? '#111827' }}>
        {value}
      </Text>
    </View>
  );
}

const styles = {
  inputLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: '#6b7280',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1f2937',
    backgroundColor: '#f9fafb',
    textAlign: 'center' as const,
  },
  inputHint: {
    fontSize: 10,
    color: '#9ca3af',
    marginTop: 4,
    textAlign: 'center' as const,
  },
};
