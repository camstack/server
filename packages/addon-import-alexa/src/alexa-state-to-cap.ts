/**
 * Pure decoders translating a single polled Alexa property value (as stored on
 * the {@link AlexaAccountResolver} by interface + property) into the CamStack cap
 * status field it drives. The inverse of the exporter's report-state mapping.
 *
 * Each function takes the raw `unknown` value (provider-specific) and returns a
 * narrowed primitive or `null` when the value is absent / unrecognised, so the
 * device class can fall back to its cold-start/runtime default. No I/O, no
 * alexa-remote2 import — unit-testable with fixtures.
 *
 * Alexa property reference (smart-home Phoenix state):
 *   - Alexa.PowerController.powerState        → 'ON' | 'OFF'
 *   - Alexa.BrightnessController.brightness    → 0..100
 *   - Alexa.LockController.lockState           → 'LOCKED' | 'UNLOCKED' | 'JAMMED'
 *   - Alexa.ContactSensor.detectionState       → 'DETECTED' | 'NOT_DETECTED'
 *   - Alexa.MotionSensor.detectionState        → 'DETECTED' | 'NOT_DETECTED'
 *   - Alexa.TemperatureSensor.temperature      → { value:number, scale:'CELSIUS'|'FAHRENHEIT' } | number
 *   - Alexa.PercentageController.percentage     → 0..100
 *   - humidity                                  → number (percent)
 */

import type { MotionStatus } from '@camstack/types'

/** Decode an Alexa `powerState` to a boolean on-state, or null. */
export function decodePowerState(value: unknown): boolean | null {
  if (value === 'ON') return true
  if (value === 'OFF') return false
  return null
}

/** Decode an Alexa 0..100 brightness / percentage to a clamped int, or null. */
export function decodePercentage(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.max(0, Math.min(100, n)))
}

/** Decode an Alexa `lockState` to the cap's lock state, or null. */
export function decodeLockState(value: unknown): 'locked' | 'unlocked' | null {
  if (value === 'LOCKED') return 'locked'
  if (value === 'UNLOCKED') return 'unlocked'
  return null
}

/** Decode an Alexa `detectionState` to a boolean detected-state, or null. */
export function decodeDetectionState(value: unknown): boolean | null {
  if (value === 'DETECTED') return true
  if (value === 'NOT_DETECTED') return false
  return null
}

/**
 * Cached / cold motion slice shape used by {@link mergeAlexaMotionStatus} —
 * the `motion` cap's own runtime-state shape, never a second declaration.
 */
export type AlexaMotionStatus = MotionStatus

/**
 * Merge a live Alexa MotionSensor detection into the cached motion slice.
 *
 * `lastDetectedAt` is the LAST RISE and survives the fall (`motion.cap.ts`):
 * `null` means never detected. A clear patches the level only. A rise (or the
 * first observation of `true` with no stored stamp) stamps `nowMs`. A
 * sustained `true` across polls keeps the existing stamp — re-stamping every
 * poll would make "detected a minute ago" read as "just now".
 */
export function mergeAlexaMotionStatus(
  cached: AlexaMotionStatus,
  live: boolean | null,
  nowMs: number,
): AlexaMotionStatus {
  if (live === null) return cached
  if (live) {
    const rising = !cached.detected
    const stampMissing =
      typeof cached.lastDetectedAt !== 'number' ||
      !Number.isFinite(cached.lastDetectedAt) ||
      cached.lastDetectedAt <= 0
    return {
      detected: true,
      lastDetectedAt: rising || stampMissing ? nowMs : cached.lastDetectedAt,
      autoClearAfterMs: null,
    }
  }
  const prior =
    typeof cached.lastDetectedAt === 'number' &&
    Number.isFinite(cached.lastDetectedAt) &&
    cached.lastDetectedAt > 0
      ? cached.lastDetectedAt
      : null
  return { detected: false, lastDetectedAt: prior, autoClearAfterMs: null }
}

/** True when `v` is a non-null, non-array object (cast-free guard). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Decode an Alexa temperature property to °C, or null. Accepts a bare number
 * (assumed °C) or the `{ value, scale }` envelope, converting °F → °C.
 */
export function decodeTemperatureCelsius(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!isRecord(value)) return null
  const raw = value['value']
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  const scale = value['scale']
  if (scale === 'FAHRENHEIT') return Math.round(((n - 32) * 5) / 9)
  return n
}

/** Decode an Alexa humidity property to a percent, or null. */
export function decodeHumidityPercent(value: unknown): number | null {
  const direct = decodePercentage(value)
  if (direct !== null) return direct
  if (!isRecord(value)) return null
  return decodePercentage(value['value'])
}
