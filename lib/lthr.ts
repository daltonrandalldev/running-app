import AsyncStorage from '@react-native-async-storage/async-storage';

const LTHR_KEY = 'lthr_v1';

export async function loadLTHR(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(LTHR_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as number;
}

export async function saveLTHR(bpm: number): Promise<void> {
  await AsyncStorage.setItem(LTHR_KEY, JSON.stringify(bpm));
}
