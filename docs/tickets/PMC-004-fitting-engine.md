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
