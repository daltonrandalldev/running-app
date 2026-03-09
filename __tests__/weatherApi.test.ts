/**
 * ENV-002: Unit tests for lib/weatherApi.ts
 *
 * Tests URL construction, response parsing, and cache behavior.
 * No real network calls — uses mock fetch responses.
 *
 * Run with:
 *   node --experimental-strip-types __tests__/weatherApi.test.ts
 */

import {
  buildOpenMeteoUrl,
  parseOpenMeteoResponse,
  fetchActivityWeather,
  clearWeatherCache,
} from '../lib/weatherApi.ts';

// ── Minimal test harness (mirrors the pattern used in other test files) ────────

let passed = 0;
let failed = 0;

function test(description: string, fn: () => void | Promise<void>): void | Promise<void> {
  const result = (() => {
    try {
      const r = fn();
      if (r && typeof (r as any).then === 'function') {
        return (r as Promise<void>).then(
          () => {
            console.log(`  ✓ ${description}`);
            passed++;
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`  ✗ ${description}`);
            console.error(`    ${message}`);
            failed++;
          },
        );
      }
      console.log(`  ✓ ${description}`);
      passed++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${description}`);
      console.error(`    ${message}`);
      failed++;
    }
  })();
  return result as any;
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
      }
    },
    toBeCloseTo(expected: number, tolerance: number = 0.001) {
      const diff = Math.abs((actual as number) - expected);
      if (diff > tolerance) {
        throw new Error(
          `Expected ${actual} to be close to ${expected} (tolerance ±${tolerance}), diff = ${diff}`,
        );
      }
    },
    toBeGreaterThan(expected: number) {
      if ((actual as number) <= expected) {
        throw new Error(`Expected ${actual} > ${expected}`);
      }
    },
    toContain(substr: string) {
      if (typeof actual !== 'string' || !actual.includes(substr)) {
        throw new Error(`Expected "${actual}" to contain "${substr}"`);
      }
    },
    toStartWith(prefix: string) {
      if (typeof actual !== 'string' || !actual.startsWith(prefix)) {
        throw new Error(`Expected "${actual}" to start with "${prefix}"`);
      }
    },
    not: {
      toBeNull() {
        if (actual === null) {
          throw new Error(`Expected a non-null value`);
        }
      },
    },
  };
}

// ── Helper: build a realistic mock Open-Meteo response ───────────────────────

function makeMockResponse(overrides?: {
  elevation?: number;
  times?: string[];
  temps?: number[];
  humidity?: number[];
  windspeed?: number[];
  winddirection?: number[];
}) {
  const times = overrides?.times ?? [
    '2024-06-15T00:00', '2024-06-15T01:00', '2024-06-15T02:00',
    '2024-06-15T03:00', '2024-06-15T04:00', '2024-06-15T05:00',
    '2024-06-15T06:00', '2024-06-15T07:00', '2024-06-15T08:00',
    '2024-06-15T09:00', '2024-06-15T10:00', '2024-06-15T11:00',
    '2024-06-15T12:00', '2024-06-15T13:00', '2024-06-15T14:00',
    '2024-06-15T15:00', '2024-06-15T16:00', '2024-06-15T17:00',
    '2024-06-15T18:00', '2024-06-15T19:00', '2024-06-15T20:00',
    '2024-06-15T21:00', '2024-06-15T22:00', '2024-06-15T23:00',
  ];
  const temps = overrides?.temps ?? times.map((_, i) => 15 + i * 0.5);
  const humidity = overrides?.humidity ?? times.map(() => 65);
  const windspeed = overrides?.windspeed ?? times.map(() => 8.0);
  const winddirection = overrides?.winddirection ?? times.map(() => 215);

  return {
    elevation: overrides?.elevation ?? 245.3,
    hourly: {
      time: times,
      temperature_2m: temps,
      relativehumidity_2m: humidity,
      windspeed_10m: windspeed,
      winddirection_10m: winddirection,
    },
  };
}

// ── buildOpenMeteoUrl ────────────────────────────────────────────────────────

console.log('\nbuildOpenMeteoUrl');

test('base URL starts with https://archive-api.open-meteo.com/v1/archive', () => {
  const url = buildOpenMeteoUrl(51.5, -0.12, '2024-06-15');
  expect(url).toStartWith('https://archive-api.open-meteo.com/v1/archive');
});

test('contains latitude=51.5', () => {
  const url = buildOpenMeteoUrl(51.5, -0.12, '2024-06-15');
  expect(url).toContain('latitude=51.5');
});

test('contains longitude=-0.12', () => {
  const url = buildOpenMeteoUrl(51.5, -0.12, '2024-06-15');
  expect(url).toContain('longitude=-0.12');
});

test('contains start_date=2024-06-15&end_date=2024-06-15 (single-day query)', () => {
  const url = buildOpenMeteoUrl(51.5, -0.12, '2024-06-15');
  expect(url).toContain('start_date=2024-06-15');
  expect(url).toContain('end_date=2024-06-15');
});

test('contains all required hourly parameters', () => {
  const url = buildOpenMeteoUrl(51.5, -0.12, '2024-06-15');
  expect(url).toContain('temperature_2m,relativehumidity_2m,windspeed_10m,winddirection_10m');
});

test('contains timezone=UTC (NOT timezone=auto)', () => {
  const url = buildOpenMeteoUrl(51.5, -0.12, '2024-06-15');
  expect(url).toContain('timezone=UTC');
  // Ensure it does NOT contain timezone=auto
  if (url.includes('timezone=auto')) {
    throw new Error('URL must not contain timezone=auto');
  }
});

// ── parseOpenMeteoResponse ───────────────────────────────────────────────────

console.log('\nparseOpenMeteoResponse');

test('extracts temperature at hour index 7 for startTimeISO = 2024-06-15T07:30:00Z', () => {
  const mock = makeMockResponse();
  // temps[7] corresponds to '2024-06-15T07:00'
  const expectedTemp = mock.hourly.temperature_2m[7];
  const result = parseOpenMeteoResponse(mock, '2024-06-15T07:30:00Z', 3600);
  expect(result).not.toBeNull();
  expect(result!.temperatureCelsius).toBe(expectedTemp);
});

test('reads elevationM from response root elevation field', () => {
  const mock = makeMockResponse({ elevation: 512.7 });
  const result = parseOpenMeteoResponse(mock, '2024-06-15T07:30:00Z', 3600);
  expect(result).not.toBeNull();
  expect(result!.elevationM).toBe(512.7);
});

test('returns usedSegmentAdjustment = true when 2-hour activity has temps [20, 25] (delta = 5 > 3)', () => {
  // Place activity start at hour 0, with temps[0]=20, temps[1]=25 → delta=5 > 3
  const times = [
    '2024-06-15T00:00', '2024-06-15T01:00', '2024-06-15T02:00',
    '2024-06-15T03:00', '2024-06-15T04:00', '2024-06-15T05:00',
    '2024-06-15T06:00', '2024-06-15T07:00', '2024-06-15T08:00',
    '2024-06-15T09:00', '2024-06-15T10:00', '2024-06-15T11:00',
    '2024-06-15T12:00', '2024-06-15T13:00', '2024-06-15T14:00',
    '2024-06-15T15:00', '2024-06-15T16:00', '2024-06-15T17:00',
    '2024-06-15T18:00', '2024-06-15T19:00', '2024-06-15T20:00',
    '2024-06-15T21:00', '2024-06-15T22:00', '2024-06-15T23:00',
  ];
  const temps = [20, 25, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const mock = makeMockResponse({ times, temps });
  // 2-hour activity starting at midnight UTC
  const result = parseOpenMeteoResponse(mock, '2024-06-15T00:00:00Z', 7200);
  expect(result).not.toBeNull();
  expect(result!.usedSegmentAdjustment).toBe(true);
  expect(result!.midRunTempDelta).toBe(5); // 25 - 20 = 5
});

test('returns usedSegmentAdjustment = false when delta <= 3', () => {
  const times = [
    '2024-06-15T00:00', '2024-06-15T01:00', '2024-06-15T02:00',
    '2024-06-15T03:00', '2024-06-15T04:00', '2024-06-15T05:00',
    '2024-06-15T06:00', '2024-06-15T07:00', '2024-06-15T08:00',
    '2024-06-15T09:00', '2024-06-15T10:00', '2024-06-15T11:00',
    '2024-06-15T12:00', '2024-06-15T13:00', '2024-06-15T14:00',
    '2024-06-15T15:00', '2024-06-15T16:00', '2024-06-15T17:00',
    '2024-06-15T18:00', '2024-06-15T19:00', '2024-06-15T20:00',
    '2024-06-15T21:00', '2024-06-15T22:00', '2024-06-15T23:00',
  ];
  const temps = [20, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  const mock = makeMockResponse({ times, temps });
  // 2-hour activity: temps[0]=20, temps[1]=22 → delta=2 ≤ 3
  const result = parseOpenMeteoResponse(mock, '2024-06-15T00:00:00Z', 7200);
  expect(result).not.toBeNull();
  expect(result!.usedSegmentAdjustment).toBe(false);
});

test('returns midRunTempDelta = null for a 45-minute activity (single hourly point)', () => {
  const mock = makeMockResponse();
  // 45 minutes = 2700 seconds → Math.ceil(2700/3600) = 1 → single hourly point
  const result = parseOpenMeteoResponse(mock, '2024-06-15T07:30:00Z', 2700);
  expect(result).not.toBeNull();
  expect(result!.midRunTempDelta).toBeNull();
  expect(result!.usedSegmentAdjustment).toBe(false);
});

test('returns null when startHourIndex === -1 (start time not in hourly.time)', () => {
  const mock = makeMockResponse();
  // Activity on a completely different date — not in the response
  const result = parseOpenMeteoResponse(mock, '2024-06-16T07:30:00Z', 3600);
  expect(result).toBeNull();
});

test('returns null for malformed response (missing hourly field)', () => {
  const malformed = { elevation: 100 }; // no hourly field
  const result = parseOpenMeteoResponse(malformed, '2024-06-15T07:30:00Z', 3600);
  expect(result).toBeNull();
});

test('returns null for null input', () => {
  const result = parseOpenMeteoResponse(null, '2024-06-15T07:30:00Z', 3600);
  expect(result).toBeNull();
});

test('returns null for non-object input', () => {
  const result = parseOpenMeteoResponse('not an object', '2024-06-15T07:30:00Z', 3600);
  expect(result).toBeNull();
});

test('hourlyTemps array spans exactly the activity duration in hours', () => {
  const mock = makeMockResponse();
  // 2-hour activity starting at hour 6
  const result = parseOpenMeteoResponse(mock, '2024-06-15T06:00:00Z', 7200);
  expect(result).not.toBeNull();
  expect(result!.hourlyTemps.length).toBe(2);
});

// ── Cache behavior (mock fetch) ───────────────────────────────────────────────

console.log('\nCache behavior (mock fetch)');

// We install a mock global fetch that counts calls
let fetchCallCount = 0;

function installMockFetch(response: unknown, statusCode: number = 200) {
  fetchCallCount = 0;
  (globalThis as any).fetch = async (_url: string) => {
    fetchCallCount++;
    return {
      ok: statusCode === 200,
      status: statusCode,
      json: async () => response,
    };
  };
}

await test('two calls with same lat/lng/date → only one actual fetch (cache hit)', async () => {
  clearWeatherCache();
  const mock = makeMockResponse();
  installMockFetch(mock);

  const r1 = await fetchActivityWeather(51.5, -0.12, '2024-06-15T07:30:00Z', 3600);
  const r2 = await fetchActivityWeather(51.5, -0.12, '2024-06-15T09:00:00Z', 3600);

  // Both calls share the same lat/lng/date (2024-06-15 UTC) → only 1 fetch
  if (fetchCallCount !== 1) {
    throw new Error(
      `Expected exactly 1 fetch call (same lat/lng/date), got ${fetchCallCount}`,
    );
  }
  if (r1 === null || r2 === null) {
    throw new Error('Expected non-null results for valid mock responses');
  }
});

await test('different date → second fetch triggered', async () => {
  clearWeatherCache();
  const mock1 = makeMockResponse();
  const mock2 = makeMockResponse({ elevation: 999 });

  let callCount = 0;
  (globalThis as any).fetch = async (url: string) => {
    callCount++;
    const responseBody = url.includes('2024-06-15') ? mock1 : mock2;
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    };
  };

  await fetchActivityWeather(51.5, -0.12, '2024-06-15T07:30:00Z', 3600);
  await fetchActivityWeather(51.5, -0.12, '2024-06-16T07:30:00Z', 3600);

  // Two different dates → two fetches
  if (callCount !== 2) {
    throw new Error(
      `Expected exactly 2 fetch calls (different dates), got ${callCount}`,
    );
  }
});

await test('null sentinel cached: failed fetch not retried within same run', async () => {
  clearWeatherCache();
  installMockFetch({}, 429); // HTTP 429 Too Many Requests

  const r1 = await fetchActivityWeather(51.5, -0.12, '2024-06-15T07:30:00Z', 3600);
  const savedCount = fetchCallCount;

  const r2 = await fetchActivityWeather(51.5, -0.12, '2024-06-15T09:00:00Z', 3600);

  if (r1 !== null) {
    throw new Error('Expected null on 429 response');
  }
  if (r2 !== null) {
    throw new Error('Expected null from cache on second call');
  }
  if (fetchCallCount !== savedCount) {
    throw new Error(
      `Expected no additional fetch calls after caching null, but got ${fetchCallCount - savedCount} more`,
    );
  }
});

await test('fetchActivityWeather never throws — network error returns null', async () => {
  clearWeatherCache();
  (globalThis as any).fetch = async (_url: string): Promise<never> => {
    throw new Error('Network failure');
  };

  const result = await fetchActivityWeather(51.5, -0.12, '2024-06-15T07:30:00Z', 3600);
  if (result !== null) {
    throw new Error(`Expected null on network error, got ${JSON.stringify(result)}`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
