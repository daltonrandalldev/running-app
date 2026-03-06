/**
 * PMC-006: Pure audit-log utilities — no DB dependencies.
 *
 * Kept separate from pmcFittingDb.ts so tests can import these functions
 * without pulling in the Supabase client.
 */

// ── Confidence label ──────────────────────────────────────────────────────────

/**
 * Map a raw tc_fitness CI width (days) to a display confidence label.
 *
 * Thresholds (adjustable — raw ci_width is stored alongside the label so the
 * mapping can be updated without a schema change):
 *   High   ≤ 10 days
 *   Medium ≤ 20 days
 *   Low    > 20 days
 */
export function getConfidenceLabel(ciWidth: number): 'High' | 'Medium' | 'Low' {
  if (ciWidth <= 10) return 'High';
  if (ciWidth <= 20) return 'Medium';
  return 'Low';
}

// ── Plain-English interpretation templates ────────────────────────────────────

/**
 * Generate a human-readable explanation for a parameter change.
 * Used to populate parameter_change_log.plain_english (PMC-006 R1).
 */
export function generatePlainEnglish(
  paramName: string,
  oldValue: number | null,
  newValue: number,
  wasClamped: boolean,
  rawValue?: number,
): string {
  const prev = oldValue != null ? ` (previously ${Math.round(oldValue)} days)` : '';

  if (wasClamped && rawValue != null) {
    const bound = rawValue < newValue ? 'minimum' : 'maximum';
    return (
      `Your fitted ${paramName === 'tc_fitness' ? 'fitness decay' : 'fatigue decay'} ` +
      `(${rawValue.toFixed(1)} days) was outside the physiological ${bound}. ` +
      `Using ${newValue.toFixed(1)} days as the ${bound} bound.`
    );
  }

  if (paramName === 'tc_fitness') {
    const rel =
      newValue > 42
        ? 'more slowly than average'
        : newValue < 42
          ? 'faster than average'
          : 'at the typical rate';
    return (
      `Your aerobic fitness builds over approximately ${Math.round(newValue)} days${prev}. ` +
      `This means your body adapts ${rel} to training stimulus.`
    );
  }

  if (paramName === 'tc_fatigue') {
    const rel =
      newValue < 7
        ? 'faster-than-average acute fatigue recovery'
        : newValue > 7
          ? 'slower-than-average acute fatigue recovery'
          : 'typical acute fatigue recovery';
    return (
      `You recover from hard training in about ${Math.round(newValue)} days${prev}. ` +
      `This suggests you have ${rel}.`
    );
  }

  return `${paramName} updated to ${newValue.toFixed(2)}${prev}.`;
}

// ── ci_width computation ──────────────────────────────────────────────────────

/**
 * Compute CI width from stored bounds. Returns null when either bound is absent
 * (e.g. non-tc parameters that don't have bootstrap CI).
 */
export function computeCiWidth(
  ciLow: number | null,
  ciHigh: number | null,
): number | null {
  return ciLow != null && ciHigh != null ? ciHigh - ciLow : null;
}

// ── Refit notification message builders ──────────────────────────────────────

export interface RefitNotification {
  type: 'model_updated' | 'more_data_needed';
  message: string;
  confidence_label: 'High' | 'Medium' | 'Low';
  /** Raw tc_fitness CI width stored alongside label for future threshold changes. */
  ci_width: number;
}

/**
 * Build the set of notifications to write after a successful refit (R3/R4).
 * Pure function — actual DB writes happen in pmcFittingDb.ts.
 */
export function buildRefitNotifications(
  r2: number,
  ciWidth: number,
  changedParamMessages: string[],
): RefitNotification[] {
  const confidenceLabel = getConfidenceLabel(ciWidth);
  const paramSummary =
    changedParamMessages.length > 0
      ? ' ' + changedParamMessages.join(' ')
      : '';

  const notifications: RefitNotification[] = [
    {
      type: 'model_updated',
      message:
        `Your training model was updated.${paramSummary} ` +
        `Model fit: R² = ${r2.toFixed(2)} (${confidenceLabel} confidence).`,
      confidence_label: confidenceLabel,
      ci_width: ciWidth,
    },
  ];

  if (r2 < 0.6) {
    notifications.push({
      type: 'more_data_needed',
      message:
        `Your model was updated but has low confidence (R² = ${r2.toFixed(2)}). ` +
        'Add more benchmark efforts for a better fit.',
      confidence_label: confidenceLabel,
      ci_width: ciWidth,
    });
  }

  return notifications;
}
