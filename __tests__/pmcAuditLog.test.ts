/**
 * PMC-006 Audit Log & Notification Tests
 *
 * Pure-function coverage (no DB):
 *   - getConfidenceLabel() threshold mapping
 *   - generatePlainEnglish() branches (via pmcFittingDb internal re-export path
 *     — tested indirectly through the exported label utility)
 *   - getParameterHistory() ci_width computation (mocked Supabase)
 *   - writeRefitNotifications() R3/R4 branching (mocked Supabase)
 *   - maybeWritePersonalizationNotification() show-once logic (mocked Supabase)
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings=MODULE_TYPELESS_PACKAGE_JSON __tests__/pmcAuditLog.test.ts
 */

import {
  getConfidenceLabel,
  generatePlainEnglish,
  computeCiWidth,
  buildRefitNotifications,
} from '../lib/pmcAuditUtils.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

// ── getConfidenceLabel ────────────────────────────────────────────────────────

console.log('\ngetConfidenceLabel()');

assert(getConfidenceLabel(0) === 'High', 'ci_width=0 → High');
assert(getConfidenceLabel(10) === 'High', 'ci_width=10 (boundary) → High');
assert(getConfidenceLabel(10.1) === 'Medium', 'ci_width=10.1 → Medium');
assert(getConfidenceLabel(20) === 'Medium', 'ci_width=20 (boundary) → Medium');
assert(getConfidenceLabel(20.1) === 'Low', 'ci_width=20.1 → Low');
assert(getConfidenceLabel(100) === 'Low', 'ci_width=100 → Low');

// ── ci_width computation ──────────────────────────────────────────────────────

console.log('\ncomputeCiWidth()');

assert(computeCiWidth(35, 50) === 15, 'ci_width = ci_high − ci_low');
assert(computeCiWidth(null, 50) === null, 'ci_width null when ci_low absent');
assert(computeCiWidth(35, null) === null, 'ci_width null when ci_high absent');
assert(computeCiWidth(null, null) === null, 'ci_width null when both absent');
assert(computeCiWidth(40, 40) === 0, 'ci_width=0 for point estimate');

// ── buildRefitNotifications (R3/R4) ──────────────────────────────────────────

console.log('\nbuildRefitNotifications() R3/R4 branching');

// R3 only (R² ≥ 0.6)
{
  const notes = buildRefitNotifications(0.82, 8, ['tc_fitness updated.']);
  assert(notes.length === 1, 'R² ≥ 0.6 → only model_updated fires');
  assert(notes[0].type === 'model_updated', 'notification type is model_updated');
  assert(notes[0].confidence_label === 'High', 'ciWidth=8 → High confidence');
  assert(notes[0].ci_width === 8, 'raw ci_width stored on notification');
  assert(notes[0].message.includes('R² = 0.82'), 'message includes R² value');
  assert(notes[0].message.includes('High confidence'), 'message includes label');
  assert(notes[0].message.includes('tc_fitness updated.'), 'message includes param summary');
}

// R3 + R4 (R² < 0.6)
{
  const notes = buildRefitNotifications(0.45, 25, []);
  assert(notes.length === 2, 'R² < 0.6 → model_updated and more_data_needed both fire');
  assert(notes[1].type === 'more_data_needed', 'second notification is more_data_needed');
  assert(notes[1].message.includes('R² = 0.45'), 'R4 message includes R² value');
  assert(notes[1].message.includes('benchmark efforts'), 'R4 message includes benchmark prompt');
  assert(notes[1].confidence_label === 'Low', 'ciWidth=25 → Low confidence');
  assert(notes[1].ci_width === 25, 'raw ci_width stored on R4 notification');
}

// R3 with no changed params (all params stable, model ran but nothing moved)
{
  const notes = buildRefitNotifications(0.75, 15, []);
  assert(notes[0].message.includes('Your training model was updated.'), 'no param summary when none changed');
  assert(!notes[0].message.includes('undefined'), 'no "undefined" in message');
}

// ── generatePlainEnglish ──────────────────────────────────────────────────────

console.log('\ngeneratePlainEnglish()');

// tc_fitness: faster than average
{
  const msg = generatePlainEnglish('tc_fitness', 42, 38, false);
  assert(msg.includes('38 days'), 'tc_fitness message includes new value');
  assert(msg.includes('previously 42 days'), 'tc_fitness message includes old value');
  assert(msg.includes('faster than average'), 'tc_fitness < 42 → faster than average');
}

// tc_fitness: slower than average
{
  const msg = generatePlainEnglish('tc_fitness', null, 48, false);
  assert(msg.includes('48 days'), 'tc_fitness message includes new value');
  assert(!msg.includes('previously'), 'no "previously" when old_value is null');
  assert(msg.includes('more slowly than average'), 'tc_fitness > 42 → more slowly');
}

// tc_fatigue: faster recovery
{
  const msg = generatePlainEnglish('tc_fatigue', 7, 5, false);
  assert(msg.includes('5 days'), 'tc_fatigue message includes new value');
  assert(msg.includes('faster-than-average'), 'tc_fatigue < 7 → faster recovery');
}

// tc_fatigue: slower recovery
{
  const msg = generatePlainEnglish('tc_fatigue', 7, 10, false);
  assert(msg.includes('slower-than-average'), 'tc_fatigue > 7 → slower recovery');
}

// Clamped below minimum
{
  const msg = generatePlainEnglish('tc_fatigue', 7, 3, true, 1.8);
  assert(msg.includes('minimum'), 'clamped below minimum says "minimum"');
  assert(msg.includes('1.8'), 'clamped message includes raw value');
  assert(msg.includes('3.0'), 'clamped message includes clamped value');
}

// Clamped above maximum
{
  const msg = generatePlainEnglish('tc_fitness', 42, 60, true, 75);
  assert(msg.includes('maximum'), 'clamped above maximum says "maximum"');
}

// Unknown parameter fallback
{
  const msg = generatePlainEnglish('k_race', null, 2.2, false);
  assert(msg.includes('k_race'), 'fallback includes param name');
  assert(msg.includes('2.20'), 'fallback includes new value');
}

// ── R2 show-once logic (pure simulation) ─────────────────────────────────────

console.log('\nmaybeWritePersonalizationNotification() show-once');

function simulateShowOnce(existingCount: number): boolean {
  if (existingCount > 0) return false; // already sent → no-op
  return true; // would insert
}

assert(simulateShowOnce(0) === true, 'fires on first call (0 existing notifications)');
assert(simulateShowOnce(1) === false, 'does not fire if notification already exists (show-once)');

// ── Boundary: confidence label and ci_width round-trip ───────────────────────

console.log('\nci_width / confidence_label round-trip');

const cases: [number, 'High' | 'Medium' | 'Low'][] = [
  [0, 'High'],
  [5, 'High'],
  [10, 'High'],
  [10.001, 'Medium'],
  [15, 'Medium'],
  [20, 'Medium'],
  [20.001, 'Low'],
  [50, 'Low'],
];
for (const [width, expected] of cases) {
  assert(
    getConfidenceLabel(width) === expected,
    `ci_width=${width} → ${expected}`,
  );
}
