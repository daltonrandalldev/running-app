# Agent Decision Log

Centralized audit trail of all decisions made during the PRD pipeline that change or clarify the PRD or any technical design doc.

**Rules:**
- Append-only — entries are never edited or deleted
- Written by TPM Agent (product decisions) and Staff Engineer Lead (technical decisions)
- Every `[PRODUCT_QUESTION]` resolution, debate override, tiebreaker outcome, and scope change gets an entry

---

<!-- Entries are appended below in chronological order -->

---

## [2026-03-07] Section 5 — Lap-Level Data as the Only Available Stream Source

**Type:** Technical Decision (Product Scope Clarification)
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** TPM review of migrations/002_garmin_laps.sql, which documents the explicit decision NOT to sync per-second activity_records to Supabase

**Decision:**
Section 5 decoupling calculations must be computed from `garmin_activity_laps` (lap-level averages), not from per-second activity streams. The raw per-second stream exists only in the local GarminDB SQLite database and is not available via Supabase. All "half" and "quartile" splits must be constructed by aggregating sequential laps, not by slicing continuous time-series arrays.

**Rationale:**
The migration comment in 002_garmin_laps.sql states this was a deliberate architectural decision: at 500 activities a per-second stream would consume ~150 MB in Postgres. Laps give per-mile/km HR, pace, cadence, and zone time at negligible cost. The decoupling algorithm must be adapted to work within this constraint. Lap-based halves and quartiles are a valid approximation — the Friel method does not require per-second precision; representative average HR and pace per segment is sufficient.

**Impact:**
- PRD: Section 5.3 preprocessing and calculation spec updated to specify lap aggregation as the computation source; added constraint that >100m elevation gain threshold for GAP applies at activity level (from garmin_activities.ascent), not per-record
- TDD: Will require defining lap-aggregation logic (assign laps to halves/quartiles, exclude warmup laps, compute weighted averages)

---

## [2026-03-07] Section 5 — "Stable HR Data" Definition

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** Ambiguity in Requirement R1: "every run >30 minutes with stable HR data" — no definition of "stable"

**Decision:**
"Stable HR data" is defined as: avg_hr IS NOT NULL AND avg_hr > 0 on at least 75% of the laps that fall within the post-warmup window. If fewer than 75% of qualifying laps have valid HR, the activity is skipped and decoupling_pct is stored as NULL with a flag `hr_data_insufficient = true`.

**Rationale:**
Garmin activities occasionally have HR dropout (watch not seated, satellite acquisition lag). A 75% lap coverage threshold prevents garbage decoupling values from polluting the personal baseline while still tolerating occasional lap-level HR dropout. This threshold is consistent with how the PMC pipeline handles NULL active_load values (skip rather than impute).

**Impact:**
- PRD: Section 5.4 R1 acceptance criteria updated with explicit stability definition
- TDD: activity_decoupling table needs hr_data_insufficient boolean column

---

## [2026-03-07] Section 5 — Warmup Exclusion Mechanism via Laps

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** PRD says "exclude first 10 minutes (warmup stabilization)" but per-second streams are unavailable; lap boundaries don't align exactly with 10-minute marks

**Decision:**
Warmup exclusion is implemented by excluding laps whose cumulative elapsed time from activity start is less than 10 minutes. Partial laps that straddle the 10-minute boundary are excluded in full (conservative: drop the entire lap rather than splitting it). The warmup exclusion is applied before computing the half/quartile split point.

**Rationale:**
Lap granularity is typically 1 km or 1 mile for auto-lap Garmin activities, which is 4–8 minutes at easy pace — meaning one or two laps are dropped. This is slightly more conservative than the PRD's 10-minute cutoff but is the only implementable approach given the data architecture. Dropping a partial lap rather than interpolating avoids introducing synthetic averages.

**Impact:**
- PRD: Section 5.3 preprocessing updated to clarify lap-boundary-aligned warmup exclusion
- TDD: warmup exclusion logic documented in calculation spec

---

## [2026-03-07] Section 5 — GAP Dependency Handling (Section 6 Not Yet Implemented)

**Type:** Scope Change
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** Section 5 specifies using GAP when elevation data is available, but Section 6 (GAP) has not been implemented

