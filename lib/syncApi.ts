// URL of the local sync server (sync_server.py).
// Simulator: localhost works as-is.
// Physical device: change to your Mac's LAN IP, e.g. 'http://192.168.1.42:5001'
export const SYNC_SERVER_URL = 'http://localhost:5001';

export async function triggerSync(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SYNC_SERVER_URL}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    return json;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Sync server not reachable' };
  }
}

export async function triggerIntervalsSync(
  oldest?: string,
  newest?: string,
): Promise<{ ok: boolean; activities_upserted?: number; wellness_upserted?: number; error?: string }> {
  try {
    const body: Record<string, string> = {};
    if (oldest) body.oldest = oldest;
    if (newest) body.newest = newest;
    const res = await fetch(`${SYNC_SERVER_URL}/sync/intervals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Sync server not reachable' };
  }
}
