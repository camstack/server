import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * The signals a device can emit to WAKE its own stream.
 *
 * A camera whose stream is built on demand sleeps until something asks for it,
 * and "something" cannot be a consumer that is merely attached — a external-catalog
 * puller holds a session open for ever, and treating that as demand would keep
 * a battery camera awake for ever, which is the whole thing the battery is for
 * (D173). So the wake has to come from the CAMERA: an event it noticed by
 * itself, with no stream running.
 *
 * ## The vocabulary is the PROVIDER'S, not ours
 *
 * Like `consumables`, this cap declares no vocabulary of its own. A provider
 * names each signal with a `code` it chooses and a `label` an operator reads.
 * Reolink offers motion and camera-native detection; another provider may offer
 * a tamper, a doorbell press, a PIR, or something no camera in this fleet has
 * yet. A fixed enum here would mean every new signal is a framework release.
 *
 * It is deliberately NOT derived from the caps a device already binds. Whether
 * a camera CAN push firmware motion is expressed by `motionSources` containing
 * `'onboard'`, and whether it does AI on-camera by the `native-object-detection`
 * binding — but both answer "what drives the detection pipeline", which is a
 * different question from "what may wake a sleeping stream". A camera can do
 * the first and not be trusted with the second, and the operator picks per
 * camera. Two questions, two authorities.
 *
 * ## Availability is not permission
 *
 * `listSignals` says what the device CAN emit. Whether a given signal actually
 * wakes the stream is the operator's per-camera choice, held by the broker
 * alongside the cooldown — see the stream-broker cap's wake settings. A
 * provider declaring a signal is not a provider enabling it.
 */

/** One signal a device can emit. */
export const StreamSignalSchema = z.object({
  /** Stable id chosen by the provider, e.g. `'motion'`, `'person'`, `'tamper'`. */
  code: z.string().min(1),
  /** What an operator reads in the picker. The provider's own wording. */
  label: z.string().min(1),
  /**
   * Whether the provider recommends this signal ON when a camera is first set
   * up. A provider knows which of its signals are cheap and reliable; an
   * operator should not have to discover that by trial. Reolink recommends
   * both of its own.
   */
  recommended: z.boolean(),
})
export type StreamSignal = z.infer<typeof StreamSignalSchema>

export const StreamSignalsStatusSchema = z.object({
  signals: z.array(StreamSignalSchema),
  lastFetchedAt: z.number(),
})
export type StreamSignalsStatus = z.infer<typeof StreamSignalsStatusSchema>

export const streamSignalsCapability = {
  name: 'stream-signals',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // Any device type may have something to say about waking its own stream —
  // derived from the enum rather than a hand-picked subset, for the reason
  // `consumables` is: a hand-picked list is a list somebody has to remember to
  // extend.
  deviceTypes: Object.values(DeviceType),
  runtimeState: StreamSignalsStatusSchema,
  /**
   * Runtime-state durability: **session** — mirrored in RAM, never written.
   *
   * The slice holds what the DEVICE says it can emit. That is a probed fact,
   * not an operator choice: the provider re-declares it on every registration,
   * so losing it loses nothing and persisting it would freeze an answer the
   * camera is entitled to change. Measured the same day on the sibling case —
   * `native-object-detection.supportedClasses` was persisted, and a firmware
   * class the camera really detected stayed missing for the life of the row
   * because the fix could not reach it.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — array state.
   */
  history: 'none',
  methods: {
    /**
     * What this device can emit. Empty is a valid and common answer — most
     * cameras have nothing to offer here, and an empty list is what makes the
     * broker's picker show nothing rather than a false choice.
     */
    listSignals: method(z.void(), z.array(StreamSignalSchema).readonly()),
  },
} as const satisfies CapabilityDefinition

export type IStreamSignalsProvider = InferProvider<typeof streamSignalsCapability>
