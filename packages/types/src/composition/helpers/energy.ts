/**
 * Watts integrated over time, in kWh (D944).
 *
 * 1 kWh = 1 000 W × 3 600 000 ms. The history energy series uses the same
 * factor (`tw_sum / 3.6e9`), so a chart and an integral helper cannot diverge.
 */
export const KWH_PER_WATT_MS: number = 1 / 3_600_000_000

export function wattMillisecondsToKwh(wattMilliseconds: number): number {
  return wattMilliseconds * KWH_PER_WATT_MS
}
