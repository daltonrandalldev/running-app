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
