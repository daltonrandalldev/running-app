/**
 * Manual trigger for quarterly heat sensitivity coefficient fitting.
 *
 * Run with: npx ts-node scripts/fitHeatK.ts
 *
 * This script calls fitAndStoreHeatSensitivityK() and prints the result.
 * It requires at least 30 qualifying outdoor runs spanning > 15°C to produce
 * a fitted coefficient. Until then, the default k = 0.02 is used automatically.
 */
import { fitAndStoreHeatSensitivityK } from '../lib/weatherRecalc';

async function main() {
  console.log('[fitHeatK] Starting personal coefficient fitting...');
  const result = await fitAndStoreHeatSensitivityK();

  if (!result.ok) {
    console.error('[fitHeatK] Fitting failed:', result.error);
    process.exit(1);
  }

  if (result.k === undefined) {
    console.log('[fitHeatK] Insufficient data (< 30 qualifying runs or < 15°C range). Default k = 0.02 remains in effect.');
  } else {
    console.log(`[fitHeatK] Fitted k = ${result.k.toFixed(4)}. Stored in athlete_parameters.`);
    console.log('[fitHeatK] Next recalculateEF() and backfillEFWithTempAdjustment() runs will use the new coefficient.');
  }
}

main().catch((err) => {
  console.error('[fitHeatK] Unexpected error:', err);
  process.exit(1);
});
