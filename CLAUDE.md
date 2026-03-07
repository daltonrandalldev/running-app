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
│   ├── prd.md              # Full Endurance Performance Analytics PRD
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

---

## PRD Pipeline Workflow

This section governs the multi-agent `/prd-section` pipeline. These rules apply when the pipeline is running and take precedence over ad-hoc instructions during pipeline execution.

### Overview

Trigger with `/prd-section <N>` to run the full PRD-to-code pipeline for a section. The Program Manager (main session) orchestrates all agents. No agent invokes another agent directly.

### File Conventions

```
docs/
  prd/
    prd.md                       # Source of truth — only TPM agent may write to this
  output/
    section-N-tech-design.md          # Output of Staff Engineer Lead
    section-N-ticket-prompts.md       # Output of Prompt Engineer
  agent-decision-log.md               # Centralized log of all decisions that change the PRD or TDD
```

All pipeline output files use the `section-N-` naming prefix. Section number comes from the `/prd-section` command argument.

### Agent Decision Log

`docs/agent-decision-log.md` is the centralized audit trail for every decision made during the pipeline that changes or clarifies the PRD or any technical design doc. It is append-only — entries are never edited or deleted.

**Who writes to it:**
- TPM Agent — logs product/strategy decisions and PRD clarifications
- Staff Engineer Lead — logs technical design decisions, especially debate overrides and tiebreaker outcomes

**When to write an entry:**
- A `[PRODUCT_QUESTION]` is resolved and changes or clarifies the PRD
- A debate loop results in an override (Lead overrides Engineer 2's concern)
- A tiebreaker is invoked and a final call is made
- The TDD is materially changed after initial sign-off
- Any scope change, however small, is agreed upon during Phase 2

**Entry format:**
```markdown
## [YYYY-MM-DD] <Decision Title>

**Type:** Product Decision | Technical Decision | Scope Change | Debate Override | Tiebreaker
**Phase:** Phase 1 | Phase 2 — Ticket N
**Section:** Section N
**Agent:** TPM Agent | Staff Engineer Lead
**Triggered by:** <what caused this — e.g. PRODUCT_QUESTION from Staff Engineer Lead, Engineer 2 concern>

**Decision:**
<What was decided, in 1-3 sentences>

**Rationale:**
<Why this decision was made>

**Impact:**
- PRD: <what changed in prd.md, or "none">
- TDD: <what changed in section-N-tech-design.md, or "none">
```

### Agent Roster

| Agent | Model | Phase | Write Access |
|---|---|---|---|
| Program Manager | (main session) | Both | Orchestration only |
| TPM Agent | claude-sonnet-4-6 | Both | docs/prd/prd.md, docs/agent-decision-log.md |
| Staff Engineer Lead | claude-opus-4-6 | Both | docs/output/, src/, docs/agent-decision-log.md |
| Staff Engineer 2 | gemini-2.5-pro (external) | Both | None (review only) |
| Prompt Engineer | claude-sonnet-4-6 | Phase 1 | docs/output/ |
| QA Engineer | claude-sonnet-4-6 | Phase 2 | None (review only) |
| Tiebreaker | gemini-2.5-flash (external) | Both | None |

### Calling External Models

```bash
bash .claude/scripts/call-gemini.sh "gemini-2.5-pro" "<prompt>"   # Staff Engineer 2
bash .claude/scripts/call-gemini.sh "gemini-2.5-flash" "<prompt>" # Tiebreaker
```

### Debate Loop Protocol

1. Staff Engineer Lead produces output (design doc or code)
2. Staff Engineer 2 reviews and returns: `concerns[], approved: bool, rationale`
3. If approved: proceed
4. If not approved:
   - **Round 1:** Pass concerns to Lead. Lead responds with: `incorporated[], overridden[], override_rationale[]`
   - **Round 2:** Pass Lead response to Engineer 2 for final review
   - **If still unresolved:** invoke Tiebreaker (Gemini 2.5 Flash) for recommendation
   - Lead makes final call and documents decision in output file
5. Maximum 2 debate rounds + 1 tiebreaker. Lead always has final say.

### Product Question Routing

If any agent output contains `[PRODUCT_QUESTION: <question>]`:
1. Pause the current workflow step immediately
2. Invoke TPM Agent with the question and full current context
3. TPM Agent resolves, logs the decision to `docs/prd/prd.md`, and appends an entry to `docs/agent-decision-log.md`
4. Resume the paused step with the answer

### Context Clearing Rules

**After Phase 1 completes** — clear all context. Reload only:
- `docs/output/section-N-tech-design.md`
- `docs/output/section-N-ticket-prompts.md`

**Between each ticket in Phase 2** — clear context. Reload only:
- The specific ticket prompt from `section-N-ticket-prompts.md` (verbatim — no paraphrasing)
- `docs/output/section-N-tech-design.md`
- Current ticket's code files (once written)

**TPM Agent exception** — TPM maintains continuity across the entire workflow. Resume (don't restart) when invoked mid-Phase 2.

### Phase 1 Completion Checklist
- [ ] TPM Agent has extracted the scoped PRD section
- [ ] All `[PRODUCT_QUESTION]` markers resolved
- [ ] Tech design doc written and signed off by Lead
- [ ] Debate loop completed (aligned or Lead override documented)
- [ ] Ticket prompts doc written by Prompt Engineer with consistent `## Ticket N` headers
- [ ] PRD updated by TPM with any decisions made
- [ ] All decisions logged to docs/agent-decision-log.md

### Phase 2 Ticket Completion Checklist
- [ ] Program Manager loaded ticket prompt verbatim from `section-N-ticket-prompts.md`
- [ ] Code written by Staff Engineer Lead
- [ ] Code reviewed by Staff Engineer 2
- [ ] Debate loop completed or tiebreaker invoked
- [ ] PR created once Lead and Engineer 2 aligned
- [ ] QA Engineer validated against acceptance criteria
- [ ] Staff Engineer Lead merged PR to main
- [ ] Context cleared before next ticket