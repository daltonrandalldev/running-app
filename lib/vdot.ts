export type RaceDistance = {
  name: string;
  meters: number;
};

export const RACE_DISTANCES: RaceDistance[] = [
  { name: '1 Mile', meters: 1609.34 },
  { name: '5K', meters: 5000 },
  { name: '8K', meters: 8000 },
  { name: '10K', meters: 10000 },
  { name: '15K', meters: 15000 },
  { name: '10 Miles', meters: 16093.4 },
  { name: 'Half Marathon', meters: 21097.5 },
  { name: '25K', meters: 25000 },
  { name: '30K', meters: 30000 },
  { name: 'Marathon', meters: 42195 },
];

export const PREDICTION_DISTANCES: RaceDistance[] = [
  { name: '5K', meters: 5000 },
  { name: '10K', meters: 10000 },
  { name: 'Half Marathon', meters: 21097.5 },
  { name: 'Marathon', meters: 42195 },
];

export const TRAINING_ZONES = [
  { key: 'Easy (E)',        slowPct: 0.59, fastPct: 0.74, color: '#3b82f6' },
  { key: 'Marathon (M)',    slowPct: 0.75, fastPct: 0.84, color: '#22c55e' },
  { key: 'Threshold (T)',   slowPct: 0.83, fastPct: 0.88, color: '#eab308' },
  { key: 'Interval (I)',    slowPct: 0.95, fastPct: 1.00, color: '#f97316' },
  { key: 'Repetition (R)', slowPct: 1.05, fastPct: 1.20, color: '#ef4444' },
];

// VO2 demand (mL/kg/min) at velocity v (m/min) — Jack Daniels formula
function vo2AtVelocity(v: number): number {
  return -4.60 + 0.182258 * v + 0.000104 * v * v;
}

// Fraction of VO2max sustainable for a race of duration t (minutes)
function pctVo2max(t: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * t) +
    0.2989558 * Math.exp(-0.1932605 * t)
  );
}

export function calculateVdot(distanceM: number, timeMin: number): number {
  const velocity = distanceM / timeMin; // m/min
  return vo2AtVelocity(velocity) / pctVo2max(timeMin);
}

// Bisect to find race time (minutes) for a given distance and VDOT
export function predictTime(distanceM: number, vdot: number): number {
  let lo = 1;
  let hi = 600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // Higher VDOT at mid means mid is too fast (too short) — need more time
    if (calculateVdot(distanceM, mid) > vdot) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// Velocity (m/min) that demands pct * vdot VO2 in steady state
function velocityAtPct(vdot: number, pct: number): number {
  const targetVo2 = vdot * pct;
  // Solve: 0.000104*v^2 + 0.182258*v - (targetVo2 + 4.60) = 0
  const a = 0.000104;
  const b = 0.182258;
  const c = -(targetVo2 + 4.60);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

// Returns Record<zone key, [fastSecPerKm, slowSecPerKm]>
export function getTrainingPaces(vdot: number): Record<string, [number, number]> {
  const result: Record<string, [number, number]> = {};
  for (const zone of TRAINING_ZONES) {
    const fastVel = velocityAtPct(vdot, zone.fastPct); // higher pct → faster velocity → lower sec/km
    const slowVel = velocityAtPct(vdot, zone.slowPct);
    result[zone.key] = [60000 / fastVel, 60000 / slowVel];
  }
  return result;
}

export function formatTime(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatPaceMile(secPerKm: number): string {
  const secPerMile = secPerKm * 1.60934;
  let mins = Math.floor(secPerMile / 60);
  let secs = Math.round(secPerMile % 60);
  if (secs === 60) {
    mins += 1;
    secs = 0;
  }
  return `${mins}:${String(secs).padStart(2, '0')}/mi`;
}

export function predictedPaceMile(distanceM: number, timeMin: number): string {
  const minPerKm = timeMin / (distanceM / 1000);
  return formatPaceMile(minPerKm * 60);
}

// Accepts "MM:SS" or "H:MM:SS". Throws on invalid input.
export function parseTime(str: string): number {
  const parts = str.trim().split(':');
  if (parts.length === 2) {
    const mins = parseInt(parts[0], 10);
    const secs = parseInt(parts[1], 10);
    if (isNaN(mins) || isNaN(secs) || mins < 0 || secs < 0 || secs >= 60) {
      throw new Error('Invalid time');
    }
    return mins + secs / 60;
  }
  if (parts.length === 3) {
    const hrs = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    const secs = parseInt(parts[2], 10);
    if (
      isNaN(hrs) || isNaN(mins) || isNaN(secs) ||
      hrs < 0 || mins < 0 || secs < 0 ||
      mins >= 60 || secs >= 60
    ) {
      throw new Error('Invalid time');
    }
    return hrs * 60 + mins + secs / 60;
  }
  throw new Error('Invalid time format');
}
