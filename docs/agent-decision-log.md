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

---

## [2026-03-07] Section 6 — GAP Formulation: Minetti Only (REVIEW Marker Resolved)

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 6
**Agent:** TPM Agent
**Triggered by:** [REVIEW] marker in Section 6.3 asking whether to implement Minetti, Strava, or both GAP formulations

**Decision:**
Minetti's original polynomial (Minetti et al., 2002) is the sole formulation implemented. Strava's proprietary version and GOVSS are not implemented.

**Rationale:**
Strava's GAP algorithm is undocumented and cannot be faithfully reproduced — any implementation would be an approximation of an approximation. GOVSS is a further simplification. The Minetti curve is the only formulation grounded in peer-reviewed physiology and is the appropriate choice for a scientifically rigorous analytics platform. The PRD already recommended it as default; there is no user value in dual-formulation comparison at this stage of a single-athlete app.

**Impact:**
- PRD: Section 6.2 [REVIEW] block removed; Minetti-only decision stated explicitly; alternative formulations removed from background text
- TDD: none yet

---

## [2026-03-07] Section 6 — Per-Record Stream Conflict: Adapt to Per-Lap Computation

**Type:** Technical Decision (Product Scope Clarification)
**Phase:** Phase 1
**Section:** Section 6
**Agent:** TPM Agent
**Triggered by:** PRD Section 6.3 stated "Applied per-record in the activity stream" — per-second activity records are not available in Supabase (same constraint documented for Section 5)

**Decision:**
GAP is computed at lap granularity using `garmin_activity_laps`. Grade per lap is calculated as `(ascent - descent) / (distance_km * 1000)` using the lap's existing `ascent`, `descent`, and `distance` columns. All requirements language referring to "per stream record" or "per record" is updated to "per lap."

**Rationale:**
This is the same architectural constraint that reshaped Section 5. The lap table already contains the elevation fields needed (ascent, descent in meters, distance in km), so per-lap grade is fully computable without any new data. Lap-level grade is a coarser but practically sufficient granularity — a full-kilometer lap at 10% average grade is a meaningful elevation segment and the Minetti adjustment is valid at that scale.

**Impact:**
- PRD: Section 6.3 rewritten to specify per-lap computation; formula updated; "per-record in the activity stream" language removed throughout Section 6.3 and 6.4
- TDD: implementation must use garmin_activity_laps as the computation source

---

## [2026-03-07] Section 6 — Elevation Smoothing: Not Applicable at Lap Level

**Type:** Technical Decision (Product Scope Clarification)
**Phase:** Phase 1
**Section:** Section 6
**Agent:** TPM Agent
**Triggered by:** PRD Section 6.3 specified a 30-second moving average or Kalman filter to smooth raw GPS elevation noise — this is a per-second stream operation and is not applicable to lap-level data

**Decision:**
The 30-second moving average and Kalman filter smoothing steps are removed from the specification. At lap granularity, GarminDB aggregates lap-level ascent and descent directly from the FIT file records (which use barometric altimeter data on equipped Garmin devices). The lap aggregation itself provides low-frequency smoothing equivalent to — or better than — a 30-second window. No additional smoothing is required or implementable at lap level.

**Rationale:**
Smoothing was specified to address per-second GPS altitude noise. The barometric altimeter data that GarminDB reads into `ascent`/`descent` is already higher quality than GPS elevation, and the aggregation across an entire lap (typically 4–8 minutes of data) eliminates the short-window noise the smoothing was designed to address. Implementing a synthetic smoothing step at lap level would be meaningless.

**Impact:**
- PRD: Section 6.3 "Elevation data smoothing" subsection replaced with explanation of barometric altimeter data path through GarminDB to lap-level ascent/descent columns; no smoothing step specified
- TDD: no smoothing implementation required

---

## [2026-03-07] Section 6 — Grade Clamping at Extreme Values

**Type:** Technical Decision
**Phase:** Phase 1
**Section:** Section 6
**Agent:** TPM Agent
**Triggered by:** The Minetti polynomial produces near-zero or negative C(g) values at grades steeper than approximately -45%, which would cause GAP to blow up to infinity or invert; no clamping was specified in the PRD

**Decision:**
Grade is clamped to [-0.40, +0.45] (fractional) before evaluating C(g). A boolean `grade_clamped` flag is stored per lap record in the `lap_gap` table to indicate when clamping was applied.

**Rationale:**
At g = -0.45, C(g) approaches ~0.2 J/kg/m, causing GAP to be ~18x actual pace — physiologically nonsensical. Real trail running rarely sustains a full lap at grades outside this range, so clamping affects only outlier laps (e.g., a very steep descent). The flag preserves transparency: analysts can see which laps had extreme grades without corrupting the GAP value. The specific bounds [-0.40, +0.45] correspond to approximately -40% and +45% grades, which are at or beyond the steepest runnable sustained terrain.

