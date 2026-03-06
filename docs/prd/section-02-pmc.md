# 2. Performance Management Chart --- Adaptive Fitness/Fatigue/Form

## 2.1 Objective

Implement a PMC model (CTL/ATL/TSB) with athlete-adaptive decay
constants that more accurately reflect individual recovery signatures
and sport-specific responses, superseding the static 42/7-day defaults.

## 2.2 Background & Research

The Banister Impulse-Response model (Banister et al., 1975) models
performance as the difference between a positive fitness effect and a
negative fatigue effect from training. The standard PMC popularized by
TrainingPeaks uses fixed exponential decay constants: 42 days for CTL
(chronic training load / fitness) and 7 days for ATL (acute training
load / fatigue). TSB (training stress balance / form) = CTL - ATL.

Limitations of fixed constants documented in literature: Busso (2003,
Med Sci Sports Exerc) showed optimal decay constants vary by individual
and training phase. Clarke & Skiba (2013) demonstrated that
ultra-endurance athletes exhibit slower fatigue decay than the standard
7-day constant implies. A 100k race generates a fatigue signature that
may persist 14--21 days, not 7. Mujika et al. (1996, Med Sci Sports
Exerc) found that individual fitness/fatigue response parameters differ
by up to 40% across athletes even at similar training levels.

Key improvement: fit decay constants to individual historical data using
performance test results as ground truth.

## 2.3 Calculation Specification

**Standard PMC (baseline):**

> CTL_today = CTL_yesterday + (TSS_today - CTL_yesterday) / tc_fitness
>
> ATL_today = ATL_yesterday + (TSS_today - ATL_yesterday) / tc_fatigue
>
> TSB_today = CTL_today - ATL_today

Defaults: tc_fitness = 42, tc_fatigue = 7.

**Adaptive parameter fitting:**

Given a set of N performance observations (race results, time trials,
key workout benchmarks), solve for optimal tc_fitness and tc_fatigue
that minimize prediction error:

> minimize Σ(predicted_performance_i - actual_performance_i)²

where predicted_performance is modeled as: k1 \* CTL(tc_fitness) - k2 \*
ATL(tc_fatigue) + intercept

Optimization method: Nelder-Mead or L-BFGS-B with bounds tc_fitness ∈
\[20, 70\], tc_fatigue ∈ \[3, 21\]. Requires minimum 6--8 performance
data points spanning ≥6 months for stable fit.

**Sport-specific decay:**

Maintain separate decay constants per sport. Running TSS and cycling TSS
feed separate PMC models. A combined PMC uses weighted inputs (see
Section 14). This matters because cycling fatigue decays faster than
running fatigue due to lower eccentric muscle damage.

**Post-race extended fatigue modeling:**

For race events (flagged in activity metadata), apply a fatigue
multiplier that extends the effective fatigue impulse. Based on Skiba et
al. and observed ultra-recovery patterns:

> effective_TSS_race = TSS \* race_fatigue_multiplier
>
> race_fatigue_multiplier = 1.0 + (race_duration_hours /
> reference_duration) \* k_race

where reference_duration and k_race are fitted to individual recovery
data. Initial defaults: reference_duration = 4 hours, k_race = 0.3.

**\[REVIEW\]** Need to decide: should tc_fatigue for running
automatically extend after events \>4 hours, or should we use the
fatigue multiplier approach, or both? Both are defensible. The
multiplier is simpler to implement and tune.

## 2.4 Data Requirements

- TSS per activity (calculated in this system, not imported --- see
  Sections 8, 12 for sport-specific TSS)

- Performance benchmarks: race results (with distance and finish time),
  time trial efforts, key workout paces/powers with dates

- Activity metadata: race flag (boolean), sport type, duration

- Athlete profile: initial tc_fitness, tc_fatigue (use defaults until
  enough data for fitting)

