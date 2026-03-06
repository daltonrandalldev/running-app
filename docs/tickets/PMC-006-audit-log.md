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