**Decision:**
Section 5 implementation will use raw pace (avg_pace_seconds from garmin_activity_laps) for all decoupling calculations initially. A boolean column `gap_used` (default false) is stored per activity so that when Section 6 is delivered, a backfill job can recompute decoupling on GAP. The 100m elevation gain threshold check (from garmin_activities.ascent) is retained as a gate: if ascent > 100m AND gap_used = false, the activity is flagged `awaiting_gap = true` so its decoupling value is known to be terrain-uncorrected.

**Rationale:**
Building a hard dependency on Section 6 would block Section 5 delivery. The flag-and-backfill approach allows Section 5 to ship and produce useful values while making the GAP correction path explicit and automatable once Section 6 exists. This is consistent with how the codebase handles other optional dependencies (e.g., is_personalized flag in athlete_parameters).

**Impact:**
- PRD: Section 5.4 R2 updated to note GAP dependency deferred; gap_used and awaiting_gap flags added to acceptance criteria
- TDD: activity_decoupling schema must include gap_used BOOLEAN and awaiting_gap BOOLEAN

---

## [2026-03-07] Section 5 — Quartile Logic for Long Runs vs. Races

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** PRD says "for races: calculate decoupling in thirds or quartiles, not just halves" — ambiguous whether thirds or quartiles, and how this applies to long runs >2 hours

**Decision:**
Quartiles (Q1/Q2/Q3/Q4) are the standard segment scheme for both races and long runs (>2 hours). Thirds are dropped as a separate mode — quartiles are strictly more informative and consistent. For activities <2 hours and not flagged as races, only the half-split (H1/H2) decoupling is computed. For activities >2 hours or is_race = true, quartile decoupling is computed in addition to (not replacing) the half-split, so both granularities are available.

**Rationale:**
Thirds were mentioned as an alternative but offer no analytical advantage over quartiles. Maintaining two segment schemes (halves and quartiles) with thirds as a third mode would add implementation complexity for no gain. Quartiles are more actionable for ultra runners analyzing fade patterns. Retaining halves even for long runs provides backward compatibility and a simpler summary metric.

**Impact:**
- PRD: Section 5.3 updated to specify quartiles as the standard extended scheme; thirds removed
- TDD: activity_decoupling table stores ef_h1, ef_h2, decoupling_pct (from halves) plus ef_q1, ef_q2, ef_q3, ef_q4, decoupling_q1q4_pct (Q1 vs Q4) and decoupling_q1q2_pct (progressive, first vs second quarter)

---

## [2026-03-07] Section 5 — Effort Zone Definition for Personal Decoupling Baseline

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** PRD says "build personal decoupling baseline by effort zone" but doesn't define which zone system to use (HR zones, VDOT zones, pace zones)

**Decision:**
Effort zones for the personal decoupling baseline use the 5-zone HR zone system already stored in `hrZones.ts` (HRZones type: 5 zones with min/max BPM bounds). Each qualifying activity is bucketed into one of three macro-effort tiers based on its avg_hr relative to the athlete's HR zones: Easy (zones 1–2), Moderate (zone 3), Hard (zones 4–5). The full 5-zone granularity would require far more data points per bucket (the ≥20 qualifying runs threshold would need to be per-zone, not global). Three tiers provide enough discrimination to be useful while reaching the 20-run threshold on a realistic timeline for a single-athlete app.

**Rationale:**
Using the existing HR zone system avoids introducing a new zone framework. Collapsing to three macro tiers (Easy/Moderate/Hard) means a single athlete needs ~60 qualifying runs total (20 per tier) before baselines are established — achievable within 3–6 months of normal training. The VDOT zone system (lib/vdot.ts) defines zones by pace, which is less reliable for decoupling analysis where HR is the dependent variable.

**Impact:**
- PRD: Section 5.4 R4 updated to specify 3-tier macro-effort bucketing (Easy/Moderate/Hard) using existing HR zones
- TDD: decoupling_baseline table schema uses effort_tier TEXT CHECK (IN ('easy', 'moderate', 'hard'))

---

## [2026-03-07] Section 5 — Pace Units for EF Formula

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** PRD formula uses avg_pace / avg_hr but does not specify pace units; garmin_activity_laps stores pace as seconds/km; EF is conventionally unitless but the unit choice affects the numeric scale of EF values

