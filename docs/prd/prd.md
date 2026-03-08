**Product Requirements Document**

Endurance Performance Analytics Platform

Calculations, Data, & Fitness/Health Engine

v1.0 --- February 2026

*Scope: Backend calculations, data storage, adaptive algorithms. UI/UX
deferred to Phase 2.*

# Table of Contents

1\. Data Ingestion & Storage Architecture

2\. Performance Management (PMC) --- Adaptive Fitness/Fatigue/Form

3\. Acute:Chronic Workload Ratio (ACWR) & Injury Risk

4\. Training Monotony & Strain

5\. Running: Aerobic Decoupling & Cardiac Drift

6\. Running: Grade Adjusted Pace (GAP)

7\. Running: Efficiency Factor (EF)

8\. Running: Power Estimation & rTSS

9\. Running: Dynamics (Cadence, GCT, Vertical Oscillation, Stride
Length)

10\. Cycling: Mean Maximal Power Curve

11\. Cycling: Critical Power & W' Balance

12\. Cycling: Intensity Factor, Variability Index, Normalized Power

13\. Cycling: FTP Auto-Detection & Tracking

14\. Cross-Sport Combined Load Model

15\. Cross-Training Transfer Detection

16\. Polarized Training Distribution

17\. HRV Analysis & Readiness

18\. Resting Heart Rate Trending

19\. Sleep Integration & Correlations

20\. Recovery Timeline Modeling

21\. Environmental Adjustment (Heat, Humidity, Altitude)

22\. Race Performance Prediction

23\. Pacing Strategy Simulation

24\. Taper Modeling

25\. Session Quality Scoring

26\. Plateau & Breakthrough Detection

27\. Injury Risk Composite Score

28\. Training Phase Detection

29\. Automated Insight Generation

# 1. Data Ingestion & Storage Architecture

## 1.1 Objective

Establish a manufacturer-agnostic data pipeline that ingests,
normalizes, and stores activity data from Garmin, Zwift, and future
sources into a unified schema. All downstream calculations depend on
this layer.

## 1.2 Background

Current state: GarminDB API integration is working. Zwift data is
available via .fit file export. The system must handle heterogeneous
data formats (FIT, TCX, GPX, CSV) with varying field availability across
devices and platforms.

## 1.3 Data Sources & Fields

**Required per-activity fields:**

- Timestamp (start, per-record), duration, distance, sport type

- Heart rate (avg, max, per-second stream if available)

- Pace or speed (avg, per-record stream)

- Elevation (gain, loss, per-record stream)

- GPS coordinates (lat/lng stream)

- Cadence (running: spm; cycling: rpm)

- Cycling power (watts, per-second stream) --- Zwift, power meter

- Temperature (from device or external weather API backfill)

**Running dynamics (Garmin-specific, optional but high-value):**

- Ground contact time (ms)

- Vertical oscillation (cm)

- Ground contact time balance (L/R %)

- Running power (if Garmin Running Power IQ or Stryd present)

**Daily health metrics:**

- Resting heart rate