## 2.5 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate daily CTL, ATL, TSB using       Output matches TrainingPeaks
  exponential weighted moving average with  PMC ±0.5 TSS when using
  configurable decay constants              default 42/7 constants on
                                            identical input data.

  Maintain sport-specific PMC (running,     Three separate CTL/ATL/TSB
  cycling) AND a combined PMC               series stored per day.
                                            Combined PMC uses cross-sport
                                            weighting from Section 14.

  Adaptive decay constant fitting using     When ≥8 benchmarks spanning
  performance benchmarks                    ≥6 months exist, system fits
                                            and stores personalized
                                            tc_fitness and tc_fatigue.
                                            Coefficients update monthly
                                            or on new benchmark entry.

  Race fatigue multiplier applied to        Races \>2 hours receive
  flagged race activities                   multiplier. Multiplier is
                                            configurable and learnable
                                            over time as recovery data
                                            accumulates.

  System uses default constants gracefully  New users get standard 42/7.
  when insufficient data for fitting        As data accumulates, system
                                            notifies when enough data
                                            exists for personalization.

  Store fitted parameters in                Each parameter refit logged
  athlete_parameters table with timestamp   with date, R², number of data
  and confidence interval                   points used, and 95% CI
                                            bounds.
  -----------------------------------------------------------------------


---


