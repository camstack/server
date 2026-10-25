import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * A camera's own "record me NOW" LEVEL — a signal the device raises while
 * something it knows about is happening (a robot vacuum cleaning, a machine
 * running, a gate open) and lowers when it stops.
 *
 * It is a level, not an edge. The sensor triggers the recorder already listens
 * to (`SOURCE_CAP_ACTIVE_FIELD`) fire on a rising edge and record for a fixed
 * post-buffer; a cleaning lasts forty minutes, and forty minutes of "this is
 * still happening" cannot be expressed as an edge plus a post-buffer without
 * either re-triggering on a timer (polling — D224 forbids the consumer keeping
 * the fact fresh) or picking a post-buffer long enough to cover every job,
 * which records the dock for that long after every short one. So the recorder
 * reads the LEVEL: it records for as long as `active` is true, plus the band's
 * own post-buffer once it falls.
 *
 * Who owns the fact: the PROVIDER of the device, which already reads the state
 * the signal is derived from (the vacuum's lifecycle state, for Dreame). It
 * writes this slice on every change; consumers subscribe to the kernel's
 * `DeviceStateChanged` for it and read it back through
 * `deviceState.getCapSlice` to reconcile — never a second copy, never a poll
 * against the device (D224, D8/D11).
 *
 * Deliberately NOT a `binary` sensor on the camera: a binary sensor is exported
 * to Home Assistant, HomeKit and the sensor picker as a thing an operator can
 * bind, and "the camera wants to record" is not a room sensor. It is a fact
 * about the camera, on the camera.
 */
export const RecordingSignalStatusSchema = z.object({
  /** True while the device asks to be recorded. */
  active: z.boolean(),
  /**
   * Why, in the provider's own vocabulary (a vacuum's `cleaning` / `docked`,
   * …). Free text for the log line and the UI badge; the recorder never
   * branches on it.
   */
  reason: z.string(),
  /** Ms epoch of the last `active` transition. 0 if never observed. */
  lastChangedAt: z.number(),
})
export type RecordingSignalStatus = z.infer<typeof RecordingSignalStatusSchema>

/** The runtime-state slice: the status plus the clock every slice carries. */
export const RecordingSignalRuntimeStateSchema = RecordingSignalStatusSchema.extend({
  lastFetchedAt: z.number(),
})
export type RecordingSignalRuntimeState = z.infer<typeof RecordingSignalRuntimeStateSchema>

export const recordingSignalCapability = {
  name: 'recording-signal',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /** The current level, straight from the slice the provider keeps fresh. */
    getStatus: method(z.object({ deviceId: z.number() }), RecordingSignalStatusSchema),
  },
  status: {
    schema: RecordingSignalStatusSchema,
    kind: 'push',
    empty: { active: false, reason: 'unknown', lastChangedAt: 0 },
  },
  runtimeState: RecordingSignalRuntimeStateSchema,
  /**
   * Runtime-state durability: **session** — a restored `active: true` from
   * before a restart is exactly the stale level the recorder's reconcile bound
   * exists to end, and the provider re-derives the true level on activation
   * anyway. Nothing is lost by forgetting it; a lie is avoided.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — recording intent is already in the recordings ledger.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IRecordingSignalProvider = InferProvider<typeof recordingSignalCapability>