- HRV (RMSSD or Garmin's HRV Status)

- Sleep (total, deep, light, REM, awake minutes)

- Body weight

- SpO2 (if available)

- Stress score (Garmin Body Battery / stress level)

**\[REVIEW\]** Confirm exact HRV metric exported by GarminDB (RMSSD vs.
proprietary score vs. HRV status). Different Garmin devices export
different HRV representations. Need to verify which format is available
from your specific watch model.

## 1.4 Storage Schema Design

Use a relational schema (SQLite for local, Postgres for deployed). Key
tables:

- activities: one row per activity. sport_type, start_time, duration,
  distance, avg_hr, max_hr, avg_pace, elevation_gain, elevation_loss,
  avg_cadence, avg_power, normalized_power, TSS, source_platform

- activity_streams: time-series data. activity_id, timestamp, hr, pace,
  power, cadence, elevation, lat, lng, gct, vertical_osc, temperature

- daily_health: date, resting_hr, hrv_value, hrv_metric_type,
  sleep_total, sleep_deep, sleep_light, sleep_rem, sleep_awake, weight,
  spo2, stress_score

- athlete_profile: weight, FTP_cycling, threshold_pace_running, max_hr,
  resting_hr_baseline, hr_zones (array), pace_zones (array), power_zones
  (array)

- athlete_parameters: adaptive model parameters (decay constants,
  recovery rates, personal coefficients) --- updated by learning
  algorithms

- calculated_metrics: date, CTL, ATL, TSB, ACWR_run, ACWR_cycle,
  ACWR_combined, monotony, strain, injury_risk_score, training_phase

## 1.5 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Ingest Garmin .fit files via GarminDB API All fields listed in 1.3 that
  with all available fields including       exist in device data are
  running dynamics and daily health         parsed and stored. Missing
                                            fields stored as NULL, not
                                            zero.

  Ingest Zwift .fit files via manual upload Power, HR, cadence, duration,
  or auto-sync                              distance extracted. Virtual
                                            elevation handled correctly
                                            (flag as virtual).

  Normalize all timestamps to UTC with      No timezone-related ordering
  local timezone stored separately          bugs. Activities queryable by
                                            both UTC and local time.

  Stream data resampled to 1-second         Interpolation used for gaps
  intervals for consistency                 \<5s. Gaps \>5s flagged as
                                            paused/stopped segments.

  Deduplication: same activity from         Matching by start_time ±30s +
  multiple sources identified and merged    sport_type. User can choose
                                            preferred source
                                            per-activity.

  Schema supports future data sources       source_platform field is
  (Wahoo, Strava API, manual entry) without extensible. New sources
  migration                                 require only a new ingestion
                                            adapter, not schema changes.

  Weather data backfill for outdoor         Temperature, humidity, wind
  activities using GPS + timestamp          speed, precipitation stored
                                            per-activity. Source:
                                            Open-Meteo historical API or
                                            similar.
  -----------------------------------------------------------------------

**\[UNKNOWN\]** Zwift data export method --- do you currently export
.fit files manually, use a Zwift API integration, or pull from a
third-party aggregator (e.g., Strava)? This affects the ingestion
adapter design.

**\[UNKNOWN\]** Which Garmin watch model? Needed to confirm running
dynamics and HRV field availability.

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

# 3. Acute:Chronic Workload Ratio (ACWR) & Injury Risk

## 3.1 Objective

Calculate rolling ACWR to monitor training load spikes relative to
preparedness, with individualized risk thresholds learned from personal
injury/illness history.

## 3.2 Background & Research

Gabbett (2016, Br J Sports Med) established the ACWR framework: the
ratio of acute (7-day) to chronic (28-day) workload predicts injury
risk. The "sweet spot" is 0.8--1.3; ratios \>1.5 correlate with 2--4x
injury risk. Hulin et al. (2014) validated across multiple sports.
Blanch & Gabbett (2016) recommended using exponentially weighted moving
averages (EWMA) rather than simple rolling averages, as EWMA ACWR better
accounts for the decaying nature of fitness and fatigue effects.

For dual-sport athletes, ACWR should be computed per sport AND for
combined musculoskeletal load. Running's eccentric loading produces
higher orthopedic injury risk per TSS unit than cycling.

Malone et al. (2017, Br J Sports Med) found that combining ACWR with
other risk factors (sleep, prior injury history, training monotony)
improves predictive power beyond ACWR alone.

## 3.3 Calculation Specification

**EWMA method (preferred over rolling average):**

> lambda_a = 2 / (7 + 1) = 0.25 \[acute\]
>
> lambda_c = 2 / (28 + 1) = 0.069 \[chronic\]
>
> EWMA_acute_today = TSS_today \* lambda_a + EWMA_acute_yesterday \*
> (1 - lambda_a)
>
> EWMA_chronic_today = TSS_today \* lambda_c + EWMA_chronic_yesterday \*
> (1 - lambda_c)
>
> ACWR = EWMA_acute / EWMA_chronic

**Sport-specific ACWR:**

- ACWR_run: uses running TSS only

- ACWR_cycle: uses cycling TSS only

- ACWR_combined: uses combined orthopedic-weighted load (see Section 14)

**Adaptive risk thresholds:**

Default zones: \<0.8 (undertrained), 0.8--1.3 (optimal), 1.3--1.5
(caution), \>1.5 (high risk). Over time, if athlete has injury or
illness events logged, the system can shift these thresholds using
logistic regression on personal data. An athlete with robust connective
tissue (e.g., years of consistent high mileage) may tolerate higher ACWR
without injury.

**\[REVIEW\]** Do you currently log injury/illness events anywhere? If
not, we need a manual entry mechanism for this. The adaptive threshold
fitting requires labeled positive cases (injury occurred) and negative
cases (no injury).

## 3.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate daily ACWR using EWMA for       Three ACWR values computed
  running, cycling, and combined load       daily. EWMA parameters match
                                            Blanch & Gabbett formulation.

  Apply default risk zone classification    Each day classified into
  with configurable thresholds              undertrained / optimal /
                                            caution / high-risk.
                                            Thresholds stored in
                                            athlete_parameters and
                                            editable.

  When ≥12 months of data + ≥2 logged       Logistic regression or
  injury/illness events exist, fit          similar model trained. AUC
  personalized risk thresholds              reported. Thresholds update
                                            only if model AUC \> 0.6.

  Week-over-week load change percentage     Calculated as
  also tracked                              (this_week_load -
                                            last_week_load) /
                                            last_week_load. Flagged if
                                            \>30%.
  -----------------------------------------------------------------------

# 4. Training Monotony & Strain

## 4.1 Objective

Detect training patterns with insufficient variability at high volume
--- a predictor of overtraining, burnout, and illness.

## 4.2 Background & Research

Foster (1998, Med Sci Sports Exerc) defined monotony as mean daily load
/ standard deviation of daily load over a 7-day window. Strain = weekly
load × monotony. High monotony (\>2.0) combined with high strain
correlates with upper respiratory infection incidence and overtraining
symptoms. The mechanism is immunosuppression from repetitive high-stress
stimulus without recovery variation.

This metric would have been relevant to your 100k blowup: if training
leading into the race had high monotony (similar daily loads without
adequate easy/off days), accumulated strain may have exceeded your
capacity for the final 20k.

## 4.3 Calculation Specification

> daily_loads = \[TSS_day1, TSS_day2, \..., TSS_day7\] (7-day window)
>
> monotony = mean(daily_loads) / stdev(daily_loads)
>
> strain = sum(daily_loads) \* monotony

Rest days (TSS=0) count as 0 in the array and naturally reduce monotony.
This is by design: rest days are protective.

**Adaptive thresholds:**

Default alert: monotony \> 2.0 AND strain \> athlete's rolling 90-day
strain average \* 1.5. Over time, correlate high-strain weeks with
subsequent performance drops (EF decline, HR drift increase) to learn
individual tolerance.

## 4.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate rolling 7-day monotony and      Values computed for combined
  strain daily                              load and per-sport. Rest days
                                            counted as zero.

  Alert when monotony \> 2.0 and strain     Alert generated with severity
  exceeds adaptive threshold                level. Threshold adapts based
                                            on correlation with
                                            subsequent EF decline
                                            (requires ≥3 months data).

  Store historical monotony/strain for      Daily values in
  trend analysis                            calculated_metrics table.
                                            Queryable for any date range.
  -----------------------------------------------------------------------

# 5. Running: Aerobic Decoupling & Cardiac Drift

## 5.1 Objective

Quantify the relationship between pace and heart rate across a session
to assess aerobic fitness and predict endurance durability. This is the
single most important metric for ultra performance.

## 5.2 Background & Research

Aerobic decoupling measures how much heart rate drifts upward relative
to output (pace) during steady-state exercise. Friel (2009) popularized
the metric: compare the efficiency factor (pace/HR) of the first half to
the second half. Decoupling \>5% on an easy long run suggests
insufficient aerobic base for the target effort. Seiler & Kjerland
(2006, Scand J Med Sci Sports) showed that trained endurance athletes
exhibit \<3--5% decoupling on sub-threshold steady-state efforts lasting
60--90 minutes.

For ultra runners, decoupling rate on 2--4 hour runs is a direct proxy
for race-day fade. Your 100k blowup can be retrospectively analyzed by
looking at decoupling in the final third.

## 5.3 Calculation Specification

> EF_first_half = avg_pace_first_half / avg_hr_first_half
>
> EF_second_half = avg_pace_second_half / avg_hr_second_half
>
> decoupling_pct = ((EF_first_half - EF_second_half) / EF_first_half) \*
> 100

Positive values = HR drifted up relative to pace (normal). Negative =
pace improved (unusual, may indicate downhill bias or pacing strategy).

**Preprocessing:**

- Exclude first 10 minutes (warmup stabilization)

- Exclude stopped/paused segments

- Use Grade Adjusted Pace (Section 6) if elevation data is available, to
  remove terrain confounds

- For races: calculate decoupling in thirds or quartiles, not just
  halves

**Adaptive baseline:**

Track individual decoupling rate at various effort levels over time.
Build a personal decoupling curve: at easy effort, decoupling should be
\<3%; at threshold, higher decoupling is expected. Improvement means the
curve shifts downward. The system should learn your expected decoupling
at each intensity and flag sessions that deviate significantly.

## 5.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate aerobic decoupling for every    Decoupling percentage
  run \>30 minutes with stable HR data      computed with warmup
                                            exclusion. Stored per
                                            activity.

  Use GAP-adjusted pace when elevation data Decoupling calculated on GAP,
  available                                 not raw pace, for any run
                                            with \>100m elevation gain.

  Support quartile-level decoupling for     Q1/Q2/Q3/Q4 EF values and
  races and long runs \>2 hours             progressive decoupling
                                            stored.

  Build personal decoupling baseline by     After ≥20 qualifying runs,
  effort zone                               expected decoupling range
                                            established per HR zone.
                                            Deviations \>2 stdev flagged.

  Track decoupling trend over time (rolling Trendline stored and
  30-day average of decoupling on easy      queryable. Negative slope =
  runs)                                     improving aerobic fitness.
  -----------------------------------------------------------------------

# 6. Running: Grade Adjusted Pace (GAP)

## 6.1 Objective

Normalize running pace for elevation to enable fair comparisons across
terrain and accurate TSS/intensity calculations on hilly courses.

## 6.2 Background & Research

Minetti et al. (2002, J Appl Physiol) published the foundational energy
cost curve for running on grade, showing metabolic cost follows an
asymmetric polynomial: uphill running costs more than the energy saved
going downhill at the same grade. The optimal downhill grade (lowest
energy cost) is approximately -10% to -20%.

**Formulation decision:** Minetti's original polynomial is the sole
implementation. Strava's proprietary version is undocumented and cannot
be reproduced faithfully; GOVSS (Skiba) is a further approximation. The
Minetti curve is the most physiologically grounded and is the standard
cited in peer-reviewed literature.

**Data architecture constraint:** Per-second activity stream records are
not available in Supabase (same constraint established in Section 5).
Only lap-level data from `garmin_activity_laps` is synced. All GAP
calculations are performed at lap granularity. See Section 5 decision
log entry "Lap-Level Data as the Only Available Stream Source."

## 6.3 Calculation Specification

**Minetti cost curve (per-meter energy cost relative to flat, in
J/kg/m):**

> C(grade) = 155.4\*g\^5 - 30.4\*g\^4 - 43.3\*g\^3 + 46.3\*g\^2 +
> 19.5\*g + 3.6

where g = fractional grade (e.g., 0.10 for 10% uphill).

Note: C(0) = 3.6 J/kg/m (flat-ground baseline). For uphill grades,
C(grade) > C(0), so GAP < actual pace (effort-equivalent flat pace is
faster). For moderate downhill, C(grade) < C(0), so GAP > actual pace.

> GAP\_pace\_per\_lap = actual\_lap\_pace \* (C(0) / C(grade\_lap))

where actual\_lap\_pace is derived from the lap's `distance` (km) and
`moving_time_seconds`: actual\_lap\_pace\_sec\_per\_km = (moving\_time\_seconds / distance\_km).

**Per-lap grade calculation:**

Grade is computed from the lap's elevation columns in
`garmin_activity_laps`:

> grade\_lap = (ascent - descent) / (distance\_km \* 1000)

where `ascent` and `descent` are in meters and `distance` is in km.
These values come from GarminDB's sync of the Garmin FIT file, which
uses barometric altimeter data when available (Garmin devices with
barometric altimeters store baro altitude in the FIT file; GarminDB
aggregates to lap-level ascent/descent from those records). No
additional smoothing is applied at lap level — the lap aggregation
itself provides the equivalent of low-frequency smoothing.

**Grade clamping:**

The Minetti polynomial produces physiologically unreliable values at
extreme grades. Clamp grade to \[-0.40, +0.45\] before evaluating C(g).
Laps exceeding these bounds (very steep trail segments) receive GAP
calculated at the clamped bound; a `grade_clamped` boolean flag is
stored per lap. Real activities rarely sustain a full lap at grades
outside this range.

**Activity-level average GAP:**

Average GAP pace for the activity is the distance-weighted mean of
per-lap GAP pace values:

> avg\_gap\_pace = Σ(lap\_gap\_pace \* lap\_distance) / Σ(lap\_distance)

Only laps with valid distance and moving time (distance > 0,
moving\_time\_seconds > 0) are included. Laps with ascent IS NULL
AND descent IS NULL are treated as flat (grade = 0, GAP = actual pace).

**GAP computation is client-side,** following the established pattern
from Section 5 (decoupling) and Section 2 (PMC). The `computeGAP`
function in `lib/gap.ts` reads laps from Supabase, computes per-lap GAP
values, and upserts results into `activity_gap` and `lap_gap` tables.

## 6.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Compute per-lap grade from lap elevation  Grade = (ascent - descent) /
  data in garmin\_activity\_laps             (distance\_km * 1000).
                                            Clamped to [-0.40, +0.45].
                                            grade\_clamped flag stored.
                                            Laps with NULL ascent/descent
                                            treated as grade = 0.

  Apply Minetti energy cost curve to        GAP values physiologically
  produce GAP per lap                       reasonable: 10% uphill lap
                                            should produce GAP \~30-40%
                                            faster than actual pace.
                                            C(0) = 3.6 used as baseline.

  Store both raw pace and GAP per activity  activity\_gap table: one row
  and per lap                               per activity storing
                                            avg\_gap\_pace\_seconds,
                                            avg\_raw\_pace\_seconds, and
                                            total\_ascent\_m.
                                            lap\_gap table: one row per
                                            (activity\_id, lap) storing
                                            raw\_pace\_sec\_per\_km,
                                            gap\_pace\_sec\_per\_km,
                                            grade\_fractional, and
                                            grade\_clamped.

  GAP used as input for decoupling (Section All downstream calculations
  5), EF (Section 7), and rTSS (Section 8)  can toggle between raw pace
  calculations when elevation data present  and GAP. Default: use GAP
                                            when activity ascent \>100m
                                            (from garmin\_activities.ascent).
                                            Section 5 backfill triggered
                                            when gap\_used = false AND
                                            awaiting\_gap = true.
  -----------------------------------------------------------------------

# 7. Running: Efficiency Factor (EF)

## 7.1 Objective

Track aerobic efficiency over time as a primary fitness indicator
independent of external conditions.

## 7.2 Background & Research

EF (normalized pace or power / average HR) was popularized by Joe Friel
and WKO. It provides a single number capturing how much output you
generate per heartbeat. For running, EF = GAP / avg HR. Improvement in
EF on standardized easy runs (same HR range, flat terrain) is one of the
cleanest signals of aerobic development, often preceding race
performance improvements by 4--8 weeks (Seiler, 2010). EF is
temperature-sensitive (higher HR in heat reduces EF), so environmental
normalization (Section 21) improves signal quality.

## 7.3 Calculation Specification

> EF_run = avg_GAP (m/s) / avg_HR (bpm)
>
> EF_cycle = normalized_power (W) / avg_HR (bpm)

Higher EF = more efficient. Use pace in m/s (not min/mile) so that
higher values always = better.

**Filtering for trend quality:**

- Only include runs in Z1--Z2 HR range for the EF trendline (easy
  aerobic runs)

- Exclude runs \<30 minutes (insufficient steady state)

- Exclude runs with temperature \>27°C or \<0°C unless
  temperature-adjusted (Section 21)

- Exclude first 10 minutes of each run

**Adaptive baseline:**

Build personal EF curve by HR zone. At HR 140, your EF might be 0.038
m/s/bpm. If it rises to 0.041 over 8 weeks, that's a \~8% aerobic
fitness gain. The system should fit a linear or polynomial regression of
EF vs. date for the easy zone and report slope (rate of improvement).

## 7.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate EF for every run and ride \>30  EF stored per activity.
  minutes                                   Running EF uses GAP when
                                            available.

  Maintain filtered EF trendline for easy   Rolling 30-day and 90-day
  aerobic runs only                         average EF computed on
                                            qualifying runs. Slope of
                                            trend reported.

  Temperature-adjusted EF available when    EF normalized to a reference
  weather data exists                       temperature (15°C) using the
                                            model from Section 21.

  Alert on significant EF changes           Flag when 30-day EF average
  (improvement or decline)                  changes by \>5% from 90-day
                                            average.
  -----------------------------------------------------------------------

# 8. Running: Power Estimation & rTSS

## 8.1 Objective

Estimate running power when no power meter is available, and use
power-based running TSS (rTSS) for more accurate training load
quantification, especially on hilly terrain.

## 8.2 Background & Research

Running power meters (Stryd, Garmin Running Power) measure or estimate
the mechanical power of running. When not available, power can be
estimated from the metabolic cost model. Skiba et al. (2006) and Minetti
et al. (2002) provide the physiological basis. Running power accounts
for grade, wind, and speed in a single metric, making it superior to
pace-only TSS for hilly courses.

rTSS (running TSS) is analogous to cycling TSS but uses running
functional threshold power (rFTP) as the reference. Normalized Graded
Pace (NGP) is an alternative approach that normalizes for grade and pace
variability, analogous to Normalized Power in cycling.

## 8.3 Calculation Specification

**Power estimation (when no power meter):**

> P_run = body_mass \* speed \* C(grade) + 0.5 \* rho \* Cd \* A \*
> speed\^3

where C(grade) is the Minetti cost function (Section 6), rho = air
density (\~1.225 kg/m³ at sea level), Cd\*A = drag coefficient \*
frontal area (\~0.24--0.30 m² for a runner).

**\[REVIEW\]** Wind data is needed for accurate drag calculation.
Without it, we can omit the aerodynamic term for non-windy conditions.
Acceptable simplification for most training runs. Flag for future:
integrate wind speed from weather API.

**Normalized Graded Pace (NGP) --- alternative approach:**

> NGP = rolling_30s_average(GAP)\^4, then (mean(NGP))\^(1/4)

Same fourth-power averaging as cycling NP, applied to GAP. Accounts for
variability cost.

**rTSS calculation:**

> IF_run = NGP / threshold_pace (or P_run / rFTP)
>
> rTSS = (duration_seconds \* NGP \* IF_run) / (threshold_pace \* 3600)
> \* 100

**\[REVIEW\]** Do you have a Stryd or Garmin Running Power? If yes, we
should prefer device power over estimation and only fall back to
estimation when device data is missing. Confirm your current running
power data availability.

## 8.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Estimate running power from pace, grade,  Estimated power within ±10%
  and body mass when no power meter data    of Stryd on matched flat runs
  available                                 (validation against any runs
                                            where both exist).

  Calculate NGP for every run with          Fourth-power averaging
  elevation data                            applied to GAP stream at
                                            30-second rolling window.

  Calculate rTSS using either power-based   rTSS stored per activity.
  or NGP-based method                       Method used (power vs NGP vs
                                            pace-only) flagged.

  rFTP (running functional threshold        System estimates rFTP from
  power/pace) auto-estimated from best      best 30-min or 60-min
  efforts                                   power/pace. Updates when new
                                            bests detected.
  -----------------------------------------------------------------------

8.1 Running Power Source Priority

Hierarchical power source priority (in order of accuracy):

1\. Stryd footpod --- most accurate, direct measurement

2\. Garmin Running Power (supported Forerunner/Fenix models) ---
acceptable accuracy

3\. Estimated power (see formula below) --- use when no dedicated
running power device is present

Tag each activity with power_source: enum (stryd, garmin_running_power,
estimated, none).

8.2 Estimated Running Power Formula

When no power device is present, estimate running power using:

P_run = (m x g x v x sin(grade)) + (m x g x v x Cr) + (0.5 x rho x Cd x
A x v\^3)

Where: m = body mass (kg), g = 9.81 m/s\^2, v = velocity (m/s), grade =
slope (decimal), Cr = rolling resistance coefficient (default 0.0075 for
road), rho = air density (kg/m\^3, default 1.225 at sea level 15°C ---
adjust for temperature and altitude), Cd = drag coefficient (default
0.9), A = frontal area (default 0.45 m\^2).

Adjust rho for temperature: rho = 1.225 x (288.15 / (273.15 +
temperature_C)). Adjust rho for altitude: rho = rho_sea_level x
exp(-altitude_m / 8500).

8.3 Elevation Data Source --- API Required

For rTSS calculations and all grade-dependent metrics (GAP, estimated
power): elevation data MUST come from a validated API, not raw GPS
altitude. Device GPS altitude is unreliable (±15-30m vertical error on
most consumer devices).

Mandatory elevation source: Open-Elevation API (free, open-source, based
on SRTM data) or equivalent. Endpoint: open-elevation.com/api/v1/lookup.
For each activity, fetch corrected elevation profile by passing the GPS
coordinate stream. Store both raw_elevation_m (from device) and
corrected_elevation_m (from API) in the activity_streams table. All
calculations use corrected_elevation_m exclusively.

Fallback if API unavailable: use raw GPS elevation with a smoothing
filter (Gaussian kernel sigma=5) to remove GPS jitter. Tag activity with
elevation_source: enum (api_corrected, gps_raw_smoothed, gps_raw).

# 9. Running: Dynamics (Cadence, GCT, Vertical Oscillation, Stride Length)

## 9.1 Objective

Track biomechanical efficiency metrics and detect fatigue-induced form
breakdown, particularly in the second half of long runs and races.

## 9.2 Background & Research

Moore (2016, Sports Med) reviewed cadence and found that self-selected
cadence often falls below the commonly cited 180 spm optimum, and that
individual optimal cadence depends on speed, leg length, and running
economy. Forcing 180 spm is not universally beneficial. However, CHANGES
in cadence at a given pace indicate fatigue. Ground contact time (GCT)
increases with fatigue as muscles lose elastic recoil capacity (Nummela
et al., 2007, J Sports Sci). Vertical oscillation increases with fatigue
as hip drop increases (Khassetarash et al., 2020).

The key insight: absolute values matter less than personal trendlines
and within-run drift patterns.

## 9.3 Calculation Specification

**Derived metrics:**

> stride_length = speed (m/s) / (cadence / 60 / 2)
>
> vertical_ratio = vertical_oscillation / stride_length \* 100

Vertical ratio \>8% is generally considered inefficient.

**Within-run fatigue detection:**

For runs \>45 minutes, compare dynamics in quartiles at matched pace
segments. If GCT increases by \>5% or cadence drops by \>3% at the same
pace in Q4 vs Q1, flag as fatigue-induced form breakdown.

**Adaptive personal baselines:**

Build per-pace-band profiles: at 5:00/km pace, your typical cadence
might be 172 spm with GCT of 248ms. Deviations from your established
profile at a given pace signal either fatigue (worse) or improvement
(better).

## 9.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate stride length and vertical      Derived per-record and
  ratio from available dynamics data        averaged per activity. Stored
                                            alongside raw dynamics.

  Detect within-run form breakdown via      For runs \>45 min, report GCT
  quartile comparison                       change, cadence change, and
                                            vertical oscillation change
                                            Q4 vs Q1 at matched pace
                                            bands. Flag if thresholds
                                            exceeded.

  Build personal dynamics profile by pace   After ≥30 runs with dynamics
  band                                      data, expected ranges for
                                            cadence, GCT, vert osc at
                                            each 30 sec/km pace band
                                            established.

  Track dynamics trends over time           Monthly rolling average of
                                            GCT at easy pace, cadence at
                                            easy pace stored. Improvement
                                            trendlines available.
  -----------------------------------------------------------------------

**\[UNKNOWN\]** Confirm your Garmin watch captures running dynamics
(GCT, vertical oscillation). Some models require the HRM-Pro or RD Pod
accessory. If not available, this section is limited to cadence and
derived stride length only.

9.1 Running Dynamics --- Device Capability Detection

Running dynamics metrics (cadence, GCT, vertical oscillation, stride
length, L/R balance) are device-dependent. Implement a capability check
at ingestion:

Detect which dynamics fields are present in the .fit file. Store a
dynamics_capabilities bitmask per device and activity. When a required
field is absent, skip the calculation for that metric --- never impute
missing dynamics values. Flag to athlete: \"Cadence available; ground
contact time not available for this activity (device capability
required).\"

9.2 Research Basis for Running Dynamics Benchmarks

Running dynamics norms are research-derived, not guesses. Specific
formulas and citations:

Cadence: optimal cadence range 170-185 spm at marathon pace
(Heiderscheit et al., 2011). Below 160 spm correlates with over-striding
and increased impact loading.

Ground Contact Time: elite runners \<200ms; recreational runners
200-300ms. Asymmetry \>3% (L/R balance) predicts injury risk (Zifchock
et al., 2006).

Vertical Oscillation: optimal \<9.5 cm. Higher VO correlates with
greater energy cost (Folland et al., 2017). Vertical Ratio (VO/stride
length) is more meaningful than absolute VO --- target \<9.5%.

Stride Length: calculated from pace and cadence: stride_length_m =
(pace_m_per_s / cadence_per_s) x 2. Over-striding defined as foot strike
\>5cm ahead of center of mass --- indirectly indicated by low cadence +
high GCT.

Citations: Heiderscheit BC et al. (2011). \"Effects of step rate
manipulation on joint mechanics during running.\" Medicine and Science
in Sports and Exercise 43(2):296-302. Zifchock RA et al. (2006).
\"Kinetic asymmetry in female runners with and without retrospective
tibial stress fractures.\" Journal of Biomechanics 39(15):2792-7.
Folland JP et al. (2017). \"Running technique is an important component
of running economy and performance.\" Medicine and Science in Sports and
Exercise 49(7):1412-23.

9.3 Per-Pace-Band Profiles

Build per-pace-band profiles for each athlete: at each pace band (e.g.,
4:30-4:45/km, 4:45-5:00/km, etc.), store mean cadence, GCT, VO, stride
length across all sessions at that pace. Flag deviations \>2 SD from
personal baseline as unusual gait events. This normalizes biomechanics
analysis by pace since all metrics vary with running speed.

# 10. Cycling: Mean Maximal Power (MMP) Curve

## 10.1 Objective

Build a complete power-duration curve from all cycling data to identify
strengths, limiters, and track fitness changes across the entire power
spectrum.

## 10.2 Background & Research

The MMP curve (also called power-duration curve or power profile) plots
the best average power achieved for every duration from 1 second to the
longest ride. Coggan & Allen (2010, Training and Racing with a Power
Meter) established this as the gold standard for profiling cycling
fitness. The shape of the curve reveals athlete type: sprinter (steep
left side), time trialist (flat middle), endurance (strong right side).
Comparing curves across time periods reveals where fitness is changing.

## 10.3 Calculation Specification

> For each duration d from 1s to max_ride_duration:
>
> MMP(d) = max over all rides of (max over all windows of size d of
> mean(power_stream))

This is computationally expensive. Optimize by precomputing rolling
averages at key durations (1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800,
3600, 5400, 7200 seconds) and interpolating.

**Time-windowed curves:**

Generate separate MMP curves for last 30, 90, 180, 365 days, and
all-time. Comparing recent to historical reveals current form vs. peak
fitness.

**Percentile ranking (optional):**

Normalize power to W/kg and compare against published power profiling
tables (Coggan's categories: Untrained through World Class). Useful for
context but not essential for training decisions.

## 10.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Compute MMP for all durations from 1s to  MMP curve accurate to within
  max ride length for all cycling           1W at all key durations when
  activities                                validated against
                                            Zwift/Golden Cheetah.

  Generate time-windowed MMP curves         Each window's curve
  (30/90/180/365/all-time)                  independently computed and
                                            stored.

  Detect new personal bests (peak power at  When a new MMP record is set
  any duration) and flag them               at any key duration, the
                                            activity is annotated.

  Store MMP data efficiently (key           Storage for MMP \< 50KB per
  durations + interpolation, not every      time window.
  second for every ride)                    
  -----------------------------------------------------------------------

10.1 Mean Maximal Power Curve --- Requirements

Build a rolling MMP curve storing: peak power for every duration from 1s
to 60min (at 1s increments up to 30s, then at key durations: 1min, 2min,
3min, 5min, 8min, 10min, 12min, 20min, 30min, 60min). Update after every
cycling activity with power data.

Per-activity MMP: store within activity_mmp table. All-time MMP: store
within athlete_mmp (personal best at each duration). Rolling 90-day MMP:
recompute nightly.

Store MMP per sport separately: cycling_mmp and running_mmp (for running
power via Stryd/Garmin Running Power). Do not mix sport types in the
same MMP curve.

# 11. Cycling: Critical Power (CP) & W' Balance

## 11.1 Objective

Model the power-duration relationship to derive CP (sustainable power
boundary) and W' (finite anaerobic work capacity), and track W'
depletion/recovery in real time for pacing and race analysis.

## 11.2 Background & Research

Monod & Scherrer (1965) introduced the critical power concept: work
above CP depletes a finite energy reserve (W'). Work below CP allows W'
to reconstitute. Skiba et al. (2012, Med Sci Sports Exerc) formalized W'
balance (W'bal) tracking during intermittent exercise and validated the
differential equation model for real-time W' tracking. CP is a better
proxy for sustainable power than FTP for many athletes. Morton (2006)
showed that the 2-parameter CP model (CP + W') fits power-duration data
from \~2 minutes to \~30 minutes. A 3-parameter model adds Pmax for very
short durations.

## 11.3 Calculation Specification

**2-parameter CP model:**

> t = W\' / (P - CP)
>
> equivalently: P = CP + W\' / t

Fit CP and W' from MMP data using least-squares regression on efforts
between 2--20 minutes (minimum 3 efforts at different durations).

**W' balance tracking (Skiba model):**

> W\'bal(t) = W\' - Σ\[W\'exp(i)\] + Σ\[integral of reconstitution\]

Simplified discrete form:

> For each second t:
>
> if P(t) \> CP: W\'bal(t) = W\'bal(t-1) - (P(t) - CP)
>
> if P(t) \< CP: W\'bal(t) = W\'bal(t-1) + (W\' - W\'bal(t-1)) \* (1 -
> exp(-(CP - P(t)) \* dt / W\'))

**Adaptive CP:**

CP and W' should update as new MMP data accumulates. Refit monthly or
when new bests at key durations are detected. Compare CP to FTP (Section
13) --- they should track closely but are not identical. Divergence may
indicate testing protocol issues.

## 11.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Fit 2-parameter CP model from MMP curve   CP and W' derived with R² \>
  data                                      0.95 on fitting data.
                                            Requires ≥3 efforts spanning
                                            2--20 minutes.

  Calculate W'bal for every cycling         Per-second W'bal stream
  activity with power data                  stored. Minimum W'bal during
                                            activity flagged.

  Track CP and W' over time with monthly    Historical CP/W' values
  refitting                                 stored with fit dates and
                                            confidence.

  Compare CP to FTP and flag divergence     If \|CP - FTP\| \> 10W,
                                            generate a review note.
  -----------------------------------------------------------------------

11.1 Critical Power Model --- Exact Formula

Two-parameter CP model: W = CP x t + W\' where W = total work done
(joules), CP = critical power (watts), t = time (seconds), W\' =
anaerobic work capacity (joules). Rearranged for max power at time t:
P_max(t) = CP + W\'/t.

Fitting method: collect the athlete\'s best power output for each of:
3min, 5min, 8min, 12min, 20min, 60min efforts. Fit CP and W\' by
minimizing sum of squared residuals using nonlinear least squares.
Minimum 4 data points required across at least 3 different durations.

W\' Balance tracking during a ride: W\'\_bal(t) = W\' - integral\[max(0,
P(t) - CP)\] dt + recovery. Recovery when P(t) \< CP: W\'\_bal recovers
with time constant tau_W\' = 546 x exp(-0.01 x (CP -
mean_power_below_CP)) + 316 (Skiba et al., 2012).

Citation: Monod H, Scherrer J (1965). \"The work capacity of a synergic
muscular group.\" Ergonomics 8(3):329-338. Skiba PF et al. (2012).
\"Modeling the expenditure and reconstitution of work capacity above
critical power.\" Medicine and Science in Sports and Exercise
44(8):1526-32.

11.2 CP vs FTP Divergence Alert

Compare CP to FTP and flag if \|CP - FTP\| \> 10%. Surface insight:
\"Your Critical Power estimate (X W) differs from your stored FTP (Y W)
by Z%. Consider an FTP test to align these values.\" Both metrics serve
different purposes: CP is physiologically derived, FTP is
performance-validated.

# 12. Cycling: Intensity Factor, Variability Index, Normalized Power

## 12.1 Objective

Quantify ride intensity and pacing quality for every cycling session.

## 12.2 Background & Research

Coggan (2003) introduced Normalized Power (NP) to account for the
disproportionate physiological cost of power variability --- riding at
variable power costs more glycogen than the same average power ridden
steadily. IF (NP/FTP) contextualizes the ride intensity. VI (NP/avg
power) measures pacing smoothness.

## 12.3 Calculation Specification

> NP = (mean(rolling_30s_avg_power\^4))\^(1/4)
>
> IF = NP / FTP
>
> VI = NP / avg_power
>
> cycling_TSS = (duration_seconds \* NP \* IF) / (FTP \* 3600) \* 100

NP uses a 30-second rolling average to dampen micro-variability while
preserving macro-variability. VI near 1.0 = steady ride; VI \> 1.1 =
variable (common in Zwift races with surges).

## 12.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate NP, IF, VI, and TSS for every   NP within ±1W of
  cycling activity with power data          Zwift/TrainingPeaks on
                                            identical data. TSS stored
                                            per activity.

  Use current FTP (auto-detected or         FTP changes retroactively
  manually set) for IF and TSS calculation  recalculate IF/TSS only for
                                            future display, not stored
                                            values. Historical values
                                            preserved with the FTP used
                                            at the time.

  Flag rides with VI \> 1.15 for pacing     Annotation on activity. Not
  review                                    an alert --- just metadata.
  -----------------------------------------------------------------------

12.1 Normalized Power (NP) --- Exact Formula

NP uses a 30-second rolling average to dampen micro-variability: (1)
calculate 30s rolling average power at each second; (2) raise each value
to the 4th power; (3) average all 4th-power values over the ride; (4)
take the 4th root. NP = (mean(P_30s_rolling\^4))\^0.25. Source: Coggan
A, Allen H (2010). \"Training and Racing with a Power Meter.\"
VeloPress.

Intensity Factor (IF) = NP / FTP. Variability Index (VI) = NP /
average_power. A VI \>1.05 indicates significant power variability
(criterium or group ride); VI \<1.05 indicates steady effort (time trial
or solo training).

Training Stress Score (TSS) = (duration_seconds x NP x IF) / (FTP x
3600) x 100.

12.2 Require Research Citations for Adaptive Calibration Loop

The adaptive calibration loop for the NP/IF/TSS model updates when
athlete FTP changes. The adaptive formula follows Section 14.2. Key
citation: Coggan A (2003). \"Training and Racing with a Power Meter.\"
Note: the NP algorithm was validated on cycling power data and may be
less accurate for very short high-intensity intervals (\< 20s). Tag
activities where \>20% of time is in efforts \<20s duration with a
low_np_confidence flag.

# 13. Cycling: FTP Auto-Detection & Tracking

## 13.1 Objective

Continuously estimate FTP from training data without requiring formal
tests, while allowing manual override from test results.

## 13.2 Background & Research

FTP (Functional Threshold Power) is defined as the highest power
sustainably maintained for \~1 hour. The classic estimation method uses
95% of best 20-minute power (Allen & Coggan). However, this
systematically overestimates FTP for athletes with high anaerobic
capacity. The CP model (Section 11) often provides a better estimate.
Zwift's FTP test (20 minutes with a warmup ramp) gives direct
measurement opportunities. For tracking purposes, a rolling estimate
based on best recent efforts across multiple durations is more robust
than any single test protocol.

## 13.3 Calculation Specification

**Multi-method estimation:**

- Method A: 95% of best 20-minute power (rolling 42-day window)

- Method B: CP from 2-parameter model (Section 11)

- Method C: 75% of best 8-minute power (for athletes lacking 20-min
  efforts)

- Method D: Manual entry from formal test

Use the median of available methods as the auto-estimated FTP. Weight
Method D highest when recent (\<8 weeks). Flag when estimates diverge by
\>15W.

**FTP change detection:**

When auto-estimated FTP changes by \>5W from stored value, prompt for
review. Do not auto-update without user confirmation to avoid cascading
TSS recalculation issues.

## 13.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Auto-estimate FTP using multiple methods  Estimated FTP within ±5% of
  from training data                        formal test result (validated
                                            against your initial 286W
                                            test).

  Track FTP over time with change detection FTP history stored with dates
                                            and estimation method.
                                            Changes \>5W flagged for user
                                            review.

  Support manual override with formal test  Manual entries timestamped
  results                                   and weighted as primary
                                            source for 8 weeks.

  W/kg calculated and tracked alongside FTP FTP/weight stored per FTP
  when weight data available                update. Weight interpolated
                                            between measurements if not
                                            daily.
  -----------------------------------------------------------------------

13.1 FTP Changes --- Historical Data Immutability

CRITICAL RULE: When an athlete\'s FTP changes (whether auto-detected or
manually updated), the new FTP value applies ONLY to the current
activity onward and all future activities. Historical activities are NOT
recalculated with the new FTP.

Rationale: historical TSS values calculated with last year\'s FTP
correctly represent the relative training stress experienced at that
time. Retroactively applying today\'s FTP would distort historical
ATL/CTL/TSB in a way that no longer reflects what the athlete actually
experienced physiologically.

Implementation: store ftp_at_activity alongside each activity record.
This value is immutable after processing. FTP changes create a new
record in the ftp_history table (date, ftp_value, source: auto/manual)
but do not trigger historical recalculation.

This applies to ALL athlete parameters (FTP, threshold pace, max HR,
zone boundaries) --- changes are always forward-only.

13.2 FTP as Both Input and Auto-Calculated

Support two modes:

\- Manual FTP: athlete enters a lab-tested or recent-best FTP. System
uses this value and does not auto-override it.

\- Auto-detected FTP: system estimates FTP from best power efforts using
the Critical Power model (see Section 11). When auto-detected FTP
differs from stored manual FTP by \>5W, surface a review flag --- do NOT
automatically update. Athlete confirms update manually.

Store ftp_source field: enum (manual_entry, lab_test, auto_cp_model,
auto_ramp_test, user_confirmed_auto).

13.3 Starting Model --- Banister Impulse-Response

Starting model (\< 8 weeks data): Banister impulse-response model with
population defaults:

\- Fitness time constant (tc_fitness): 42 days

\- Fatigue time constant (tc_fatigue): 7 days

\- Fitness multiplier (k1): 1.0

\- Fatigue multiplier (k2): 2.0

Transition to personalized model: when athlete has 8+ weeks of data AND
3+ performance test events (time trials, race results, or max efforts),
fit individual time constants via nonlinear least-squares regression
minimizing prediction error on known performance outcomes.

Transition is seamless --- the athlete is not notified, but the Model
Parameters page shows current parameter values and whether they are
defaults or personalized.

Citation: Banister EW et al. (1975). \"A systems model of training for
athletic performance.\" Australian Journal of Sports Medicine
7(3):57-61.

# 14. Cross-Sport Combined Load Model

## 14.1 Objective

Produce a unified training load metric that accurately weights running
and cycling stress by their differential physiological and orthopedic
impacts.

## 14.2 Background & Research

Running and cycling impose qualitatively different stresses. Running
involves high eccentric loading (impact forces 2--3x body weight per
stride --- Keller et al., 1996, Clin Biomech) causing greater muscle
damage, connective tissue stress, and bone loading than cycling. Cycling
is primarily concentric and produces minimal impact-related tissue
damage. A 100 TSS bike ride and a 100 TSS run are metabolically similar
but orthopedically different.

No established standard weighting exists in literature. Mujika (2017)
discusses cross-training load modeling but acknowledges the lack of
validated conversion factors. This requires an empirical/adaptive
approach.

## 14.3 Calculation Specification

**Combined metabolic load (for PMC):**

> combined_TSS = running_TSS + cycling_TSS

For PMC purposes, metabolic stress is roughly equivalent per TSS unit.

**Combined orthopedic load (for ACWR / injury risk):**

> ortho_load = running_TSS \* w_run + cycling_TSS \* w_cycle

Default weights: w_run = 1.5, w_cycle = 0.5. This reflects \~3x higher
orthopedic impact of running per TSS unit.

**Adaptive weight fitting:**

If injury data available (Section 27), fit w_run and w_cycle by finding
the weighting that best separates injured from non-injured weeks using
the ACWR framework.

**\[REVIEW\]** The default weighting (1.5 run / 0.5 cycle) is an
educated guess based on biomechanical literature. These should be
treated as initial values subject to adjustment based on your personal
data. After 6--12 months with injury logging, the system should have
enough data to personalize.

## 14.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate combined metabolic TSS          Combined PMC tracks correctly
  (unweighted sum) for PMC                  with both running and cycling
                                            inputs.

  Calculate orthopedic-weighted combined    Separate from metabolic load.
  load for ACWR and injury risk             Uses configurable weights
                                            stored in athlete_parameters.

  Weights adjustable manually and adaptable Manual override always
  from data                                 available. Adaptive fitting
                                            runs when injury data
                                            permits.
  -----------------------------------------------------------------------

14.1 Default Weights --- Research Basis

Default cross-sport weights: w_run = 1.5, w_cycle = 0.5, w_swim = 0.3,
w_strength = 0.4.

Research basis: Millet et al. (2009) triathlon research demonstrates
approximately 3x greater neuromuscular stress per cardiovascular unit
for running vs. cycling. Coggan & Allen\'s TSS framework shows running
TSS typically runs 1.5-2x cycling TSS for equivalent perceived exertion.
The 1.5/0.5 ratio is normalized so a balanced multi-sport week produces
a physiologically sensible combined stress score.

Citation: Millet GP, Vleck VE, Bentley DJ (2009). \"Physiological
differences between cycling and running: lessons from triathletes.\"
Sports Medicine 39(3):179-206.

14.2 Adaptive Calibration Loop --- Exact Formula

The adaptive calibration loop formula for updating sport weights:

w_sport_new = w_sport_current + learning_rate x
(session_quality_actual - session_quality_predicted) x
sport_contribution_fraction

Where: learning_rate = 0.05 (conservative update per session),
session_quality_actual = measured session quality score (0-10),
session_quality_predicted = model prediction using current weights,
sport_contribution_fraction = fraction of total pre-session TSS from
this sport.

Update trigger: run after each completed session when session quality
score is available. Clamp weights: minimum 0.1, maximum 3.0. Require
minimum 20 sessions per sport before allowing weight updates to avoid
overfitting to early noise.

14.3 Combined Load Formula

Combined_TSS = (run_tss x w_run) + (cycle_tss x w_cycle) + (swim_tss x
w_swim) + (strength_tss x w_strength). Use Combined_TSS in place of raw
TSS for all multi-sport CTL/ATL calculations.

# 15. Cross-Training Transfer Detection

## 15.1 Objective

Detect and quantify the transfer effect of cycling training on running
aerobic fitness, enabling smarter training allocation.

## 15.2 Background & Research

Cycling improves central cardiac output (stroke volume, plasma volume
expansion) without running-specific musculoskeletal stress (Tanaka,
1994, Sports Med). For injury-prone runners, cycling volume can
substitute partially for running volume in developing aerobic fitness.
Millet et al. (2002) showed cross-training transfer is most effective at
submaximal intensities (below threshold). The magnitude varies by
individual, training history, and the degree of sport-specific
adaptation already present.

## 15.3 Calculation Specification

**Lagged correlation analysis:**

For rolling 8-week windows: compute correlation between weekly cycling
TSS (lagged by 1--4 weeks) and running EF (Section 7). A positive lagged
correlation suggests cycling volume is contributing to running aerobic
fitness with the given time delay.

> transfer_coefficient(lag) = corr(cycling_weekly_TSS\[t-lag\],
> running_EF\[t\])

Report the lag (in weeks) with highest positive correlation and the
correlation magnitude.

**Minimum data for analysis:**

Requires ≥16 weeks of consistent data with both running and cycling
present in most weeks.

## 15.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Compute lagged correlation between        Correlation computed at lags
  cycling load and running aerobic metrics  1--6 weeks. Results stored
                                            with confidence intervals.

  Report optimal lag and transfer           Surfaced as: 'Cycling TSS
  coefficient                               correlates with running EF
                                            improvement at X-week lag
                                            with r = Y.'

  Update analysis monthly as data           Recomputed on 1st of each
  accumulates                               month. Minimum 16 weeks
                                            required.
  -----------------------------------------------------------------------

**\[UNKNOWN\]** The transfer coefficient is correlational, not causal.
The system should clearly label this as an observed association, not a
guaranteed training prescription. Consider displaying with appropriate
caveats.

15.1 Cross-Training Transfer Detection --- Requirements

The cross-training transfer detection engine identifies when aerobic
fitness built in one sport is transferring to another. Implementation:

Detect transfer when: aerobic efficiency (EF) improves in sport B within
4 weeks following a high-volume block in sport A, while sport B volume
was constant or declining. Log as a transfer_event: source_sport,
target_sport, source_volume_change_pct, target_ef_change_pct,
detection_date.

Sport pairs supported: cycling→running (well-established transfer),
running→cycling (partial transfer), swimming→running (cardiovascular
base transfer). Transfer magnitude: cycling→running transfer estimated
at 40-60% of cycling fitness gain (Millet et al., 2009 --- triathlon
adaptation research).

15.2 Adaptive Cross-Sport Weight Calibration

The cross-sport weights (default w_run=1.5, w_cycle=0.5, w_swim=0.3) are
initialized from research but MUST adapt to the individual athlete over
time. The adaptive calibration loop: after 8+ weeks with both sports in
the training log, fit individual weights to minimize prediction error in
the combined load vs. session quality model. Store both default_weight
and calibrated_weight for each sport pair. Show athlete: \"Your personal
cycling-to-running weight has been calibrated to 0.6 based on your last
12 weeks of data.\"

Citation: Millet GP et al. (2009). \"Physiological differences between
cycling and running.\" Sports Medicine 39(3):179-206.

# 16. Polarized Training Distribution

## 16.1 Objective

Analyze training intensity distribution across both sports to ensure
adherence to evidence-based polarized training principles.

## 16.2 Background & Research

Seiler (2010, Int J Sports Physiol Perform) demonstrated that elite
endurance athletes across sports (running, cycling, XC skiing, rowing)
converge on a \~80/20 distribution: \~80% of training volume at low
intensity (zone 1), \~20% at high intensity (zone 3/4), and minimal time
in the "no-man's-land" moderate intensity (zone 2/threshold). Stöggl &
Sperlich (2014) compared training models and found polarized
distribution produced the greatest improvements in VO2max, time to
exhaustion, and body composition. The pyramidal model (more threshold
work) was second-best. A threshold-heavy distribution was least
effective.

For dual-sport athletes, the distribution should be assessed ACROSS both
sports combined, as athletes frequently maintain polarized distribution
within each sport while accidentally training too much moderate
intensity in aggregate.

## 16.3 Calculation Specification

**3-zone model:**

- Zone 1 (low): below VT1 / below 80% of threshold HR / below 55% of FTP

- Zone 2 (moderate / threshold): between VT1 and VT2 / 80-100% threshold
  HR / 55-100% FTP

- Zone 3 (high): above VT2 / above threshold HR / above FTP

> pct_zone1 = sum(time_in_zone1_all_activities) / total_training_time \*
> 100
>
> pct_zone2 = sum(time_in_zone2_all_activities) / total_training_time \*
> 100
>
> pct_zone3 = sum(time_in_zone3_all_activities) / total_training_time \*
> 100

Calculate per-sport and combined. Use HR-based zones for running (unless
power available), power-based zones for cycling.

**Adaptive targets:**

Default target: 75--85% Z1, 5--10% Z2, 10--20% Z3. As the system learns
which distributions precede your best performances (highest EF, best
race results), personalize the target distribution.

**\[REVIEW\]** HR zone boundaries: do you have lab-tested VT1/VT2 or
lactate threshold values? If not, we'll estimate from threshold
pace/FTP. Lab values would significantly improve zone classification
accuracy.

## 16.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate weekly and monthly time-in-zone Percentages computed across
  distribution for 3-zone model             running, cycling, and
                                            combined. Stored weekly.

  Use HR for running zone classification,   Appropriate metric used per
  power for cycling                         sport. Fallback to HR for
                                            cycling if no power meter on
                                            outdoor rides.

  Compare actual distribution against       Deviation from target
  target and report deviation               reported as percentage points
                                            per zone.

  Track distribution over time to correlate Weekly distribution stored.
  with performance outcomes                 Correlation with subsequent
                                            4-week EF and race results
                                            queryable.
  -----------------------------------------------------------------------

16.1 Zone Model --- 5-Zone System (Mandatory)

The 5-zone heart rate model is the REQUIRED default. The 3-zone model is
NOT used as the primary display. Zone boundaries:

\- Zone 1 (Recovery): \<68% HRmax

\- Zone 2 (Aerobic/Base): 68-83% HRmax

\- Zone 3 (Tempo/Threshold): 83-94% HRmax

\- Zone 4 (VO2max): 94-100% HRmax

\- Zone 5 (Anaerobic): \>100% HRmax (relative effort)

For polarized training analysis: map zones to polarized triplets --- Low
(Z1+Z2), Moderate (Z3), High (Z4+Z5). Optimal polarized distribution
target: \~80% low, \~5% moderate, \~15% high (Seiler & Tønnessen, 2009).

16.2 Double Threshold Support

Store time spent in the lactate threshold band (approximately LT1-LT2,
spanning the lower Z3 range) as a separate field:
time_in_threshold_band_min. This enables double threshold analysis
alongside polarized analysis from the same raw data. LT1 and LT2
boundary values: user-defined via lab test (preferred), or estimated as
LT1 = 81% HRmax, LT2 = 91% HRmax (Faude et al., 2009).

16.3 Zone Boundary Changes --- Historical Data Immutability

CRITICAL RULE: When an athlete updates their HR zone boundaries (e.g.,
after retesting max HR or setting new LT values), the system MUST NOT
retroactively recalculate zone assignments for historical activities.

Activities from the past retain the zone assignments that were correct
at the time those activities occurred. Zone boundaries from 1 year ago
represent the true physiological zones for activities from 1 year ago.
Only current and future activities use the new boundaries.

Implementation: store zone_boundary_version_id on each activity
alongside the zone distribution. When boundaries update, create a new
zone_boundary_version record. Activities query their own version for
display.

Citations: Seiler S, Tønnessen E (2009). \"Intervals, thresholds, and
long slow distance: the role of intensity and duration in endurance
training.\" Sportscience 13:32-53. Faude O et al. (2009). \"Lactate
threshold concepts.\" Sports Medicine 39(6):469-490.

# 17. HRV Analysis & Readiness

## 17.1 Objective

Use heart rate variability trending to assess autonomic nervous system
status, detect overreaching, and inform daily training intensity
decisions.

## 17.2 Background & Research

Plews et al. (2012, Int J Sports Physiol Perform) established that the
coefficient of variation (CV) of the natural log of RMSSD (lnRMSSD) over
a 7-day rolling window is more useful than raw HRV for monitoring
training adaptation. A decreasing CV (less day-to-day variability)
combined with a decreasing mean suggests parasympathetic saturation or
overreaching. Buchheit (2014, Sports Med) provided a comprehensive
framework: baseline HRV established over 2--4 weeks, then deviations
from the individual's smallest worthwhile change (SWC = 0.5 \*
between-day SD) guide daily decisions.

