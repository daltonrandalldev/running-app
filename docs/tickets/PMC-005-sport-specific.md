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