**Impact:**
- PRD: Section 6.3 "Grade clamping" subsection added; Section 6.4 requirements table updated to include grade_clamped flag in acceptance criteria
- TDD: implementation must clamp g before polynomial evaluation and record the flag

---

## [2026-03-07] Section 6 — Activity Average GAP: Distance-Weighted Mean of Lap GAP Values

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 6
**Agent:** TPM Agent
**Triggered by:** PRD said "averaged for summary stats" but did not specify the averaging method; with lap-level data, a simple mean would weight a short 200m lap equally to a 1km lap

**Decision:**
Activity-level average GAP pace is the distance-weighted mean of per-lap GAP pace values: `avg_gap_pace = Σ(lap_gap_pace * lap_distance) / Σ(lap_distance)`. Laps with NULL or zero distance or moving_time are excluded. Laps with NULL ascent AND NULL descent are treated as grade = 0 (GAP equals actual pace for those laps).

**Rationale:**
Distance-weighted averaging is the correct aggregation because pace is a rate measured over distance — each meter contributes equally to the average, not each lap. A simple arithmetic mean would distort the result whenever lap distances are unequal (which is common for the first or last partial lap). This is consistent with how Section 5 computes weighted-average EF from laps.

**Impact:**
- PRD: Section 6.3 "Activity-level average GAP" formula specified explicitly; NULL handling for elevation data documented
- TDD: computeGAP function must use distance-weighted mean

---

## [2026-03-07] Section 6 — Storage Schema: Two New Tables (activity_gap and lap_gap)

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 6
**Agent:** TPM Agent
**Triggered by:** PRD said "store both raw pace and GAP per activity and per stream record" but did not specify whether to add columns to garmin_activities/garmin_activity_laps or create new tables

**Decision:**
Two new tables are introduced: `activity_gap` (one row per activity, storing activity-level summary GAP values) and `lap_gap` (one row per activity_id + lap, storing per-lap raw pace, GAP pace, grade, and grade_clamped flag). No columns are added to the existing `garmin_activities` or `garmin_activity_laps` tables.

**Rationale:**
Follows the pattern established by Section 5 (activity_decoupling as a separate table) and Section 2 (daily_pmc_values as a separate table). The source tables garmin_activities and garmin_activity_laps are synced from GarminDB and should remain a clean mirror of the source data. GAP is a derived analytical output that belongs in its own tables, enabling independent recomputation and clean separation of ingestion from analytics. The `activity_gap` table also serves as the trigger point for Section 5's backfill: when gap_used = false AND awaiting_gap = true on an activity_decoupling row, the system can check activity_gap for a computed value and update.

**Impact:**
- PRD: Section 6.4 requirements table updated to name the two new tables and their key columns
- TDD: migration SQL for activity_gap and lap_gap required; both tables follow RLS-disabled, anon-granted pattern consistent with all other tables

---

## [2026-03-07] Section 6 TDD Review: C1 Override — RLS/Permissions Pattern

**Type:** Debate Override
**Phase:** Phase 1
**Section:** Section 6
**Agent:** Staff Engineer Lead
**Triggered by:** Staff Engineer 2 C1 concern about anon/authenticated GRANT with RLS disabled

**Decision:**
C1 overridden. RLS disabled with GRANT to anon/authenticated is the established project-wide pattern (documented in CLAUDE.md) applied to every existing table. This was also overridden in the Section 5 debate loop for identical reasons.

**Rationale:**
This is a single-athlete app with no auth system. Engineer 2's concern is valid for multi-tenant systems but inapplicable here. Changing this pattern for Section 6 alone would create architectural inconsistency with daily_pmc_values, activity_decoupling, and every other table in the codebase. The scope of Section 6 does not include introducing authentication infrastructure.

**Impact:**
- PRD: none
- TDD: none — SQL schema is correct as designed

---

## [2026-03-08] GAP-001 Code Review: C1 Override — C_FLAT and round2 Are Defined

**Type:** Debate Override
**Phase:** Phase 2 — Ticket 1 (GAP-001)
**Section:** Section 6
**Agent:** Staff Engineer Lead
**Triggered by:** Staff Engineer 2 C1 concern claiming C_FLAT and round2 are undeclared

**Decision:**
C1 overridden. Both C_FLAT (= 3.6, module-level const) and round2 (private helper) are defined in lib/gap.ts. The concern was based on an incomplete code summary. All 42 unit tests pass including the 10-lap regression fixture.

**Rationale:**
Engineer 2 reviewed a prompt-level summary of the code, not the full file. The constant and helper are present at lines near the top of lib/gap.ts. npm test confirms all tests pass.