Key principle: HRV is individual. Population norms are meaningless. Only
within-athlete trends matter.

## 17.3 Calculation Specification

**Daily processing (from morning measurement):**

> lnRMSSD = ln(RMSSD_value)
>
> 7day_rolling_mean = mean(lnRMSSD over last 7 days)
>
> 7day_rolling_SD = stdev(lnRMSSD over last 7 days)
>
> CV = (7day_rolling_SD / 7day_rolling_mean) \* 100

**Baseline establishment:**

Use first 14--28 days of consistent data as baseline. SWC = 0.5 \*
baseline_SD.

**Daily readiness classification:**

- Green (recovered): lnRMSSD within ±SWC of rolling mean, CV stable or
  increasing

- Amber (monitor): lnRMSSD below rolling mean by 1--2x SWC, OR CV
  decreasing

- Red (suppress training): lnRMSSD below rolling mean by \>2x SWC, OR CV
  significantly decreased over 7+ days

**Adaptive thresholds:**

After 3+ months, correlate daily readiness classification with
subsequent training quality (session quality score from Section 25). If
Green days consistently produce good sessions and Red days produce poor
sessions, the thresholds are well-calibrated. If not, adjust SWC
multiplier.

**\[UNKNOWN\]** Garmin HRV data format: if your device exports raw
RMSSD, calculations proceed as specified. If it exports a proprietary
0--100 HRV Status score, we need a mapping function or must use the
score as-is with adapted thresholds. Verify which format GarminDB
provides.

