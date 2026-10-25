import type {
  ClimateControlStatus,
  CoverStatus,
  EventEmitterStatus,
  HvacMode,
  LockControlStatus,
  MotionStatus,
  SwitchStatus,
} from '@camstack/types'
import type { HmChannel } from 'nodehomematic'

/**
 * Shared cold-start defaults + the key-channel press vocabulary helpers,
 * extracted from the (legacy) flat `homematic-device.ts` so the Container +
 * accessory-child classes reuse the SAME seeds and decoders without
 * duplicating them. Pure: no `BaseDevice` / facade dependency.
 */

/**
 * Cold-start defaults so reads never miss a slice before the first push.
 * `lastChangedAt: 0` marks each as a PLACEHOLDER — the value is a guess, and
 * consumers read it as unknown. A replayed CCU value is stamped
 * `HM_SEEDED_CHANGED_AT` instead (`hm-change-stamp.ts`).
 */
export const COLD_SWITCH: SwitchStatus = { on: false, lastChangedAt: 0 }
export const COLD_COVER: CoverStatus = {
  state: 'closed',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}
export const COLD_LOCK: LockControlStatus = { state: 'unlocked', lastChangedAt: 0 }
export const COLD_MOTION: MotionStatus = {
  detected: false,
  lastDetectedAt: null,
  autoClearAfterMs: null,
}

/**
 * The motion seed a constructor writes OVER the slice hydrated from the
 * persisted runtime state. The level is a placeholder (`false`) until the
 * CCU says otherwise, but a stored rise is a fact: `lastDetectedAt: null`
 * means "never detected" (`motion.cap.ts`), and a restart must not turn
 * "fired an hour ago" into that.
 */
export function coldMotionKeepingRise(stored: Readonly<MotionStatus> | undefined): MotionStatus {
  const rise = stored?.lastDetectedAt
  return {
    ...COLD_MOTION,
    lastDetectedAt: typeof rise === 'number' && Number.isFinite(rise) && rise > 0 ? rise : null,
  }
}

export const CLIMATE_MODES: readonly HvacMode[] = ['off', 'heat', 'auto']
export const COLD_CLIMATE: ClimateControlStatus = {
  mode: 'auto',
  availableModes: [...CLIMATE_MODES],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: ['boost'],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  lastFetchedAt: 0,
}

/**
 * The standard HmIP key-channel datapoint vocabulary, used VERBATIM (NO
 * normalization) as the `event-emitter` event types — the native uppercase
 * tokens a `KEY_TRANSCEIVER` / `KEY_TRANSMITTER` / `VIRTUAL_KEY` / `KEY`
 * channel emits on the facade `valueChanged` stream.
 */
export const HM_KEY_PRESS_DATAPOINTS: readonly string[] = [
  'PRESS_SHORT',
  'PRESS_LONG',
  'PRESS_LONG_START',
  'PRESS_LONG_RELEASE',
  'PRESS_CONT',
] as const

/** Set form for O(1) fire-detection membership tests. */
export const HM_KEY_PRESS_SET: ReadonlySet<string> = new Set(HM_KEY_PRESS_DATAPOINTS)

/** Cold-start event-emitter slice; vocabulary supplied per-device. */
export function coldEventEmitter(eventTypes: readonly string[]): EventEmitterStatus {
  return { eventTypes: [...eventTypes], lastEvent: null, eventCountSinceStart: 0 }
}

/**
 * Collect the union of native `PRESS_*` datapoints a device's key channels
 * support, VERBATIM. Falls back to the standard HmIP key vocabulary when no
 * datapoints were enumerated, so the cap always advertises a non-empty set.
 */
export function keyEventVocabulary(keyChannels: readonly HmChannel[]): readonly string[] {
  const found = new Set<string>()
  for (const channel of keyChannels) {
    for (const dp of channel.dataPoints ?? []) {
      if (HM_KEY_PRESS_SET.has(dp.parameter)) found.add(dp.parameter)
    }
  }
  if (found.size === 0) return HM_KEY_PRESS_DATAPOINTS
  return HM_KEY_PRESS_DATAPOINTS.filter((dp) => found.has(dp))
}

/**
 * The CamStack cap names that are ACTUATORS — driven by the library's typed
 * custom entities (correct channel), NOT by the raw mapped channels. The
 * raw-channel sensor/event loop skips these so they are not double-registered.
 */
export const ACTUATOR_CAP_NAMES: ReadonlySet<string> = new Set([
  'switch',
  'cover',
  'light',
  'lock-control',
  'climate-control',
])

/** Parse the numeric channel index suffix (`:N`) from a channel address.
 *  Null when absent. Kept as a string for the event payload, mirroring the
 *  CCU's `device:index` addressing. */
export function channelIndexFromAddress(channelAddress: string): string | null {
  const idx = channelAddress.lastIndexOf(':')
  if (idx === -1) return null
  const suffix = channelAddress.slice(idx + 1)
  return suffix.length > 0 ? suffix : null
}
