import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { loadLTHR } from './lthr';

export type HRZoneBounds = { min: number; max: number };
export type HRZones = [HRZoneBounds, HRZoneBounds, HRZoneBounds, HRZoneBounds, HRZoneBounds];

const HR_ZONES_KEY = 'hr_zones_v1';

export async function loadHRZones(): Promise<HRZones | null> {
  const raw = await AsyncStorage.getItem(HR_ZONES_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as HRZones;
}

export async function saveHRZones(zones: HRZones): Promise<void> {
  await AsyncStorage.setItem(HR_ZONES_KEY, JSON.stringify(zones));
}

/** Returns 1-based zone number (1–5) for a given HR, or null if outside all zones. */
export function getZoneForHR(hr: number, zones: HRZones): number | null {
  for (let i = 0; i < zones.length; i++) {
    if (hr >= zones[i].min && hr <= zones[i].max) return i + 1;
  }
  return null;
}

/** Derive 5-zone HRZones from a given LTHR value using standard percentage bounds. */
function zonesFromLTHR(lthr: number): HRZones {
  return [
    { min: 0,                         max: Math.round(lthr * 0.80) },
    { min: Math.round(lthr * 0.80),   max: Math.round(lthr * 0.89) },
    { min: Math.round(lthr * 0.90),   max: Math.round(lthr * 0.93) },
    { min: Math.round(lthr * 0.94),   max: Math.round(lthr * 0.99) },
    { min: Math.round(lthr * 1.00),   max: 999 },
  ];
}

/**
 * Resolve HR zones via a four-priority chain:
 *   1. AsyncStorage HR zones (loadHRZones) — returned directly if valid
 *   2. LTHR from AsyncStorage/Supabase (loadLTHR) → derive 5-zone boundaries
 *   3. Most-recent garmin_activity_laps hrz_3_hr column → back-calculate LTHR → derive zones
 *   4. Default zones (180 bpm assumed max HR)
 */
export async function resolveHRZones(): Promise<HRZones> {
  // Priority 1: AsyncStorage HR zone array
  try {
    const zones = await loadHRZones();
    if (zones && zones[0] != null && zones[1] != null) {
      return zones;
    }
  } catch {
    // fall through
  }

  // Priority 2: LTHR → derive zones
  try {
    const lthr = await loadLTHR();
    if (lthr != null) {
      return zonesFromLTHR(lthr);
    }
  } catch {
    // fall through
  }

  // Priority 3: most recent lap-level hrz_3_hr column → back-calculate LTHR
  try {
    const { data } = await supabase
      .from('garmin_activity_laps')
      .select('hrz_3_hr, hrz_4_hr')
      .not('hrz_3_hr', 'is', null)
      .not('hrz_4_hr', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.hrz_3_hr != null) {
      const lthr = (data.hrz_3_hr as number) / 0.90;
      return zonesFromLTHR(lthr);
    }
  } catch {
    // fall through
  }

  // Priority 4: default zones (180 bpm assumed max HR)
  return [
    { min: 0,   max: 108 },
    { min: 109, max: 126 },
    { min: 127, max: 144 },
    { min: 145, max: 162 },
    { min: 163, max: 999 },
  ];
}