## 17.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Compute daily lnRMSSD, 7-day rolling      Values computed when HRV data
  mean, SD, and CV                          available. Missing days
                                            handled by extending window
                                            (max 10 days).

  Classify daily readiness as               Classification uses SWC-based
  Green/Amber/Red                           thresholds relative to
                                            personal baseline.

  Establish and maintain personal baseline  Baseline recalculated monthly
  with auto-update                          using prior 28-day window.
                                            Initial baseline from first
                                            14--28 days.

  Detect overreaching pattern (sustained CV Alert when both CV and mean
  decline + mean decline)                   have declined for 7+
                                            consecutive days.

  Correlate readiness with session quality  After 3 months, report
  for threshold calibration                 accuracy of readiness
                                            prediction. Adjust thresholds
                                            if accuracy \< 65%.
  -----------------------------------------------------------------------

17.1 HRV Data Format --- Multi-Device Support

The system must support all of the following HRV formats and auto-detect
the source type:

\- RMSSD (ms): standard metric used by Garmin (newer devices), Polar,
and academic HRV research. This is the preferred metric.

\- Garmin HRV Status: proprietary composite score (0-100) on older
Garmin devices. Store as hrv_format=\'garmin_status\'. Cannot be
directly compared to RMSSD baseline.

\- SDNN (ms): used by some Apple Watch algorithms. Store with
hrv_format=\'sdnn\'.