**Decision:**
EF is computed as speed (meters per second) divided by avg_hr (bpm), matching the convention in lib/vdot.ts and Section 7 (EF_run = avg_GAP (m/s) / avg_HR). Speed is derived from lap distance (km) and moving_time_seconds: speed_mps = (distance_km * 1000) / moving_time_seconds. This gives EF values in the range of ~0.03–0.06 m/s/bpm for typical easy-to-threshold running efforts, consistent with Friel's published EF ranges converted to metric.

**Rationale:**
Using m/s rather than pace (sec/km) means faster pace = higher EF numerator, so higher EF = better efficiency. The pace formula in the PRD (pace / HR) is inverted — slower pace (higher sec/km number) would produce paradoxically higher EF. Speed-over-HR is the correct formulation and matches Section 7. Aligning with the established convention in the codebase prevents subtle sign errors downstream.

**Impact:**
- PRD: Section 5.3 formula corrected from pace/HR to speed_mps/HR; note added explaining unit convention
- TDD: lap EF calculation uses (lap_distance_km * 1000 / lap_moving_time_seconds) / lap_avg_hr

---

## [2026-03-07] Section 5 — Storage Schema: New Table vs. Columns on garmin_activities

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 5
**Agent:** TPM Agent
**Triggered by:** PRD says "stored per activity" but does not specify whether this is a new table or additional columns on garmin_activities

**Decision:**
A new table `activity_decoupling` is introduced (one row per activity) rather than adding columns to garmin_activities. The decoupling_baseline data goes into a separate `decoupling_baseline` table (one row per athlete/effort_tier). A rolling trend table `decoupling_trend` stores the 30-day rolling average per effort tier.

**Rationale:**
garmin_activities already has 40+ columns and is the core activity record; adding 10+ decoupling columns would make it unwieldy. A dedicated table follows the pattern established by daily_pmc_values and benchmark_efforts. It also enables the decoupling computation to be re-run independently without touching the source activity record. The baseline and trend data are clearly separate analytical outputs that belong in their own tables.

**Impact:**
- PRD: Section 5.4 storage schema specified as three new tables
- TDD: migration SQL for activity_decoupling, decoupling_baseline, decoupling_trend required

---

## [2026-03-07] Debate Loop: Staff Engineer 2 Concerns C1-C4 Resolved

**Type:** Technical Decision | Debate Override
**Phase:** Phase 1
**Section:** Section 5
**Agent:** Staff Engineer Lead
**Triggered by:** Staff Engineer 2 concerns raised during TDD review

**Decision:**
C4 (straddling lap proportional distribution) incorporated. C1, C2, C3 overrides upheld: client-side execution is the project-established pattern (per pmcRecalc.ts); RLS and anon role grants are consistent with all other tables per CLAUDE.md ("RLS is disabled on all current tables — no auth yet").

**Rationale:**
C4 is a real algorithmic improvement for accuracy. C1/C2/C3 are valid concerns for multi-tenant systems but inapplicable to this single-athlete app with no auth system. Overriding them maintains architectural consistency with the rest of the codebase.

**Impact:**
- PRD: none
- TDD: (1) Client-side execution note added to architecture section; (2) Half-split algorithm updated with proportional straddling-lap distribution; (3) Quartile algorithm updated with same proportional treatment.

---

## [2026-03-07] DEC-001 Code Review: Tiebreaker Invoked — C1 Override Confirmed

**Type:** Technical Decision | Tiebreaker
**Phase:** Phase 2 — Ticket 1 (DEC-001)
**Section:** Section 5
**Agent:** Staff Engineer Lead
**Triggered by:** Staff Engineer 2 blocking concern C1 — claimed `computeSegmentEF` does not use fractional lap contributions

**Decision:**
Lead overrides C1. Tiebreaker (Gemini 2.5 Flash) independently confirmed: `fractions_correctly_used: true`, `straddling_correctly_handled: true`, `bugs_found: []`, verdict "C1 concern is INVALID".

**Rationale:**
The `computeSegmentEF` function explicitly iterates `for (const f of fractions)`, computing `ft = f.lap.moving_time_seconds * f.fraction` and accumulating into `totalWeight`, `weightedSpeed`, and `weightedHr`. All 57 unit tests pass including a 20-lap regression fixture validating exact numerical output. Engineer 2's concern was based on an incomplete read of the implementation.

**Impact:**
- PRD: none
- TDD: none — implementation is correct as written