**Impact:**
- PRD: none
- TDD: none — implementation is correct as written

---

## [2026-03-08] Section 7 — Cycling EF Deferred to Section 12

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 7
**Agent:** TPM Agent
**Triggered by:** [PRODUCT_QUESTION] from TPM intake, Section 7

**Decision:**
Cycling EF (EF_cycle = normalized_power / avg_HR) is deferred entirely to Section 12. Section 7 scope is running EF only. The `efRecalc.ts` pipeline will be extended with cycling EF as a Phase 2 addition once Section 12 delivers normalized power data to the schema.

**Rationale:**
Normalized power (NP) is not available in the current schema — garmin_activities has no watts or power column. NP is a Section 12 deliverable. Stubbing with an awaiting_np flag provides marginal value and introduces dead code paths; computing an approximation using a non-power metric would diverge from the established EF definition and produce misleading values. Deferral is the cleanest choice: Section 7 ships a correct, complete running EF implementation and cycling EF is added in Section 12 with the proper data dependency in place.

**Impact:**
- PRD: Section 7.3 formula block updated to mark EF_cycle as deferred to Section 12; Section 7.4 requirements updated to clarify running EF only for initial implementation
- TDD: none — TDD not yet written

---

## [2026-03-08] Section 7 — Warmup Exclusion Uses Lap-Drop Approach

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 7
**Agent:** TPM Agent
**Triggered by:** [PRODUCT_QUESTION] from TPM intake, Section 7

**Decision:**
Warmup exclusion for EF computation uses the lap-drop approach: laps whose cumulative elapsed time from activity start is less than 10 minutes are excluded. EF is re-derived from post-warmup laps only. This requires fetching `garmin_activity_laps` during EF computation.

**Rationale:**
This is consistent with the Section 5 precedent (documented in the 2026-03-07 "Warmup Exclusion Mechanism via Laps" decision). Using the raw activity-level avg_GAP and avg_HR is simpler but warmup-contaminated, producing systematically lower EF values (warmup HR and pace are both unsteady). The lap-drop approach yields a cleaner signal and reuses the established implementation pattern. Architectural consistency across the analytics pipeline is a priority.

**Impact:**
- PRD: Section 7.3 filtering criteria updated to specify lap-drop approach (cumulative elapsed time < 10 min) rather than a simple time-based exclusion note
- TDD: none — TDD not yet written

---

## [2026-03-08] Section 7 — HR Zone Filtering Uses Shared resolveHRZones Utility

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 7
**Agent:** TPM Agent
**Triggered by:** [PRODUCT_QUESTION] from TPM intake, Section 7

**Decision:**
HR zone filtering for the Z1–Z2 easy aerobic qualifying runs uses the same four-priority resolution chain established in `decouplingRecalc.ts` (AsyncStorage → LTHR → lap hrz_* columns → default). This chain is extracted into a shared utility function `resolveHRZones(activityId)` in `lib/hrZones.ts` if not already present there. Section 7 imports from that shared utility rather than duplicating the resolution logic.

**Rationale:**
Hardcoding Z2 = <75% max HR is simpler but produces a fixed boundary that ignores personalized LTHR data already stored in the system. The four-priority chain is the correct resolution order for this codebase (personalized data takes priority over defaults) and is already tested as part of Section 5. Duplicating the logic in efRecalc.ts creates divergence risk: if the resolution chain is updated in one place it must be updated in both. Extracting to a shared lib is the standard refactor that eliminates this risk.

**Impact:**
- PRD: Section 7.3 filtering criteria updated to reference the shared HR zone resolution chain from lib/hrZones.ts
- TDD: none — TDD not yet written

---

## [2026-03-08] Section 7 — Regression Type: Linear Only for Initial Implementation

**Type:** Product Decision
**Phase:** Phase 1
**Section:** Section 7
**Agent:** TPM Agent
**Triggered by:** [PRODUCT_QUESTION] from TPM intake, Section 7

**Decision:**
Section 7 implements linear regression only for the EF trend. Polynomial regression is explicitly out of scope for the initial implementation. The code will include a TODO comment marking the extension point for polynomial regression in a future iteration.

**Rationale:**
Easy aerobic run data for a single athlete is inherently sparse — at most a few qualifying runs per week. Polynomial regression on sparse data is prone to overfitting and can produce curves that are locally accurate but directionally misleading (e.g., a degree-3 polynomial showing apparent EF improvement at the end of a period that is actually noise). Linear regression is defensible, interpretable, and statistically appropriate for the data volume expected at this stage. A slope on a linear fit over 30–90 days is a clear, actionable signal.

**Impact:**
- PRD: Section 7.3 adaptive baseline requirement updated to specify linear regression only; polynomial regression removed as an option in the initial spec; TODO extension point noted
- TDD: none — TDD not yet written