\- Whoop Recovery Score: proprietary 0-100 scale. Store with
hrv_format=\'whoop\'.

Schema: daily_health.hrv_value (float), daily_health.hrv_metric_type
(enum: rmssd, garmin_status, sdnn, whoop_recovery, other). CRITICAL:
never mix different hrv_metric_types in the same baseline calculation
window. If the athlete switches devices, start a new baseline period.

17.2 GarminDB-Specific HRV Implementation

For GarminDB integration: query the hrv table for daily RMSSD where
available. Detect device generation from the garmin_device table ---
newer Garmin (Fenix 7+, Forerunner 9xx, Epix) exports RMSSD; older
models export a stress-derived HRV estimate. Log the detected format to
hrv_metric_type at first sync. User can override the detected format.

17.3 Graceful Fallback Without HRV Data

All HRV-dependent calculations must implement graceful fallback. If
hrv_value is null: exclude HRV component from composite recovery score,
set hrv_contribution = 0, and add a data_completeness_flag =
\'hrv_missing\' to the output. Never return null or error --- return the
best available estimate from remaining inputs (resting HR, sleep, TSB).
Surface to athlete: \"Recovery score: 6.2/10 (HRV data unavailable ---
score is HR and sleep-based only).\"

17.4 Citation

HRV analysis methodology: Kiviniemi AM et al. (2007). \"Endurance
performance and nonadjacent HRV data.\" International Journal of Sports
Medicine. RMSSD as a vagal index: Task Force of ESC and NASPE (1996).
Heart rate variability standards. Circulation 93(5):1043-1065.

# 18. Resting Heart Rate Trending

## 18.1 Objective

Track resting heart rate as a simple, reliable indicator of
cardiovascular fitness trends and early illness/overtraining detection.

## 18.2 Background & Research

Resting heart rate (RHR) is one of the oldest and most validated fitness
biomarkers. Improved cardiovascular fitness reduces RHR via increased
stroke volume (Blomqvist & Saltin, 1983). Acute RHR elevation of 3--5
bpm above personal baseline precedes illness onset by 1--2 days in \~60%
of cases (Buchheit et al., 2013). Chronic RHR elevation indicates
accumulated fatigue or detraining.

## 18.3 Calculation Specification

> baseline_rhr = rolling_28day_median(rhr_values)
>
> deviation = today_rhr - baseline_rhr

Use median (not mean) to resist outlier influence from one bad night.

**Alerts:**

- Acute elevation: \>3 bpm above baseline for 2+ consecutive days

- Trend elevation: 7-day rolling average increasing by \>2 bpm over 14
  days

- Fitness improvement: baseline RHR declining over 8+ week period

## 18.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Track daily RHR with rolling 28-day       Baseline updates daily.
  median baseline                           Stored in calculated_metrics.

  Alert on acute elevation (\>3 bpm above   Alert generated with severity
  baseline for 2+ days)                     and recommended action
                                            (reduce training).

  Track long-term RHR trend as fitness      Monthly RHR average stored.
  indicator                                 Negative slope = improving
                                            fitness.
  -----------------------------------------------------------------------

18.1 Resting HR Trend --- Calculation Method

Compute a 7-day rolling mean and 30-day rolling mean for resting heart
rate. The 30-day mean serves as the personal baseline. Trend alerts
trigger when: 7-day mean exceeds 30-day mean by \>5 bpm for 3+
consecutive days (elevation alert), or drops below by \>5 bpm (positive
adaptation signal).

Store all resting HR values with their source (device morning HR,
manually logged, or estimated from activity recovery HR). When multiple
sources exist on the same day, prioritize: manual entry \> device
morning HR \> activity recovery estimate.

18.2 Trendline Storage Requirements

Per comment \[45\]: all resting HR data must be stored and queryable
with historical context. Schema: daily_health table stores resting_hr,
resting_hr_source, resting_hr_7day_mean, resting_hr_30day_mean. Full
history is retained permanently. Support querying by date range for
trend visualization. Pre-compute and cache rolling means nightly.

# 19. Sleep Integration & Performance Correlations

## 19.1 Objective

Quantify the impact of sleep quality and duration on next-day training
performance to enable data-driven recovery decisions.

## 19.2 Background & Research

Mah et al. (2011, Sleep) showed that extending sleep to 10 hours
improved sprint times, reaction time, and mood in Stanford basketball
players. Vitale et al. (2019, Sports Med) reviewed sleep and athletic
performance, finding that \<7 hours of sleep reduces endurance
performance by 2--4%, increases RPE, and impairs glycogen replenishment.
Sleep quality (deep sleep percentage) may matter as much as duration for
recovery (Dattilo et al., 2011, Med Hypotheses). Growth hormone,
critical for tissue repair, is primarily secreted during deep sleep.

## 19.3 Calculation Specification

**Sleep quality score (composite):**

> sleep_score = w1\*(total_hours/target_hours) +
> w2\*(deep_pct/target_deep_pct) + w3\*(1-awake_minutes/total_minutes)

Defaults: target_hours = 8, target_deep_pct = 20%, w1 = 0.4, w2 = 0.35,
w3 = 0.25. Score 0--1, where 1 = ideal. Weights adaptable based on which
sleep components best predict next-day performance.

**Correlation analysis:**

For each session, compute the lagged correlation between prior-night
sleep score and session quality (Section 25). Also test 2-night rolling
average (cumulative sleep debt).

**Adaptive sleep targets:**

After 3+ months: find the sleep score threshold below which session
quality degrades \>10%. This becomes the personalized minimum sleep
score threshold.

## 19.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Compute nightly sleep quality score from  Score generated nightly.
  available sleep stage data                Missing stages handled
                                            gracefully (reduce weight to
                                            0 for missing components,
                                            renormalize).

  Correlate sleep score with next-day       Running correlation updated
  session quality                           weekly. Report r-value and
                                            significance.

  Track cumulative sleep debt (rolling      Cumulative deficit/surplus
  7-day sleep duration vs. target)          stored. Alert when cumulative
                                            deficit \>5 hours.

  Learn personalized sleep-performance      After 90 days, report the
  threshold                                 sleep score below which
                                            session quality drops. Update
                                            quarterly.
  -----------------------------------------------------------------------

19.1 Adaptive Sleep Target Calculation

The adaptive sleep performance threshold is calculated as follows:

Phase 1 (first 30 data points or 3 months): use population default
threshold --- sleep score 70 is the minimum for maintaining training
quality, based on Walker & Stickgold (2004) sleep and motor learning
research.

Phase 2 (30+ {sleep_score, next_session_quality} pairs spanning 3+
months): fit a piecewise linear regression (changepoint model) to find
the individual inflection point where session quality drops \>10% below
the high-sleep baseline. This changepoint becomes the athlete\'s
personal sleep performance threshold.

Store the threshold in athlete_parameters.sleep_quality_threshold. Show
the athlete the raw scatter plot of sleep score vs. session quality, the
fitted threshold line, and the data volume required for personalization.

19.2 Optional Stress Integration

Life/work stress integration into sleep analysis is OPTIONAL. Implement
a perceived_stress check-in (1-5 scale, optional daily entry). When
provided: flag nights with high stress (≥4) and exclude them from
threshold calibration to avoid confounding sleep quality signal with
external stress. When not provided: use all data points --- the
threshold will naturally reflect the athlete\'s real-world sleep quality
distribution including stressed nights.

19.3 Graceful Degradation Without Sleep Data

When sleep data is unavailable (e.g., no device worn overnight, or
device lacks sleep tracking): exclude sleep inputs from all dependent
calculations and flag outputs as incomplete. Never impute or assume
sleep quality. Show data_completeness_score to athlete indicating which
inputs are missing.

# 20. Recovery Timeline Modeling

## 20.1 Objective

Predict recovery state after training sessions and races to inform
training plan compliance decisions.

## 20.2 Background & Research

Recovery from exercise follows a supercompensation curve: performance
initially declines (fatigue), then returns to baseline, then briefly
exceeds baseline before returning. The timeline depends on session
intensity and duration, athlete training status, and recovery
modalities. Howatson & van Someren (2008, Sports Med) found that muscle
damage markers (CRP, CK) from eccentric exercise peak at 24--48 hours
and resolve over 3--7 days. Ultra-distance events (50k+) can suppress
performance for 14--21+ days (Millet et al., 2011, Sports Med).
Individual recovery rates vary by 2--3x between athletes.

## 20.3 Calculation Specification

**Recovery percentage model:**

> recovery_pct(t) = 100 \* (1 - exp(-t / tau_recovery)) +
> residual_fatigue_offset

where t = hours since activity end, tau_recovery = individual time
constant.

**tau_recovery estimation:**

Initial defaults by session type:

- Easy run (\<Z2, \<90 min): tau = 12 hours

- Moderate run (Z2--Z3, \<120 min): tau = 18 hours

- Hard run (interval/tempo): tau = 24 hours

- Long run (\>2 hours): tau = 36 hours

- Ultra race (\>50k): tau = 96--168 hours

- Easy bike: tau = 8 hours

- Hard bike: tau = 16 hours

**Adaptive tau fitting:**

When subsequent session quality data exists (e.g., hard session 24 hours
after a long run), compare expected vs. actual quality to refine
tau_recovery for each session type. Over time, the system learns YOUR
recovery rate for each type of session.

**\[REVIEW\]** Recovery is also influenced by nutrition, sleep, and
non-training stress --- factors we may not have data for. Should we
include a manual "life stress" input (1--5 scale) to modify recovery
estimates? This would improve accuracy but adds user burden.

## 20.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Estimate recovery percentage at any point Recovery percentage available
  in time after each training session       on demand. Default tau values
                                            used initially.

  Classify current readiness based on       Overall recovery state
  cumulative recovery from all recent       accounts for overlapping
  sessions                                  recovery curves from multiple
                                            sessions.

  Adapt tau_recovery per session type using After 20+ sessions of a given
  session quality feedback                  type with follow-up quality
                                            data, tau updates. Stored in
                                            athlete_parameters.

  Special handling for ultra-distance races Races \>50k use extended
                                            recovery model with 14--21
                                            day timeline. Recovery
                                            suppression modeled.
  -----------------------------------------------------------------------

20.1 Initial Recovery State --- Historical Backfill Rule

For users who upload historical training data (e.g., via GarminDB or
intervals.icu import), the system MUST calculate their true initial CTL,
ATL, TSB, and recovery state from the historical data --- NOT start from
zero. Starting from zero for athletes with years of training history
produces meaningless values for weeks or months.

Implementation: when processing a historical data import, process
activities in chronological order from the earliest available date,
calculating rolling CTL/ATL/TSB forward through time. By the time the
athlete reaches \"today,\" their PMC state will reflect their actual
training history.

For new users with NO historical data: start all values at zero (CTL=0,
ATL=0, TSB=0) and allow the model to build naturally over 6-12 weeks.

20.2 Stress Input --- Optional Self-Reporting

External stress input (life stress, work stress, illness) is an optional
enhancement to the recovery timeline model. The system must function
fully without it using objective metrics only (TSB, HRV, resting HR,
sleep).

