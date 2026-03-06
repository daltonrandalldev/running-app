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
