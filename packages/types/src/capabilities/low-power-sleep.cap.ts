import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'
import { readingMeta } from '../units/quantity.js'

/**
 * low-power-sleep — a device that goes into low-power sleep and must be WOKEN
 * before it streams (#459, Q2). A battery camera (Reolink Argus, a robot's
 * on-board camera) is one; a battery SENSOR is not: it reports charge on the
 * `battery` cap and never sleeps. The two meanings used to share
 * `DeviceFeature.BatteryOperated`; this cap is the one that answers "sleeps",
 * and `DeviceFeature.Sleeps` is derived from it being bound with
 * `wakeUp` implemented.
 *
 * The state is the sleep inputs (`deriveBatteryPresence`): whether the device
 * is asleep, and the last time it PROVED it was reachable. Read from this slice
 * by the stream broker (`readBatterySleepFacts`), the recorder
 * (`recordingWakeDeps`) and the snapshot builtin. The broker's per-device
 * mirror is still also fed by `BatteryOnStatusChanged` events.
 */
export const LowPowerSleepStatusSchema = z.object({
  /**
   * True while the firmware is in low-power mode. A provider MUST avoid polling
   * during sleep — a read wakes the device and drains charge.
   */
  sleeping: z.boolean().meta({ label: 'Sleeping' }),
  /**
   * Ms epoch of the last time the device proved it was reachable, from
   * PASSIVE signals only (a completed round-trip, an observed wake, a push).
   * Absent = never since this slice was born. The only input that separates
   * "asleep" from "gone".
   */
  lastContactAt: z.number().optional(),
  /** Ms epoch of the last observation. */
  lastUpdated: z.number().meta(readingMeta('none')),
})

export type LowPowerSleepStatus = z.infer<typeof LowPowerSleepStatusSchema>

export const lowPowerSleepCapability = {
  name: 'low-power-sleep',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /**
     * Explicitly wake the device from low-power sleep ahead of a streaming
     * session start. Consumers that initiate a stream against a sleeping
     * camera (wake-on-play, the recorder, HomeKit, Alexa, snapshot wrappers)
     * call this with a short timeout before establishing the media pipeline —
     * the broker's own passive wake-on-dial works but adds 5–7 seconds to
     * first-frame. Pre-waking compresses that gap.
     *
     * Returns `awoke: true` when the firmware acknowledged the wake before
     * `timeoutMs`, `awoke: false` when it timed out; the caller should still
     * attempt the stream — the passive broker wake remains as fallback.
     */
    wakeUp: method(
      z.object({
        deviceId: z.number(),
        /** Bound on the wait. Sensible range 3000–10000ms. */
        timeoutMs: z.number().int().min(500).max(30_000).default(8_000),
      }),
      z.object({
        awoke: z.boolean(),
        durationMs: z.number(),
      }),
      {
        kind: 'mutation',
        notOperatorFacing:
          'a stream consumer wakes a sleeping camera to watch it; an automation that wants footage asks for the footage',
      },
    ),
  },
  status: {
    schema: LowPowerSleepStatusSchema,
    kind: 'push',
    empty: { sleeping: false, lastUpdated: 0 },
  },
  runtimeState: LowPowerSleepStatusSchema,
  /**
   * Runtime-state durability: **restored** — a sleeping camera may not report
   * for hours; the restored sleep inputs are the only thing the sleep gate and
   * the presence derivation have (the same argument as `battery`).
   */
  durability: 'restored',
  /** History (D850): the awake / asleep timeline of a battery camera. */
  history: { fields: { sleeping: { kind: 'boolean' } } },
  volatileStateFields: ['lastUpdated'],
  // The sleep state stays phrased through the battery vocabulary (asleep / woke
  // up) until its writer moves here; `wakeUp` carries its own excuse.
  vocabulary: { noun: t('Low-power sleep', 'Sospensione a basso consumo'), order: 5245 },
} as const satisfies CapabilityDefinition

export type ILowPowerSleepProvider = InferProvider<typeof lowPowerSleepCapability>