When stress self-reporting is enabled: add a daily wellness check-in
with perceived_stress (1-5 scale). When provided, apply a stress
recovery multiplier: perceived_stress 4-5 extends estimated recovery
time by 20-30%. When not provided: omit stress factor entirely --- do
not use a default value that could incorrectly inflate/deflate recovery
estimates.

20.3 Recovery Timeline Calculation

Recovery timeline (hours to full recovery) = f(TSB, HRV deviation, sleep
quality, perceived_stress if available). Default formula:
base_recovery_hours = max(0, -TSB x 0.8); add HRV_penalty_hours: if HRV
\>15% below baseline, add 12 hours; if HRV 10-15% below, add 6 hours.
Apply sleep penalty: if last sleep \<6h, add 8 hours; 6-7h, add 3 hours.

# 21. Environmental Adjustment (Heat, Humidity, Altitude)

## 21.1 Objective

Normalize performance data for environmental conditions to isolate true
fitness signal from weather noise.

## 21.2 Background & Research

Ely et al. (2007, Med Sci Sports Exerc) quantified marathon performance
degradation: pace slows \~1--2% for every 5°C above 10°C, with humidity
compounding the effect. The Wet Bulb Globe Temperature (WBGT) integrates
temperature, humidity, and radiant heat into a single index. Altitude
reduces VO2max by \~6--7% per 1000m above 1500m (Wehrlin & Hallén, 2006,
Med Sci Sports Exerc). Heart rate at a given pace increases at altitude
and in heat, confounding HR-based training intensity.

## 21.3 Calculation Specification

**Heat adjustment (running pace):**

> pace_adjustment_pct = 0.003 \* (temp_C - 15)\^2 \[for temp \> 15°C\]
>
> adjusted_pace = actual_pace / (1 + pace_adjustment_pct)

This is a simplified quadratic model. For more precision, incorporate
humidity via heat index or WBGT.

**HR adjustment for heat:**

> hr_adjusted = actual_hr - (0.5 \* (temp_C - 15)) \[for temp \> 15°C\]

Approximately 0.5 bpm per degree Celsius above 15°C (individual
variation significant).

**Altitude adjustment:**

> altitude_factor = 1 - 0.065 \* ((altitude_m - 1500) / 1000) \[for
> altitude \> 1500m\]
>
> sea_level_equivalent_pace = actual_pace \* altitude_factor

**Adaptive coefficients:**

Track EF across temperature ranges. Fit a personal heat sensitivity
curve. Some athletes degrade more than others in heat. After
accumulating runs across a range of temperatures, fit the temperature
coefficient to YOUR data.

## 21.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Fetch and store weather data              Weather data from Open-Meteo
  (temperature, humidity, wind) for every   or equivalent backfilled
  outdoor activity                          using GPS + timestamp. Stored
                                            per activity.

  Calculate temperature-adjusted pace and   Adjustments applied using
  HR for every outdoor run                  default model. Both raw and
                                            adjusted values stored.

  Apply altitude adjustment when GPS        Sea-level equivalent pace
  altitude \>1500m average                  calculated. Flagged in
                                            activity metadata.

  Fit personal heat sensitivity coefficient After 30+ outdoor runs
  from data                                 spanning \>15°C temperature
                                            range, personal coefficient
                                            fitted. Updated quarterly.
  -----------------------------------------------------------------------

**\[UNKNOWN\]** Do you train at altitude regularly? Englewood, CO is
\~5,400 ft (1,646m), which is right at the threshold where altitude
effects begin. Confirm if you want altitude adjustment applied to ALL
local runs or only at higher elevations (e.g., mountain trail runs).
Given your location, this might meaningfully affect all your outdoor
data.

21.1 Temperature Data Source --- Open-Meteo API (Mandatory)

Device temperature data is explicitly PROHIBITED as the primary
temperature source. Wrist-worn device temperature sensors are unreliable
due to: radiant heat absorption, body heat proximity, and solar exposure
variation.

Mandatory temperature source: Open-Meteo API (open-meteo.com). This API
is free, requires no API key, provides historical hourly weather data
and forecasts, supports latitude/longitude queries, and returns
temperature, humidity, wind speed, precipitation, and dew point.

Implementation: for each completed activity, fetch historical hourly
weather from Open-Meteo using the activity\'s start GPS coordinates and
start timestamp. Cache results to avoid repeated API calls for the same
location/time. Store: temperature_celsius, humidity_pct, wind_speed_kmh,
wind_direction_deg alongside each activity. Fallback (if API
unavailable): null temperature fields --- never use device temperature
as a fallback.

21.2 Seasonal and Mid-Run Temperature Changes

For activities where temperature changes significantly mid-run: if the
Open-Meteo hourly temperature delta across the activity duration exceeds
3°C, apply per-segment temperature adjustments rather than a single
activity-level adjustment. Fetch hourly temperatures for each hour of
the activity duration.

21.3 Temperature Performance Adjustment Formula

Baseline reference temperature: 15°C. For temperatures above 15°C:
performance factor = 1 - 0.02 x (T - 15) / 10. Apply to pace-based and
power-based calculations. Calibrate to individual heat sensitivity after
3+ sessions with comparable effort at different temperatures. Source:
Ely MR et al. (2007). \"Impact of weather on marathon-running
performance.\" Medicine and Science in Sports and Exercise
39(3):487-493.

21.4 Humidity Correction

Apply heat index adjustment when humidity \>60% and temperature \>20°C.
Use the Steadman (1979) heat index formula. Effective temperature =
temperature + (0.33 x humidity_partial_pressure) - 4.0.

# 22. Race Performance Prediction

## 22.1 Objective

Predict race finish times across distances using current fitness
metrics, historical performance, and course-specific factors.

## 22.2 Background & Research

Riegel (1981) proposed the endurance fatigue factor: T2 = T1 \*
(D2/D1)\^1.06, where the exponent (\~1.06) represents the rate of pace
degradation with distance. This exponent varies by individual:
speed-oriented athletes have a higher exponent (slow down more over
distance) while endurance-oriented athletes have a lower exponent. Your
profile (14:08 5k, sub-9hr 100k) gives a unique calibration opportunity
across a very wide distance range. Katz & Katz (1999) and Tanda (2011)
linked training volume and average pace to marathon performance with
high accuracy.

## 22.3 Calculation Specification

**Personal fatigue factor:**

Fit the Riegel exponent from your known performances:

> T2 = T1 \* (D2/D1)\^fatigue_factor

Using 14:08 5k and \~9hr 100k: solve for fatigue_factor. This gives a
personal power law that can predict at any intermediate or longer
distance.

**\[REVIEW\]** Your 14:08 5k is 7 years old and pre-injury. Should it be
included as a calibration point for current predictions, or should we
only use recent performances? We could weight it lower or exclude it and
use only post-comeback data. Need your guidance on this.

**CTL-adjusted prediction:**

Scale predictions by current CTL relative to CTL at the time of each
reference performance. If CTL at 100k race was 80 and current CTL is 95,
apply a proportional adjustment.

**Decoupling-based ultra prediction:**

For distances \>marathon: use your personal decoupling rate on long runs
to model pace fade. If your 3-hour training runs show 8% decoupling,
project that forward for the race duration to predict finishing pace.

**Course-specific adjustment:**

For known race courses: apply GAP analysis to the course elevation
profile to predict actual finish time accounting for climbs and
descents.

## 22.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Fit personal Riegel fatigue factor from   Fatigue factor derived with
  all available race results                R² and confidence interval.
                                            Updated when new race results
                                            added.

  Predict finish time for any target        Prediction includes point
  distance using current fitness            estimate, optimistic bound,
                                            and conservative bound.

  Incorporate decoupling rate for           Predictions for distances
  ultra-distance predictions                \>marathon use decoupling
                                            model in addition to Riegel.

  Support course-specific prediction with   Upload GPX of target course.
  elevation profile import                  Prediction adjusts for
                                            elevation using GAP model.
  -----------------------------------------------------------------------

22.1 Default vs. Personalized Prediction Models

Race performance prediction uses the Riegel formula as the default: T2 =
T1 x (D2/D1)\^1.06. Source: Riegel RS (1981). \"Athletic records and
human endurance.\" American Scientist 69(3):285-290.

Default Riegel exponent: 1.06. This exponent is personalized after the
athlete has 3+ race results across different distances stored in the
system. The personalization recalculates the exponent via least-squares
fit to the athlete\'s actual race results.

Personalization threshold: minimum 3 race results with at least 2
different race distances. Show a \"Prediction Confidence\" indicator to
the athlete: LOW (using defaults, \<3 race results), MEDIUM (1-2
personal race results available), HIGH (3+ results, personally
calibrated).

22.2 Single-Race-Cycle Athletes

For athletes with only one completed race cycle (single goal race per
year), the system must still produce predictions. Default behavior: use
Riegel with default exponent for cross-distance predictions; use
PMC-based performance trend for within-distance predictions. Document
this in the user-facing model parameters page so athletes understand
when predictions are based on defaults.

22.3 Citations Required

Riegel Formula: Riegel RS (1981). \"Athletic records and human
endurance.\" American Scientist 69(3):285-290.

Minetti GAP Model: Minetti AE et al. (2002). \"Energy cost of walking
and running at extreme uphill and downhill slopes.\" Journal of Applied
Physiology 93(3):1039-1046.

# 23. Pacing Strategy Simulation

## 23.1 Objective

Simulate and compare pacing strategies for target races using personal
fitness data and course profiles.

## 23.2 Background & Research

Abbiss & Laursen (2008, Sports Med) reviewed pacing strategies and found
that even or slightly negative pacing optimizes endurance performance
for most athletes. However, ultra-distance events often require
strategic front-loading before terrain-induced slowdowns. March et al.
(2011) showed that pacing variability in ultramarathons is much higher
than in shorter races and that managing the "death march" phase
(typically 60--75% into the race) is the primary determinant of
finishing time.

## 23.3 Calculation Specification

**Simulation inputs:**

- Target race distance and elevation profile (GPX)

- Current FTP/threshold pace

- Personal decoupling rate at target effort

- Personal GAP efficiency curve (Section 6)

- Target time or effort level (% of threshold)

**Simulation model:**

Divide course into segments (e.g., per km). For each segment: compute
GAP-adjusted pace at target effort, apply progressive decoupling based
on elapsed time, apply grade adjustment, and sum segment times for
predicted total.

> segment_time = segment_distance / (target_flat_pace \* gap_factor \*
> decoupling_factor(elapsed_time))
>
> decoupling_factor(t) = 1 - (personal_decoupling_rate \* t /
> reference_duration)

**Strategy comparison:**

