/**
 * The adaptive ladder's tuning, in one place so the specs test the numbers
 * that SHIP (a spec with its own copy of a threshold proves nothing about
 * production). Each stall/climb number is justified where its field is
 * declared: `stall-tracker.ts`, `delivery-meter.ts`, `adaptive-controller.ts`.
 */
import type { AdaptiveControllerConfig } from './adaptive-controller.js'
import type { DeliveryMeterConfig } from './delivery-meter.js'

/** How often the adaptive controller re-evaluates the ladder (ms). */
export const ADAPTIVE_TICK_MS = 2_000

/** Ladder tuning shared by every adaptive session. */
export const ADAPTIVE_CONFIG: AdaptiveControllerConfig = {
  analyzeWindowMs: 15_000,
  minFailPercent: 0.05,
  waitAfterResetMs: 8_000,
  upgradeHealthyMs: 4_000,
  upgradeHealthyGrowthFactor: 3,
  maxProgressiveUpgradeHealthyMs: 30_000,
  minTimeBetweenChangesMs: 4_000,
  maxUpgradeBackoffMs: 900_000,
  // Stall and climb safety — judged on DELIVERY (bytes received ÷ bytes sent
  // over one GOP), never on an absolute kbps floor (D635).
  stallDeliveryRatio: 0.25,
  recoverDeliveryRatio: 0.5,
  freezeDeliveryRatio: 0.1,
  freezeMinSentKbps: 16,
  climbDeliveryRatio: 0.9,
  stallConfirmMs: 6_000,
  waitAfterChangeMs: 8_000,
  climbCapacityMargin: 1.2,
  // Try-climb without capacity evidence, and its fast revert (D635 round 2):
  // justified where each field is declared (`adaptive-controller.ts`,
  // `try-climb.ts`).
  tryClimbDeliveryRatio: 0.95,
  tryClimbMaxLossRatio: 0.01,
  tryBackoffBaseMs: 30_000,
  tryBackoffMaxMs: 600_000,
  trialMs: 20_000,
  trialMaxMs: 40_000,
  trialRevertRatio: 0.9,
  trialRevertConsecutive: 2,
}

/** How the delivery window is built from the client's reports. */
export const ADAPTIVE_DELIVERY_CONFIG: DeliveryMeterConfig = {
  clientSampleSpanMs: 2_000,
  minWindowMs: 2_000,
  maxWindowMs: 16_000,
  maxClientSampleAgeMs: 10_000,
  historySpanMs: 32_000,
}
