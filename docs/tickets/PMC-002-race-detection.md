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