Simulate 3 strategies: even effort (constant %FTP on GAP basis),
conservative start (negative split attempt), aggressive start
(front-load). Compare predicted finish times and minimum projected
energy (W'bal analog for running).

## 23.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Accept course GPX file and generate       GPX parsed. Segments created
  per-segment elevation/distance breakdown  at 1km intervals. Elevation
                                            smoothed.

  Simulate at least 3 pacing strategies     Even, conservative, and
  with predicted split times                aggressive strategies
                                            computed. Per-segment and
                                            total time output.

  Use personal decoupling rate to model     Decoupling rate from recent
  fatigue-induced pace decay                long runs (Section 5) used.
                                            Updates automatically.

  Output includes predicted time range      Range based on decoupling
  (best case to worst case)                 rate uncertainty (mean ± 1
                                            SD).
  -----------------------------------------------------------------------

23.1 Optimal Race Strategy Simulator

Build as a Phase 1 backend calculation module (no UI required in Phase
1). The simulator generates and scores multiple pacing strategies for a
target race.

Inputs: race distance, course elevation profile (GPX or manual km
splits), target finish time (optional), race date/location (for weather
fetch), athlete\'s current fitness state (CTL, threshold pace/power).

Method: Grid search over pacing strategies --- even split, negative
split (first half 2-5% slower), positive split, terrain-adjusted
(accelerate on flats/downhills, slow on climbs per GAP model). Score
each strategy using the athlete\'s personal performance model with
weather and elevation adjustments applied.

Outputs: Top 3 strategies with for each: predicted finish time,
projected energy cost curve, HR trajectory estimate, risk score
(likelihood of blow-up), recommended pace per km/mile.

Weather integration: fetch forecast via Open-Meteo API using race
location and date. Apply temperature adjustment (\~2% pace impact per
degree C above 15°C reference, using athlete\'s personal heat
sensitivity curve from Section 21). Produce scenarios: best-case
(cool/cloudy), expected (forecast conditions), worst-case (hot/humid).

23.2 Pacing Strategy Storage Schema

race_simulations table: id, user_id, race_id, created_at, strategy_type
(enum: even, negative, positive, terrain_adjusted), predicted_time,
weather_condition_used, strategy_params (JSON), confidence_score.

# 24. Taper Modeling

## 24.1 Objective

Learn the optimal pre-race taper structure from historical race cycles
to maximize race-day form.

## 24.2 Background & Research

Mujika & Padilla (2003, Med Sci Sports Exerc) meta-analyzed tapering and
found: optimal taper reduces volume 40--60% over 2--3 weeks while
maintaining intensity and frequency. TSB at race start is the best
PMC-based predictor of race performance, with optimal TSB typically +15
to +25 (though highly individual). Bosquet et al. (2007) showed that
exponential tapers outperform linear tapers for performance
optimization.

## 24.3 Calculation Specification

**Taper analysis per race cycle:**

For each historical race with ≥8 weeks prior data:

- Capture TSB at race start

- Taper length (days from peak CTL to race)

- Volume reduction percentage

- Intensity maintenance (% of peak-week intensity sessions retained)

- Race performance quality (actual vs predicted, or rank-order)

**Optimal taper learning:**

After ≥3 race cycles, correlate taper parameters with race quality.
Identify the TSB range and taper profile that produces best results for
you.

**\[REVIEW\]** How many races with sufficient pre-race data do you
currently have? This analysis needs at minimum 3 race cycles. If fewer,
defaults from literature are used until enough data accumulates.

## 24.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Capture taper metrics for each flagged    TSB at race start, taper
  race event                                length, volume reduction %,
                                            intensity %, all stored per
                                            race.

  After 3+ race cycles, identify personal   Optimal TSB range and taper
  optimal taper parameters                  structure reported with
                                            confidence level.

  For upcoming races, recommend taper       Given race date and current
  schedule based on learned parameters      CTL, output recommended daily
                                            load targets for taper
                                            period.
  -----------------------------------------------------------------------

24.1 Personalization Thresholds --- Data Requirements

Taper modeling uses population-based defaults until individual data
accumulates. Default parameters (Banister impulse-response model):
tc_fitness = 42 days (fitness time constant), tc_fatigue = 7 days
(fatigue time constant), k_fitness = 1, k_fatigue = 2. These defaults
are published in Banister et al. (1975), \"A systems model of training
for athletic performance,\" Australian Journal of Sports Medicine.

Personalization triggers for taper modeling: minimum 3 completed race
cycles (defined as: any period ending in a goal race with at least 8
weeks of tracked training beforehand). Once personalization threshold is
met, the system fits individual time constants to the athlete\'s
CTL/ATL/TSB/performance history.

24.2 Taper Target TSB Range

Default taper target TSB: +15 to +25. This range is derived from Mujika
& Padilla (2003) review of optimal taper in endurance sports. Store
athlete\'s historical TSB at their best race performances and refine the
personal target range after 2+ race events with recorded RPE or finish
time.

24.3 Data Visibility Requirement

All default model parameters must be visible to the athlete in their
profile under \"Model Parameters.\" Show: current parameter values,
whether they are population defaults or personally calibrated, and the
data threshold required to trigger personalization.

# 25. Session Quality Scoring

## 25.1 Objective

Score each training session against expected performance to detect
fatigue, illness, and super-compensation.

## 25.2 Background & Research

Training monitoring research (Halson, 2014, Sports Med) emphasizes that
the gap between prescribed and actual training output is a key indicator
of athlete state. A threshold run at 92% of expected pace signals
residual fatigue. A run at 105% of expected pace suggests a fitness
breakthrough or favorable conditions.

## 25.3 Calculation Specification

> expected_performance = f(current_CTL, session_type,
> environmental_factors, recovery_state)
>
> actual_performance = session EF, pace, or power (normalized for
> conditions)
>
> session_quality = actual_performance / expected_performance \* 100

Score interpretation: \<85% = significantly underperformed (flag for
review), 85--95% = below expected, 95--105% = on target, 105--115% =
exceeding expectations, \>115% = breakthrough.

**Expected performance model:**

Build a regression model: expected EF (or pace at given HR) as a
function of CTL, sleep score, recovery %, and temperature. This model
improves as data accumulates. Initially, use a simple CTL-to-EF linear
relationship.

## 25.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Score every session against expected      Quality score (0--150+ range)
  performance                               stored per activity. Scores
                                            \>115 or \<85 flagged.

  Expected performance model incorporates   Model uses available
  CTL, recovery state, sleep, and           predictors. Missing
  environment                               predictors excluded
                                            gracefully (wider confidence
                                            bands).

  Model accuracy improves over time via     Model R² tracked. Refit
  continuous refitting                      monthly. Minimum 30 sessions
                                            before model is considered
                                            calibrated.

  Persistent underperformance detection     3+ consecutive sessions below
                                            85% quality triggers
                                            overreaching alert.
  -----------------------------------------------------------------------

25.1 Cross-Training Contribution to Session Quality Score

Cross-training activities from the preceding 48 hours MUST be factored
into session quality scoring for subsequent sessions. Implementation:

Add cross_training_load_prior_48h as an explicit input to the session
quality model. This is calculated as: sum of TSS from all non-running
activities in the 48 hours before the session start, weighted by
cross-sport weight (cycling: 0.5, swimming: 0.3, strength: 0.4).

When session quality is impacted by prior cross-training load, the
system must explicitly attribute this in the insight: \"Session quality
score: 6.2/10. Note: Heavy cycling load (128 TSS) in the prior 48 hours
is the primary contributor to reduced freshness --- this is expected and
not a training concern.\"

25.2 Complete Session Quality Scoring Inputs

The session quality model must incorporate ALL of the following inputs:

\- Pre-session TSB (training freshness)

\- Pre-session HRV vs. 7-day baseline (if available)

\- Pre-session resting HR vs. baseline (if available)

\- cross_training_load_prior_48h (see 25.1 above)

\- Environmental conditions: temperature, humidity, altitude (from
weather API)

\- Session cardiac decoupling (aerobic decoupling %)

\- Session EF (Efficiency Factor) vs. recent mean EF at same effort
level

\- Session pace deviation from target pace (if planned session exists)

\- Post-session TSS vs. predicted TSS for the session type

25.3 Session Quality Score Output Schema

sessions_quality table: activity_id, score (0-10), freshness_input,
hrv_input, cross_training_load_input, env_adjustment, decoupling_score,
ef_score, primary_limiting_factor (enum: fatigue, environment, pacing,
cross_training, unknown), score_confidence (low/medium/high based on
data completeness).

# 26. Plateau & Breakthrough Detection

## 26.1 Objective

Automatically identify when key fitness metrics have stagnated (plateau)
or made a significant jump (breakthrough) to inform training
adjustments.

## 26.2 Background & Research

Adaptation to training follows a dose-response relationship with
diminishing returns (Fitz-Clarke et al., 1991). Plateaus occur when the
training stimulus no longer exceeds the adaptation threshold.
Breakthroughs indicate successful overload followed by recovery.
Detecting these transitions early allows proactive training adjustments
rather than retrospective frustration.

## 26.3 Calculation Specification

**Plateau detection:**

> For each key metric (EF, threshold pace, FTP, decoupling rate):
>
> plateau = true if 28-day rolling slope not significantly different
> from zero

Use a simple linear regression over the 28-day window. If p-value of
slope \> 0.1 AND the absolute slope is \<0.5% per week, classify as
plateau.

**Breakthrough detection:**

> breakthrough = true if new personal best at any key duration/distance
>
> OR if 7-day rolling metric exceeds 90-day rolling metric by \>1 SD

**Context labeling:**

For each plateau, associate with the training pattern that preceded it
(volume, intensity distribution, session types). For each breakthrough,
similarly. Over time, this enables pattern recognition: "plateaus in
threshold pace are broken by adding 1 weekly tempo run" type insights.

## 26.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Monitor key metrics for plateau (28-day   Daily check.
  stagnation) and breakthrough (new bests,  Plateau/breakthrough events
  trend jumps)                              logged with date, metric, and
                                            magnitude.

  Associate training context with each      4-week training summary
  plateau and breakthrough event            (volume, distribution,
                                            session types) stored with
                                            each event.

  Surface actionable recommendations when   Recommendation suggests 2--3
  plateau detected                          training modifications based
                                            on which metric has
                                            plateaued. Initial
                                            recommendations from rules
                                            engine; later from pattern
                                            analysis.
  -----------------------------------------------------------------------

26.1 Trend Analysis --- Required Metrics and Window Definitions

The following trends MUST be computed and stored for the Plateau and
Breakthrough Detection engine:

For each metric below, compute: 4-week slope (linear regression), 8-week
slope, 12-week slope, and current value vs. personal best. Store all
trend values with timestamps.

Performance trends: threshold pace (min/km), VO2max estimate, FTP
(cycling), race prediction times (5K, 10K, HM, M), EF (Efficiency
Factor) per sport.

Fitness trends: CTL trajectory, ATL trajectory, TSB trajectory, ACWR
4-week moving average.

Health trends: resting HR 4-week mean, HRV 4-week mean, sleep quality
score, recovery index.

Biomechanics trends (running): cadence at threshold pace, ground contact
time, vertical oscillation ratio, GCT balance (L/R asymmetry).

26.2 Plateau Detection Logic

