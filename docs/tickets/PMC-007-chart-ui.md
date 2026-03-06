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
