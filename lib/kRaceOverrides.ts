/**
 * PMC-007: k_race multiplier overrides per duration band.
 *
 * Persisted via AsyncStorage using the same pattern as hrZones.ts / lthr.ts.
 * Default values match the hard-coded bands in raceDetection.ts (getKRace).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface KRaceOverrides {
  /** Multiplier for races shorter than 4 hours (default 1.0 — no ATL adjustment) */
  under4h: number;
  /** Multiplier for 4–8 hour races (default 1.5) */
  h4to8: number;
  /** Multiplier for 8–12 hour races (default 2.0) */
  h8to12: number;
  /** Multiplier for races longer than 12 hours (default 2.5) */
  over12h: number;
}

export const DEFAULT_KRACE_OVERRIDES: KRaceOverrides = {
  under4h: 1.0,
  h4to8: 1.5,
  h8to12: 2.0,
  over12h: 2.5,
};

const KRACE_KEY = 'krace_overrides_v1';

export async function loadKRaceOverrides(): Promise<KRaceOverrides> {
  try {
    const raw = await AsyncStorage.getItem(KRACE_KEY);
    if (!raw) return { ...DEFAULT_KRACE_OVERRIDES };
    return { ...DEFAULT_KRACE_OVERRIDES, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_KRACE_OVERRIDES };
  }
}

export async function saveKRaceOverrides(overrides: KRaceOverrides): Promise<void> {
  await AsyncStorage.setItem(KRACE_KEY, JSON.stringify(overrides));
}