A metric is in plateau when: 4-week slope is within ±2% of baseline AND
8-week slope is also within ±2%. Trigger a plateau insight when: plateau
persists for 6+ weeks AND current phase is Base or Build (plateaus in
Taper are expected). Insight must include: which metric is plateaued,
how long, and 2-3 targeted interventions (e.g., \"Add one threshold
session per week,\" \"Increase long run distance by 10%\").

26.3 Breakthrough Event Detection

A breakthrough event is triggered when: a key metric improves by \>5%
within a 2-week window compared to the previous 8-week mean. Log to a
breakthrough_events table: metric_name, previous_value, new_value,
improvement_pct, date, contributing_sessions (last 3 activity IDs).
Surface a positive reinforcement insight explaining which training
change likely caused it.

# 27. Injury Risk Composite Score

## 27.1 Objective

Combine multiple risk factors into a single daily injury risk score
tailored to your history and risk profile.

## 27.2 Background & Research

Gabbett et al. (2016) demonstrated that combining ACWR with other
factors (prior injury, sleep quality, training monotony) improves injury
prediction beyond any single metric. Soligard et al. (2016, Br J Sports
Med) proposed a comprehensive load monitoring framework incorporating
internal load (HR, RPE), external load (distance, TSS), and well-being
markers (sleep, mood, muscle soreness). Given your history of foot
injuries post-college, orthopedic risk monitoring is especially
critical.

## 27.3 Calculation Specification

**Composite score (0--100, higher = higher risk):**

> injury_risk = w1\*ACWR_risk + w2\*monotony_risk + w3\*sleep_risk +
> w4\*rhr_risk + w5\*volume_spike_risk + w6\*surface_risk

Component scoring (each 0--100):

- ACWR_risk: 0 if ACWR 0.8--1.3, linear increase to 100 at ACWR ≥2.0

- monotony_risk: 0 if monotony \<1.5, linear increase to 100 at monotony
  ≥3.0

- sleep_risk: 0 if sleep_score \>0.8, linear increase to 100 at
  sleep_score \<0.5

- rhr_risk: 0 if RHR within baseline, linear increase to 100 at \>7 bpm
  above baseline

- volume_spike_risk: 0 if week-over-week volume change \<20%, linear to
  100 at \>50%

- surface_risk: 0 for road, 20 for trail, higher if consecutive trail
  days

**Default weights: w1=0.30, w2=0.15, w3=0.15, w4=0.10, w5=0.20,
w6=0.10**

**Adaptive weighting:**

When injury events are logged, reweight factors using logistic
regression. If your injuries historically correlate most with volume
spikes (not ACWR), w5 increases at the expense of w1.

**\[REVIEW\]** Surface classification (road vs trail): can this be
inferred from GPS data (pace variability, elevation noise), or do you
tag activities manually? Automated classification would be preferable.

## 27.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Calculate daily composite injury risk     Score computed daily. Missing
  score from all available inputs           inputs handled by reweighting
                                            remaining components.

  Support manual injury/illness event       User can log date, type
  logging                                   (injury/illness), severity
                                            (1--5), location (e.g., left
                                            foot), and days impacted.

  Adaptive weight fitting when injury data  After ≥4 logged events over
  available                                 ≥12 months, reweight using
                                            logistic regression. Report
                                            weight changes.

  Classify daily risk as Low (\<30),        Classification stored daily.
  Moderate (30--60), High (\>60)            High-risk days generate
                                            alert.
  -----------------------------------------------------------------------

27.1 Injury Classification --- Acute vs. Overuse

The system MUST differentiate between injury types, as each has a
distinct training signature and response protocol:

Acute injuries (e.g., sprained ankle from a misstep, fall) are NOT
caused by training load accumulation. When an athlete logs an acute
injury, the system must NOT flag high ACWR as a contributing cause. The
insight should read: \"Acute injury logged. Load metrics are not
implicated. Resume training per medical guidance.\"

Overuse injuries (e.g., Achilles tendinopathy, IT band syndrome, stress
fractures) ARE load-driven. These will correlate with elevated ACWR,
high monotony, insufficient recovery, or sharp increases in
running-specific load metrics (e.g., vertical oscillation increase, GCT
asymmetry).

Illness is a separate category --- does NOT correlate with training load
peaks, but correlates with immune suppression from very high chronic
load or poor sleep.

27.2 Injury Logging Schema

Add an injury_log table to the schema: id, user_id, date, injury_type
(enum: acute, overuse, illness, other), body_location (free text),
severity (1-3), notes (free text), return_to_training_date (nullable),
is_deleted (soft delete within 7 days). Entry UX requirements: low
friction, 3 required fields only (date, type, severity). Confirmation
prompt before submission. Deletion permitted within 7 days.

27.3 Fatigue Input --- User Self-Reporting

The system uses algorithmic fatigue signals (TSB, HRV, resting HR) as
primary fatigue indicators. However, for scenarios where the athlete
experiences high subjective fatigue that metrics may not fully capture
(e.g., post-illness, accumulated mental stress, heat exposure), add a
daily wellness check-in (optional): perceived_fatigue (1-5 scale),
perceived_muscle_soreness (1-5), perceived_readiness (1-5). These inputs
combine with objective metrics in the recovery timeline and injury risk
models. The check-in is optional --- the system must function fully
without it, falling back to objective signals only. When provided,
subjective inputs take precedence in the fatigue composite score.

27.4 ACWR Injury Risk Thresholds (Gabbett, 2016 --- BJSports)

Risk zones: ACWR \<0.8 = under-training (low injury risk but performance
risk); 0.8-1.3 = optimal training zone; 1.3-1.5 = caution zone; \>1.5 =
danger zone (2x baseline injury risk). Source: Gabbett TJ. \"The
training-injury prevention paradox.\" British Journal of Sports
Medicine, 2016.

# 28. Training Phase Detection

## 28.1 Objective

Automatically classify training periods into phases (base, build, peak,
taper, recovery) and correlate phase structures with performance
outcomes.

## 28.2 Background & Research

Classical periodization (Matveyev, 1981) divides training into
macrocycles with distinct phases. Modern endurance training often
follows a modified approach: base (high volume, low intensity), build
(increasing intensity, moderate volume), peak (highest specific
intensity, reduced volume), taper (volume reduction pre-race), recovery
(active rest post-race). Automated detection enables retrospective
analysis of which phase sequences produce the best race results.

## 28.3 Calculation Specification

**Heuristic classification using rolling 14-day windows:**

- Base: volume above 75th percentile of personal history, intensity
  distribution \>80% Z1, CTL rising

- Build: volume above median, intensity distribution Z3 \>15%, CTL
  rising

- Peak: volume declining from recent maximum, intensity distribution Z3
  \>20%, CTL at or near personal high

- Taper: volume declining \>25% over 7--14 days with race upcoming
  within 21 days

- Recovery: volume \<50th percentile, CTL declining, follows race or
  high-strain period

**Pattern correlation:**

For each completed race cycle (base → build → peak → taper → race),
store the phase durations and transitions. Correlate with race quality
(Section 22). Over multiple cycles, identify the phase structure that
works best for you.

## 28.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Classify each training week into a phase  Phase label assigned weekly.
                                            Multi-week phases grouped
                                            into contiguous blocks.

  Detect race cycles and their phase        Each race flagged with
  structure                                 preceding phase sequence and
                                            durations.

  Correlate phase structures with race      After 3+ race cycles, report
  outcomes                                  which structures produced
                                            best results.
  -----------------------------------------------------------------------

28.1 Phase Label Storage --- Dual-Field Requirement

Store two separate fields for each phase assignment:

\- auto_phase_label: system-computed phase based on load metrics

\- user_phase_label: athlete-overridden label (null if not set)

Downstream calculations MUST use user_phase_label when set, and fall
back to auto_phase_label when null. This ensures athlete intent
overrides algorithmic classification.

28.2 Cross-Training Phase Load Attribution

Cycling TSS counts toward total phase load using its cross-sport weight
(default w_cycle = 0.5), but sport-specific TSS MUST be tracked
separately as run_tss, cycle_tss, swim_tss. Phase labels (Base, Build,
Peak, Taper) for running are driven by run_tss only --- not inflated by
heavy cycling weeks. A \"Running Build Phase\" requires sustained
increases in run_tss, independent of cycling volume.

28.3 Surface Classification --- Automated Requirements

Automated surface classification must combine three signals:

1\. Garmin/device activity type (road run, trail run) as a primary but
non-definitive signal

2\. GPS route analysis against OpenStreetMap --- if \>15% of the route
traverses non-paved terrain, classify as trail

3\. Elevation variance pattern --- high elevation variance over short
distances (e.g., \>10m per km on a 500m segment) strongly suggests trail

Store a surface_confidence_score (0-1) alongside the classification. The
user can override the classification in Phase 2 via the UX. Surface
classification feeds directly into:

\- GAP (Grade Adjusted Pace) interpretation

\- Running dynamics benchmarks (different norms for road vs. trail)

\- Session Quality Scoring adjustments

Schema addition: activities table gains surface_type (enum: road, trail,
treadmill, track, unknown), surface_confidence (float 0-1),
surface_source (enum: device, gps_analysis, user_override).

# 29. Automated Insight Generation

## 29.1 Objective

Transform raw metrics into actionable coaching-style insights, surfaced
proactively rather than requiring the user to interpret dashboards.

## 29.2 Background

This is the differentiating layer. All the metrics above are available
(in various forms) across TrainingPeaks, Intervals.icu, Runalyze, and
WKO5. What none of them do well is synthesize across metrics and
translate into plain-language training guidance. This section defines
the insight generation rules engine and adaptive narrative system.

## 29.3 Specification

**Insight categories:**

- Fitness trajectory: "CTL is rising at 2 points/week. At this rate,
  you'll reach target CTL of 95 by March 15."

- Risk warnings: "ACWR is 1.4 and injury risk score is 52 (moderate).
  Consider replacing tomorrow's long run with a bike ride."

- Recovery guidance: "You're estimated 75% recovered from Saturday's
  long run. Today's planned threshold session may be better moved to
  tomorrow."

- Performance trends: "EF on easy runs has improved 6% over the past 8
  weeks. Your aerobic base is developing well."

- Training pattern flags: "85% of training this month has been in
  Z1--Z2. Consider adding one VO2max session per week to maintain
  top-end fitness."

- Cross-sport insights: "Cycling volume increase over past 4 weeks
  correlates with improved running EF. The cross-training transfer
  appears effective."

- Plateau alerts: "Threshold pace has been flat for 4 weeks. Historical
  pattern suggests adding hill repeats broke similar plateaus
  previously."

- Pre-race readiness: "Race in 10 days. Current TSB: +12. Target TSB:
  +18--25. Reduce volume by 40% this week."

**Generation rules:**

Each insight has: a trigger condition (metric threshold or trend),
priority (1--5), frequency cap (e.g., max 1 per week per category), and
a template with variable slots. Insights are generated daily during the
overnight calculation batch.

**Adaptive insight quality:**

Track which insights the user engages with (views, acts on, dismisses).
Over time, suppress low-engagement insight types and prioritize
high-engagement ones.

**\[REVIEW\]** Insight engagement tracking requires UI interaction data
(clicks, dismissals). This is a UI/UX concern but the data storage and
engagement model should be designed now. Suggest a simple
liked/dismissed/ignored classification per insight.

## 29.4 Requirements

  -----------------------------------------------------------------------
  **Requirement**                           **Acceptance Criteria**
  ----------------------------------------- -----------------------------
  Generate daily insights from all          At least 1 insight generated
  calculated metrics                        per day when sufficient data
                                            exists. Insights stored with
                                            timestamp, category,
                                            priority, and content.

  Insights are plain language, specific,    Every insight references a
  and actionable                            concrete metric value, trend
                                            direction, and recommended
                                            action.

  Frequency capping prevents insight        No more than 3 insights per
  fatigue                                   day. Same category limited to
                                            1 per week unless priority 1.

  Insight engagement tracking for quality   User interaction
  improvement                               (liked/dismissed/ignored)
                                            stored per insight. After 3
                                            months, low-engagement
                                            categories deprioritized.

  All insights traceable to source metrics  Each insight links to the
  and calculations                          section(s) and metric(s) that
                                            generated it.
  -----------------------------------------------------------------------

# Appendix A: Glossary

- CTL: Chronic Training Load (fitness)

- ATL: Acute Training Load (fatigue)

- TSB: Training Stress Balance (form) = CTL - ATL

- TSS: Training Stress Score (session load quantification)

- ACWR: Acute:Chronic Workload Ratio

- EF: Efficiency Factor (output per heartbeat)

- GAP: Grade Adjusted Pace

- NGP: Normalized Graded Pace

- NP: Normalized Power

- IF: Intensity Factor

- VI: Variability Index

- FTP: Functional Threshold Power (cycling)

- rFTP: Running Functional Threshold Power

- CP: Critical Power

- W': W-prime (anaerobic work capacity above CP)

- W'bal: W-prime balance (remaining anaerobic capacity)

- rTSS: Running Training Stress Score

- HRV: Heart Rate Variability

- RMSSD: Root Mean Square of Successive Differences (HRV metric)

- lnRMSSD: Natural log of RMSSD

- SWC: Smallest Worthwhile Change

- GCT: Ground Contact Time

- MMP: Mean Maximal Power

- PMC: Performance Management Chart

- WBGT: Wet Bulb Globe Temperature

- RPE: Rate of Perceived Exertion

# Appendix B: Open Questions Summary

All \[REVIEW\] and \[UNKNOWN\] items consolidated for tracking:

- \[UNKNOWN\] Zwift data export method (manual .fit, API, or third-party
  aggregator)

- \[UNKNOWN\] Garmin watch model and confirmed field availability
  (running dynamics, HRV format)

- \[UNKNOWN\] Altitude adjustment scope given Englewood, CO base
  elevation (\~5,400 ft)

- \[REVIEW\] HRV metric format from GarminDB (RMSSD vs. proprietary
  score)

- \[REVIEW\] Extended fatigue modeling approach for post-race recovery
  (multiplier vs. extended decay)

- \[REVIEW\] GAP formulation preference (Minetti vs. Strava-style)

- \[REVIEW\] Running power data availability (Stryd/Garmin Running Power
  vs. estimation-only)

- \[REVIEW\] 14:08 5k inclusion in race prediction calibration
  (7-year-old, pre-injury)

- \[REVIEW\] Lab-tested VT1/VT2 availability for zone boundary accuracy

- \[REVIEW\] Injury/illness event logging mechanism needed

- \[REVIEW\] Manual life stress input for recovery model enhancement

- \[REVIEW\] Surface classification automation feasibility

- \[REVIEW\] Number of historical race cycles available for taper/phase
  analysis

- \[REVIEW\] Insight engagement tracking requires UI data model design
  now

- 

- 29.1 Mandatory Insight Structure

- 

- Every insight generated by the system MUST use a three-component
  structure enforced at the data model level:

- 

- insights table schema: id, user_id, category, trigger_metric,
  trigger_value, trigger_threshold, observation (what was detected),
  mechanism (the physiological reason why), recommendation (specific
  actionable next step), priority (1-5, where 1 = urgent), created_at,
  expires_at, is_dismissed, source_section.

- 

- Insight display rules: Never surface a recommendation without its
  mechanism. Example format: \"\[Observation\]: Your HRV dropped 18%
  below your 7-day baseline. \[Mechanism\]: This indicates accumulated
  neuromuscular fatigue, likely from the 3 high-intensity sessions in
  the last 5 days. \[Recommendation\]: Replace tomorrow\'s tempo run
  with a 40-minute easy aerobic session at \<70% max HR.\"

- 

- 29.2 Complete Rules Engine --- All Scenarios

- 

- The following rules MUST be implemented. Each follows: IF
  \[condition\] THEN \[recommendation\] (priority).

- 

- Training Load Rules:

- \- IF CTL drops \>5% over 2 consecutive weeks THEN \"Fitness base is
  declining. Add one aerobic session this week, targeting Z2 effort.\"
  (P2)

- \- IF CTL increases \>10% in one week THEN \"Load spike detected. Risk
  of overreaching. Cap weekly TSS increase at 8%.\" (P1)

- \- IF ATL \>1.3x CTL (ACWR \>1.3) THEN \"Acute load exceeds chronic
  base. Reduce daily training stress by 20-30% for 3-5 days.\" (P1)

- \- IF TSB \< -30 THEN \"Accumulated fatigue is high. Performance will
  be impaired. Schedule 48-72 hours of recovery.\" (P1)

- \- IF TSB \> +25 and race within 14 days THEN \"Form is peaking well.
  Maintain short activation sessions; avoid new load blocks.\" (P2)

- \- IF monotony score \>2.0 THEN \"Training variety is low --- same
  effort level repeated daily increases overuse injury risk. Add one
  session at a distinctly different intensity.\" (P2)

- \- IF strain score \>2000 THEN \"Weekly strain is critically high.
  Reduce volume by 25% next week.\" (P1)

- 

- Recovery & Readiness Rules:

- \- IF HRV 7-day mean drops \>15% from 30-day baseline THEN \"Autonomic
  stress detected. Reduce intensity today; prioritize sleep and
  nutrition.\" (P1)

- \- IF resting HR elevated \>5 bpm above 30-day mean for 3+ consecutive
  days THEN \"Persistent cardiovascular stress. Evaluate sleep quality,
  hydration, and illness.\" (P2)

- \- IF sleep total \<6h and TSB \<-10 THEN \"Insufficient recovery:
  short sleep combined with fatigue. Do not perform high-intensity
  training today.\" (P1)

- \- IF recovery timeline model predicts \>72h to full recovery THEN
  \"Full recovery estimated in \[X\] hours. Schedule your next hard
  session accordingly.\" (P2)

- 

- Aerobic Development Rules:

- \- IF cardiac decoupling \>5% on long run THEN \"Aerobic efficiency
  degraded during this session. Possible causes: heat, inadequate
  fueling, or pace too high. Keep next long run HR capped at Z2
  ceiling.\" (P2)

- \- IF EF trend improving over 4+ weeks THEN \"Aerobic efficiency is
  trending upward --- a positive training adaptation signal. Continue
  current approach.\" (P3)

- \- IF EF declines \>8% over 3 weeks THEN \"Aerobic efficiency is
  declining. Check: sleep quality, cumulative fatigue, illness,
  overtraining.\" (P2)

- 

- Performance Rules:

- \- IF Riegel-predicted race time improves \>2% from last prediction
  THEN \"Your predicted \[race distance\] time improved to \[X:XX\].
  This reflects real fitness gains.\" (P3)

- \- IF CP diverges from FTP by \>10% THEN \"Cycling power profile
  discrepancy detected. Consider a structured FTP test.\" (P2)

- \- IF running pace at threshold HR improves \>3% over 4 weeks THEN
  \"Threshold running economy is improving. Pace at the same heart rate
  is now faster.\" (P3)

- 

- Injury Risk Rules:

- \- IF ACWR \>1.5 THEN \"Acute:Chronic ratio is in the danger zone
  (\>1.5). Reduce acute load immediately to lower injury risk.\" (P1)

- \- IF ground contact time balance asymmetry \>3% for 3+ sessions THEN
  \"Persistent running gait asymmetry detected. Consider gait analysis
  or physio consult.\" (P2)

- \- IF injury risk composite score \>70 THEN \"Composite injury risk is
  elevated. Prioritize mobility, reduce high-impact volume.\" (P1)

- 

- 29.3 Insight Category Requirements

- 

- Training Insights: MUST always include the physiological mechanism
  behind the recommendation (the \"why\"). Never surface a generic
  recommendation like \"train more\" without explaining the specific
  metric that triggered it and why it matters physiologically.

- 

- Recovery Insights: Must correlate at least two data sources (e.g.,
  HRV + sleep, or resting HR + TSB) before triggering a recommendation.
  Single-metric recovery insights are low confidence and must be labeled
  as such.

- 

- Performance Insights: Must include the athlete\'s historical context
  (e.g., \"compared to your last 30 days\" or \"compared to your best
  result\"). Never surface performance insights in isolation.

- 

- Predictive Insights (race prediction, taper, pacing): Must specify
  confidence level based on data volume. Require minimum 8 weeks of
  relevant activity history for high-confidence predictions.

- 

- 29.4 Insight Data Completeness Requirements

- 

- Per-section insight specs must be added to every calculation section
  in this PRD. Each section must specify: (a) trigger condition with
  exact metric and threshold, (b) minimum data requirement to trigger
  the insight, (c) the 3-part insight content (observation, mechanism,
  recommendation), and (d) priority level.
