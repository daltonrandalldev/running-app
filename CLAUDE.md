# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npx expo start          # Start dev server (scan QR with Expo Go)
npx expo start --ios    # Open in iOS simulator
npx expo start --android
```

There are no lint or test scripts configured.

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