---

  **PMC-001: Core PMC Calculation           **Priority:  **Effort: M
  Refactor**                                  P0 ---        (2--3
                                            Critical**     days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Refactor existing CTL/ATL/TSB calculation to
                      be configurable, testable, and sport-aware.
                      This is the foundation all other tickets build
                      on.

  **Dependencies**    None --- this is the base layer

  **Key Output**      A pure calculation function + daily snapshot
                      storage that replaces the current hardcoded
                      PMC logic
  ------------------- ----------------------------------------------

**Background**

The Banister Impulse-Response model uses exponential weighted moving
averages. The recurrence formula is:

> CTL_today = CTL_yesterday + (TSS_today - CTL_yesterday) / tc_fitness
>
> ATL_today = ATL_yesterday + (TSS_today - ATL_yesterday) / tc_fatigue
>
> TSB_today = CTL_today - ATL_today

The standard equivalence: using tc_fitness = 42 gives the same result as
a 42-day EWMA. This must match TrainingPeaks output within ±0.5 TSS on
identical data --- this is the regression test target.

**Technical Requirements**

  -------- -------------------------------- ----------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   Extract PMC logic into a pure,   Function accepts an array of
           side-effect-free function:       {date, tss} objects and a
           calculatePMC(activities\[\],     params object with
           params)                          tc_fitness, tc_fatigue.
                                            Returns daily {date, ctl,
                                            atl, tsb} array.

  **R2**   Parameters must be externally    calculatePMC accepts
           injectable (not hardcoded)       tc_fitness and tc_fatigue as
                                            arguments. Defaults to 42/7
                                            when not provided.

  **R3**   Persist daily snapshot to        Schema: {athlete_id, date,
           daily_pmc_values table           sport, ctl, atl, tsb,
                                            tc_fitness_used,
                                            tc_fatigue_used,
                                            created_at}. Upsert on
                                            (athlete_id, date, sport).

  **R4**   Recalculation trigger: any       A recalculation job
           new/edited activity triggers     recalculates from the
           backfill from activity date      earliest affected date to
           onward                           today. Batch size
                                            configurable, max 365 days
                                            on first import.

  **R5**   Regression test: output matches  Provide a fixture of 30 days
           TrainingPeaks PMC ±0.5 TSS       of known TSS input +
                                            expected CTL/ATL/TSB output
                                            from TrainingPeaks. CI test
                                            must pass.
  -------- -------------------------------- ----------------------------

**Schema: daily_pmc_values**

> CREATE TABLE daily_pmc_values (
>
> id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
>
> athlete_id UUID NOT NULL REFERENCES athletes(id),
>
> date DATE NOT NULL,
>
> sport TEXT NOT NULL DEFAULT \'combined\',
>
> ctl FLOAT NOT NULL,
>
> atl FLOAT NOT NULL,
>
> tsb FLOAT NOT NULL,
>
> tc_fitness_used FLOAT NOT NULL DEFAULT 42,
>
> tc_fatigue_used FLOAT NOT NULL DEFAULT 7,
>
> created_at TIMESTAMPTZ DEFAULT now(),
>
> UNIQUE (athlete_id, date, sport)
>
> );

**Edge Cases to Handle**

- New athletes: initialize CTL = ATL = 0 on day 0

- Historical data import: backfill from earliest activity to today (cap
  at 4 years)

- Rest days (TSS = 0): still calculate decay --- CTL and ATL approach
  each other

- Floating point: round final CTL/ATL/TSB to 1 decimal place in storage

  ---------------------------------------- ------------- ------------

---

  **PMC-002: Race Detection & Fatigue       **Priority:  **Effort: M
  Multiplier**                                P0 ---        (2--3
                                            Critical**     days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Implement dual-method race detection and apply
                      a duration-scaled fatigue multiplier (k_race)
                      to race activities before they enter ATL.

  **Dependencies**    PMC-001 (activity TSS pipeline)

  **Key Output**      is_race flag on activities, k_race multiplier
                      applied in PMC calculation, effective_tss_race
                      stored per activity
  ------------------- ----------------------------------------------

**Background**

Standard TSS underestimates race fatigue because it does not account for
glycogen depletion, eccentric neuromuscular damage, and psychological
stress. Research (Skiba et al., 2012; Millet et al., 2011) shows
ultra-endurance events generate fatigue signatures persisting 14-21
days, not the 7-day default.

The approach: apply a multiplier to the TSS that feeds into ATL only
(not CTL), so the chart correctly shows the deep post-race fatigue dip
that athletes experience.

**Race Detection Logic**

Two detection methods are used. Both are stored; user-confirmed
overrides auto.

- Method 1 --- User flag: any activity can be manually flagged as a race
  via UI toggle

- Method 2 --- Auto-detection (OR logic): avg HR \> 88% HRmax for \>40%
  of duration, OR pace within 5% of personal best for that distance, OR
  Garmin activity type tagged as \'race\'

**k_race Default Scale**

  -------------- --------------- --------------
  **Race         **k_race        **Effective
  Duration**     Multiplier**    ATL TSS**

  \< 4 hours     **1.0× (no      TSS × 1.0
                 adjustment)**   

  4--8 hours     **1.5×**        TSS × 1.5

  8--12 hours    **2.0×**        TSS × 2.0

  \> 12 hours    **2.5×**        TSS × 2.5
  -------------- --------------- --------------

**Technical Requirements**

  -------- -------------------------------- -------------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   Add race detection fields to     Schema additions: is_race
           activities table                 BOOLEAN DEFAULT false,
                                            race_detection_source TEXT
                                            CHECK IN
                                            (\'user\',\'auto\',\'none\'),
                                            k_race_applied FLOAT. Migrate
                                            existing records with
                                            race_detection_source =
                                            \'none\'.

  **R2**   Auto-detection runs on activity  On activity upsert, evaluate
           save/import                      auto-detection rules. Set
                                            is_race = true,
                                            race_detection_source =
                                            \'auto\' if criteria met. Never
                                            overwrite user-confirmed flags.

  **R3**   Implement k_race multiplier in   When activity has is_race =
           PMC calculation                  true, compute effective_tss =
                                            TSS × k_race_applied before
                                            feeding to ATL. CTL always uses
                                            raw TSS. k_race_applied
                                            defaults per duration table
                                            above.

  **R4**   Store effective_tss_race on      New column: effective_tss_race
           activity record                  FLOAT NULL. Populated only for
                                            race activities. Null for
                                            non-races.

  **R5**   User can override race flag and  UI exposes: toggle is_race
           k_race multiplier per activity   (clears auto-flag), and a
                                            k_race multiplier input field
                                            (numeric, 1.0--3.0, step 0.1).
                                            Saving user value sets
                                            race_detection_source =
                                            \'user\'.
  -------- -------------------------------- -------------------------------

**Implementation Note**

The multiplier applies to ATL only. This is a deliberate architectural
decision: CTL measures chronic fitness adaptation (raw TSS is
appropriate), while ATL measures acute load-induced fatigue (which is
underrepresented by TSS in races). This separation also produces more
predictable downstream behavior than extending tc_fatigue.

  ---------------------------------------- ------------- ------------

---

  **PMC-003: Benchmark Effort System**      **Priority:  **Effort: M
                                           P1 --- High**    (2--3
                                                           days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Build the benchmark effort earmarking system
                      that provides ground-truth performance
                      observations for adaptive parameter fitting
                      (PMC-004).

  **Dependencies**    PMC-001

  **Key Output**      benchmark_efforts table, earmarking UI,
                      auto-detection, minimum data check before
                      fitting
  ------------------- ----------------------------------------------

**Background**

Adaptive fitting requires 6-8 near-maximal performance observations as
ground truth. These are efforts where the athlete was close to their
physiological limit at a specific date --- races, time trials, or
all-out intervals. The model uses performance at these points to
reverse-engineer the decay constants that best predict performance from
training load.

**Benchmark Effort Criteria**

- Effort level \>= 95% of maximal capacity

- Duration: ideally spans 3 minutes to 3 hours (to give diverse
  performance-duration coverage)

- Examples: 5K/10K race, half marathon, marathon, 3-5 min all-out
  interval, 20-min FTP test

- Auto-detection: avg HR \> 90% HRmax for full duration AND pace within
  5% of personal best for that distance

**Schema: benchmark_efforts**

> CREATE TABLE benchmark_efforts (
>
> id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
>
> athlete_id UUID NOT NULL REFERENCES athletes(id),
>
> activity_id UUID REFERENCES activities(id),
>
> date DATE NOT NULL,
>
> sport TEXT NOT NULL,
>
> duration_seconds INT NOT NULL,
>
> performance_score FLOAT NOT NULL, \-- normalized performance metric
>
> effort_level TEXT CHECK IN (\'user_confirmed\',\'auto_detected\'),
>
> ctl_on_date FLOAT, \-- CTL at time of benchmark (populated on save)
>
> atl_on_date FLOAT, \-- ATL at time of benchmark
>
> notes TEXT,
>
> created_at TIMESTAMPTZ DEFAULT now()
>
> );

**Performance Score Normalization**

Performance score must be a single comparable float across different
distances and durations. Recommended approach:

- Running: use velocity in m/s normalized by the Riegel curve --- score
  = actual_pace / predicted_pace_from_riegel(duration). Score of 1.0 =
  exactly at predicted performance given fitness. \>1.0 =
  overperformance.

- Cycling: use normalized power in watts/kg as the performance score.

- This normalization is critical --- without it, a 5K result and a
  marathon result are not comparable, and the optimizer will be anchored
  to whichever distance produces larger absolute numbers.

**Technical Requirements**

  -------- -------------------------------- ----------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   benchmark_efforts table created  Migration runs cleanly.
           with above schema                Indexes on (athlete_id,
                                            date), (athlete_id, sport).

  **R2**   Manual earmarking: any activity  Activity detail view shows a
           can be flagged as benchmark      \'Mark as benchmark effort\'
                                            toggle. On enable, prompt
                                            for performance_score if not
                                            auto-calculable. Store
                                            effort_level =
                                            \'user_confirmed\'.

  **R3**   Auto-detection: flag qualifying  Apply criteria: avg HR \>
           activities on import/save        90% HRmax AND pace within 5%
                                            of athlete\'s PB for that
                                            distance. Set effort_level =
                                            \'auto_detected\'. Do not
                                            auto-flag if user has
                                            already confirmed.

  **R4**   On benchmark save, populate      Look up existing PMC
           ctl_on_date and atl_on_date from snapshot for that date. If
           daily_pmc_values                 not yet calculated, trigger
                                            PMC recalculation first.

  **R5**   Minimum data gate: fitting only  Return {eligible: false,
           unlocks with \>= 6 benchmarks    count: N, months_span: M,
           spanning \>= 6 months            needed: 6} when below
                                            threshold. This is the gate
                                            checked by PMC-004 before
                                            fitting.
  -------- -------------------------------- ----------------------------

  ---------------------------------------- ------------- ------------

---

  **PMC-004: Adaptive Parameter Fitting     **Priority:  **Effort: L
  Engine**                                 P1 --- High**    (4--5
                                                           days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Implement the numerical optimization engine
                      that fits personalized tc_fitness and
                      tc_fatigue from an athlete\'s benchmark effort
                      history.

  **Dependencies**    PMC-002, PMC-003 --- needs race-aware PMC and
                      benchmark data

  **Key Output**      athlete_parameters table, monthly refitting
                      job, confidence intervals, parameter clamping
  ------------------- ----------------------------------------------

**Background & Research Basis**

Busso (2003) demonstrated that optimal decay constants vary
significantly between individuals and training phases. Mujika et al.
(1996) found individual fitness/fatigue parameters differ by up to 40%
across athletes at similar training levels. Clarke & Skiba (2013) showed
ultra-endurance athletes exhibit slower fatigue decay than the 7-day
default implies.

The fitting approach: treat CTL and ATL as predictors of performance,
and solve for the decay constants that maximize predictive accuracy
against benchmark results.

**Mathematical Formulation**

For each benchmark observation i, predicted performance is modeled as:

> predicted_perf_i = k1 \* CTL(tc_fitness) - k2 \* ATL(tc_fatigue) +
> intercept

Where CTL and ATL are computed with candidate tc_fitness and tc_fatigue.
The optimization minimizes:

> Loss = Σ (predicted_perf_i - actual_perf_i)² over all N benchmarks

Free parameters: tc_fitness, tc_fatigue, k1, k2, intercept

**Optimization Specification**

- Algorithm: Nelder-Mead (simplex) or L-BFGS-B. Recommend L-BFGS-B for
  bounded optimization.

- Library: scipy.optimize (Python) or a JS equivalent (e.g.,
  fmin-l-bfgs-b npm package)

- Bounds: tc_fitness in \[20, 70\], tc_fatigue in \[3, 21\]

- k1, k2: unconstrained positive floats (add positivity constraint)

- Initialization: start from current defaults (42, 7) to avoid local
  minima far from physiological range

- Convergence tolerance: 1e-6 on objective value

**Parameter Clamping --- Physiological Bounds**

All fitted values must be clamped to prevent physiologically nonsensical
results. If optimization converges outside bounds, clamp and log a
warning.

  -------------------- ----------- ----------- -----------
  **Parameter**        **Min**     **Max**     **Notes**

  tc_fitness           20 days     60 days     Fitness
                                               decay
                                               window

  tc_fatigue           3 days      14 days     Fatigue
                                               decay
                                               window

  tau_recovery_run     1 day       10 days     Run
                                               recovery
                                               constant

  tau_recovery_cycle   1 day       7 days      Cycling
                                               recovery
                                               constant

  k_race (ultra)       1.0         3.0         Race
                                               fatigue
                                               amplifier
  -------------------- ----------- ----------- -----------

**Schema: athlete_parameters**

> CREATE TABLE athlete_parameters (
>
> id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
>
> athlete_id UUID NOT NULL REFERENCES athletes(id),
>
> sport TEXT NOT NULL DEFAULT \'combined\',
>
> tc_fitness FLOAT NOT NULL DEFAULT 42,
>
> tc_fatigue FLOAT NOT NULL DEFAULT 7,
>
> k1 FLOAT, \-- performance \~ k1 \* CTL
>
> k2 FLOAT, \-- performance \~ -k2 \* ATL
>
> intercept FLOAT,
>
> is_personalized BOOLEAN DEFAULT false,
>
> r_squared FLOAT, \-- goodness of fit
>
> n_benchmarks INT, \-- data points used
>
> ci_tc_fitness_low FLOAT, \-- 95% CI lower bound
>
> ci_tc_fitness_high FLOAT,
>
> ci_tc_fatigue_low FLOAT,
>
> ci_tc_fatigue_high FLOAT,
>
> fitted_at TIMESTAMPTZ,
>
> created_at TIMESTAMPTZ DEFAULT now(),
>
> UNIQUE (athlete_id, sport)
>
> );

**Technical Requirements**

  -------- -------------------------------- ----------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   Fitting function:                Pure function. Reads
           fitDecayConstants(athleteId,     benchmark_efforts, computes
           sport) -\> {tc_fitness,          PMC series under candidate
           tc_fatigue, r2, ci}              params, returns fitted
                                            values with R² and 95% CI
                                            via bootstrap (N=1000
                                            resamples).

  **R2**   Minimum data gate respected      If benchmark_efforts count
                                            \< 6 OR span \< 6 months,
                                            return {eligible: false}
                                            without running optimizer.

  **R3**   Monthly refitting cron job       Job runs on the 1st of each
                                            month. Refits all athletes
                                            with is_personalized = true
                                            OR with newly sufficient
                                            benchmark data. Stores
                                            results in
                                            athlete_parameters.

  **R4**   Immediate refit on new benchmark When a benchmark is
           entry                            added/confirmed, trigger
                                            async refit for that
                                            athlete. Do not block the UI
                                            --- show \'Updating your
                                            model\...\' state.

  **R5**   Parameter clamping enforced      After optimization, clamp
                                            all values to physiological
                                            bounds table. Log clamp
                                            events to
                                            parameter_change_log with
                                            warning flag.

  **R6**   Confidence intervals via         Bootstrap 1000 resamples of
           bootstrap                        benchmark set. Store 2.5th
                                            and 97.5th percentile as 95%
                                            CI bounds. Wide CI = low
                                            confidence; surface this in
                                            UI (PMC-007).

  **R7**   After refit, trigger PMC         New params applied to full
           recalculation from earliest      historical series.
           benchmark date                   daily_pmc_values updated
                                            with new CTL/ATL/TSB and new
                                            tc used values.
  -------- -------------------------------- ----------------------------

  ---------------------------------------- ------------- ------------

---

  **PMC-005: Sport-Specific PMC             **Priority:  **Effort: S
  Separation**                             P1 --- High**    (1--2
                                                           days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Maintain separate CTL/ATL/TSB series for
                      running and cycling, plus a combined weighted
                      model.

  **Dependencies**    PMC-001 (sport field on daily_pmc_values
                      already provisioned)

  **Key Output**      Three daily PMC series per athlete: \'run\',
                      \'cycle\', \'combined\'
  ------------------- ----------------------------------------------

**Background**

Running fatigue decays more slowly than cycling fatigue due to higher
eccentric muscle damage. A combined model using default constants blurs
this distinction. Sport-specific models allow tc_fatigue for running to
be fitted separately from cycling.

The combined model uses sport-weighted TSS inputs. Cross-sport weighting
is defined in PRD Section 14. For this ticket, use placeholder weights:
w_run = 1.0, w_cycle = 0.5 until Section 14 is implemented.

**Technical Requirements**

  -------- -------------------------------- -------------------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   On each activity save, route TSS Activities with sport = \'running\'
           to the correct sport series      feed \'run\' PMC. sport = \'cycling\'
                                            feeds \'cycle\' PMC. All sports feed
                                            \'combined\' PMC.

  **R2**   Combined PMC uses weighted TSS   combined_TSS = (run_TSS \* w_run) +
                                            (cycle_TSS \* w_cycle). Weights
                                            configurable in athlete_parameters.
                                            Default w_run = 1.0, w_cycle = 0.5.

  **R3**   Sport-specific decay constants   athlete_parameters has one row per
                                            (athlete_id, sport). Run and cycle
                                            get independently fitted tc values.
                                            Combined inherits weighted blend of
                                            both.

  **R4**   PMC calculation runs three times Separate calls:
           per recalculation trigger        calculatePMC(runActivities,
                                            runParams),
                                            calculatePMC(cycleActivities,
                                            cycleParams),
                                            calculatePMC(allActivitiesWeighted,
                                            combinedParams). Results stored with
                                            sport field.

  **R5**   New athlete default: all three   No sport separation until sufficient
           series start from same 42/7      data exists per sport.
           defaults                         
  -------- -------------------------------- -------------------------------------

  ---------------------------------------- ------------- ------------

---

  **PMC-006: Parameter Audit Log &          **Priority:  **Effort: S
  Personalization Notifications**             P2 ---        (1--2
                                             Medium**      days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Record every parameter change with context and
                      surface athlete-facing plain-English
                      notifications when personalization milestones
                      are reached.

  **Dependencies**    PMC-004 (needs fitted parameters to log)

  **Key Output**      parameter_change_log table, notification
                      triggers, human-readable interpretations
  ------------------- ----------------------------------------------

**Schema: parameter_change_log**

> CREATE TABLE parameter_change_log (
>
> id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
>
> athlete_id UUID NOT NULL REFERENCES athletes(id),
>
> sport TEXT NOT NULL,
>
> parameter_name TEXT NOT NULL, \-- e.g. \'tc_fitness\', \'tc_fatigue\',
> \'k_race\'
>
> old_value FLOAT,
>
> new_value FLOAT NOT NULL,
>
> change_source TEXT, \-- \'auto_fit\', \'user_override\', \'clamped\'
>
> r_squared FLOAT,
>
> n_data_points INT,
>
> ci_low FLOAT,
>
> ci_high FLOAT,
>
> plain_english TEXT NOT NULL, \-- human interpretation (see below)
>
> was_clamped BOOLEAN DEFAULT false,
>
> created_at TIMESTAMPTZ DEFAULT now()
>
> );

**Plain-English Interpretation Templates**

Each parameter update must generate a human-readable string stored in
plain_english. Examples:

- tc_fitness changed to 45: \'Your aerobic fitness builds over
  approximately 45 days (previously 42 days). This means your body
  adapts slightly more slowly to training stimulus than average.\'

- tc_fatigue changed to 5: \'You recover from hard training in about 5
  days (previously 7 days). This suggests you have faster-than-average
  acute fatigue recovery.\'

- k_race changed to 2.2 for events \>8hr: \'Your body accumulates
  significantly more fatigue from long races than TSS alone captures.
  Your model now accounts for deeper post-race recovery needs.\'

- Clamped value: \'Your fitted fatigue decay (2.1 days) was below the
  physiological minimum. Using 3.0 days as the lower bound.\'

**Technical Requirements**

  -------- -------------------------------- ---------------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   Log every parameter refit to     Called inside fitDecayConstants()
           parameter_change_log             after any value changes. One row
                                            per changed parameter per refit.

  **R2**   Notification: \'Personalization  When athlete crosses 6 benchmarks
           available\' when data threshold  / 6 months, create a notification
           first reached                    record. Show once. Include: \'You
                                            now have enough data to
                                            personalize your training model.
                                            Tap to enable.\'

  **R3**   Notification: \'Model updated\'  Show summary: which parameters
           after each successful refit      changed and plain-English
                                            interpretation. Include R² and
                                            confidence level (High/Medium/Low
                                            based on CI width).

  **R4**   Notification: \'More data        Alert: \'Your model was updated
           needed\' if R² \< 0.6 after      but has low confidence (R² =
           fitting                          0.45). Add more benchmark efforts
                                            for a better fit.\' Include a
                                            prompt to add benchmarks.

  **R5**   Audit log queryable per athlete  API endpoint: GET
                                            /athletes/:id/parameter-history
                                            returns full log sorted by
                                            created_at DESC.
  -------- -------------------------------- ---------------------------------

  ---------------------------------------- ------------- ------------

---

  **PMC-007: Chart & UI Updates**           **Priority:  **Effort: M
                                              P2 ---        (2--3
                                             Medium**      days)**

  ---------------------------------------- ------------- ------------

  ------------------- ----------------------------------------------
  **Goal**            Update the PMC chart and surrounding UI to
                      expose sport-specific views, adaptive model
                      status, benchmark markers, and model
                      confidence.

  **Dependencies**    PMC-001 through PMC-006 must be complete

  **Key Output**      Updated PMC chart with sport toggle, benchmark
                      markers, model confidence badge, race flags
  ------------------- ----------------------------------------------

**Chart Updates**

- Sport selector: toggle between \'Running\', \'Cycling\', \'Combined\'
  PMC views

- Benchmark effort markers: vertical dotted line on benchmark dates,
  tooltip showing performance score and effort type

- Race markers: distinct marker (e.g. star icon) on race activity dates
  with k_race multiplier shown in tooltip

- Confidence band: if personalized, show shaded confidence interval
  around CTL line derived from CI bounds on tc_fitness

- Model status badge: \'Standard (42/7)\' vs \'Personalized
  (tc_fitness=X, tc_fatigue=Y, R²=Z)\'

**Settings Panel**

- Section: \'Training Model\' --- shows current parameters,
  personalization status, last fitted date

- Button: \'Refit model now\' --- triggers immediate refit, shows
  loading state

- Manual override: advanced users can directly set tc_fitness and
  tc_fatigue (marks as \'user_override\' in audit log)

- k_race defaults: table showing current multipliers per duration band,
  with per-band override inputs

**Technical Requirements**

  -------- -------------------------------- ----------------------------
  **\#**   **Requirement**                  **Acceptance Criteria**

  **R1**   Sport-specific PMC toggle        Three-way selector (Run /
                                            Cycle / Combined) re-renders
                                            chart from daily_pmc_values
                                            filtered by sport. Default:
                                            Combined.

  **R2**   Benchmark and race markers on    Overlay markers at correct
           chart                            x-axis dates. Click opens
                                            activity detail modal.
                                            Markers styled distinctly
                                            from normal activity dots.

  **R3**   Model confidence display         Show R² value and CI width.
                                            Map to confidence label: R²
                                            \> 0.75 = High, 0.5--0.75 =
                                            Medium, \< 0.5 = Low.
                                            Color-code badge
                                            accordingly.

  **R4**   Personalization onboarding flow  When notification fires
                                            (PMC-006 R2), show modal:
                                            \'Your data is ready for
                                            personalization.\' Primary
                                            CTA: \'Enable personalized
                                            model.\' Shows before/after
                                            comparison once fit
                                            completes.

  **R5**   Empty state for new athletes     Show: \'Using standard model
                                            (42/7 defaults). Complete 6
                                            benchmark efforts over 6
                                            months to unlock a model
                                            personalized to your
                                            physiology.\'
  -------- -------------------------------- ----------------------------

**Appendix A: Testing Strategy**

Each ticket must include unit and integration tests before marking
complete.

**PMC Calculation Tests**

- Fixture test: 30-day known TSS array → assert CTL/ATL/TSB within ±0.5
  of TrainingPeaks reference

- Rest day test: 7 days of zero TSS → CTL decays toward 0 at correct
  rate

- Race multiplier test: 10hr race activity → assert ATL reflects 2.0×
  TSS, CTL unaffected

- Parameter injection test: tc_fitness=30 produces faster CTL build than
  tc_fitness=60

**Fitting Engine Tests**

- Synthetic data test: generate activities with known tc=45/5, create
  synthetic benchmarks, assert optimizer recovers tc within ±3 days

- Insufficient data test: \< 6 benchmarks → fitting returns {eligible:
  false}, no optimizer called

- Clamping test: if optimizer returns tc_fatigue=1.5, assert stored
  value = 3.0 and was_clamped = true

- Bootstrap CI test: assert CI bounds are ordered (low \< fitted \<
  high) and width decreases with more data points

**Race Detection Tests**

- Auto-detect positive: activity with avg HR = 91% HRmax → is_race =
  true, race_detection_source = \'auto\'

- Auto-detect negative: avg HR = 75% HRmax → is_race = false

- User override: auto-detected race, user unflagged →
  race_detection_source = \'user\', is_race = false

**Appendix B: Future Work (Out of Scope)**

- Section 14 integration: cross-sport weighting refinement (currently
  using placeholder weights)

- Heat stress adjustment (k_heat per PRD Section X)

- HRV-based recovery modifier

- Adaptive k_race learning from actual post-race HRV/HR data

- Real-time PMC updates (current design: recalculates on activity save,
  not streaming)

**Appendix C: Key References**

- Banister, E.W. et al. (1975). A systems model of training for athletic
  performance. Australian Journal of Sports Medicine.

- Busso, T. (2003). Variable dose-response relationship between exercise
  training and performance. Med Sci Sports Exerc.

- Clarke, D.C. & Skiba, P.F. (2013). Rationale and resources for
  teaching the mathematical modeling of athletic training and
  performance. Adv Physiol Educ.

- Mujika, I. et al. (1996). Modeled responses to training and taper in
  competitive swimmers. Med Sci Sports Exerc.

- Skiba, P.F. et al. (2012). Modeling the expenditure and reconstitution
  of work capacity above critical power. Med Sci Sports Exerc.

- Millet, G.P. et al. (2011). Alterations of neuromuscular function
  after an ultramarathon. Sports Med.
