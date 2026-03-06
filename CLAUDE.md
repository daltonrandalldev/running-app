# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npx expo start          # Start dev server (scan QR with Expo Go)
npx expo start --ios    # Open in iOS simulator
npx expo start --android
```

Run `npm test` to execute the PMC regression suite (Node 22+ required).

## Architecture

**Expo SDK 54** app with React Native 0.81.5. New Architecture is enabled (`newArchEnabled: true`).

### Navigation

Two-level hierarchy defined entirely in `App.tsx`:

```
NativeStackNavigator (RootStack)
├── DrawerNav → DrawerNavigator (slide drawer, blue header)
│   ├── Home       → HomeScreen
│   ├── Profile    → ProfileScreen
│   └── KeyMetrics → KeyMetricsScreen
└── ActivityDetail → ActivityDetailScreen  (receives { activityId: number })
```

- `DrawerContent.tsx` renders the custom drawer sidebar (nav items defined in `NAV_ITEMS` constant there).
- Screens inside the drawer that need to push to `ActivityDetail` must type their navigation prop as `CompositeScreenProps<DrawerScreenProps<...>, NativeStackScreenProps<RootStackParamList>>`.

### Styling

NativeWind v4 (Tailwind CSS for React Native). Class names go on `className` props. **Dynamic class names don't work** — Tailwind must see the full class string at build time. Use inline `style` props for truly dynamic values (e.g. per-row colors). Tailwind content paths cover `App.tsx`, `components/**`, and `screens/**`.

### Supabase

Client is a singleton at `lib/supabase.ts`, reading `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` from `.env`. RLS is **disabled** on all current tables (no auth yet).

Current tables:
- `activities` — run/cycle activity records fetched by `HomeScreen` and `ActivityDetailScreen`
- `race_entries` — VDOT race log; newest row is the "current" entry (old rows preserved as history)

### VDOT Library (`lib/vdot.ts`)

Pure TypeScript implementation of Jack Daniels' VDOT system. Key exports:
- `calculateVdot(distanceM, timeMin)` — derives VDOT from a race result
- `predictTime(distanceM, vdot)` — 60-iteration bisection to find predicted finish time
- `getTrainingPaces(vdot)` — returns `Record<zone, [fastSecPerKm, slowSecPerKm]>` for 5 zones (Easy 59–74%, Marathon 75–84%, Threshold 83–88%, Interval 95–100%, Repetition 105–120%)
- `parseTime(str)` — parses `"MM:SS"` or `"H:MM:SS"` to decimal minutes; throws on invalid input

All pace display is in **min/mile** (sec/km × 1.60934). `TRAINING_ZONES` array is the single source of truth for zone names, percentage bounds, and hex colors — used by both the library and `KeyMetricsScreen`.

## Docs

Product and technical design documents live in `docs/` as markdown.

```
docs/
├── prd/
│   ├── full-prd.md              # Full Endurance Performance Analytics PRD
│   └── section-02-pmc.md        # PRD Section 2 (PMC) + all 7 implementation tickets
└── tickets/
    ├── PMC-001-core-calc.md     ✅ COMPLETE
    ├── PMC-002-race-detection.md
    ├── PMC-003-benchmarks.md
    ├── PMC-004-fitting-engine.md
    ├── PMC-005-sport-specific.md
    ├── PMC-006-audit-log.md
    └── PMC-007-chart-ui.md
```

When working on PMC features, read `docs/prd/section-02-pmc.md` for full context (PRD requirements + ticket specs), or the individual ticket file for a single ticket.

### PMC Library (`lib/pmc.ts`, `lib/pmcRecalc.ts`)

PMC-001 complete. Key exports:
- `calculatePMC(activities[], params?)` — pure function; accepts `{date, tss}[]`, returns `{date, ctl, atl, tsb}[]` for every day from earliest activity to today. Defaults tc_fitness=42, tc_fatigue=7.
- `recalculatePMC(fromDate?, sport?, params?)` — reads `garmin_activities.active_load`, calls calculatePMC, upserts into `daily_pmc_values`. Call after any sync.

Schema migration for `daily_pmc_values` is in `sql/daily_pmc_values.sql` — run once in Supabase SQL editor before using `recalculatePMC`. Upsert key: `(athlete_id, date, sport)`.
