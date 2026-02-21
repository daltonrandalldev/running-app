import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const LTHR_KEY = 'lthr_v1';

export async function loadLTHR(): Promise<number | null> {
  // Prefer local cache for instant reads
  const raw = await AsyncStorage.getItem(LTHR_KEY);
  if (raw != null) return JSON.parse(raw) as number;

  // Fallback to Supabase (e.g. after a fresh install)
  const { data } = await supabase
    .from('lthr_settings')
    .select('bpm')
    .eq('id', 1)
    .single();
  if (data?.bpm != null) {
    await AsyncStorage.setItem(LTHR_KEY, JSON.stringify(data.bpm));
    return data.bpm as number;
  }

  return null;
}

export async function saveLTHR(bpm: number): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(LTHR_KEY, JSON.stringify(bpm)),
    supabase.from('lthr_settings').upsert({
      id: 1,
      bpm,
      updated_at: new Date().toISOString(),
    }),
  ]);
}
