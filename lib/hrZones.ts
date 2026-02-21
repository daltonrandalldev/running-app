import AsyncStorage from '@react-native-async-storage/async-storage';

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
