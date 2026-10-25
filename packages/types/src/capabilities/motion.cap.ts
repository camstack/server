import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { MotionTriggeredBySchema } from '../pipeline/camera-sensors.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'

/**
 * Span timeout for a camera's attached sensors. This is the pipeline-runner
 * `motionCooldownMs` default: the window after which a heartbeat-only edge
 * no longer counts. The span does not declare a separate cooldown.
 */
export const MOTION_SPAN_TIMEOUT_MS = 30_000

/** Span override: start on a rising edge, end on a fall or this timeout. */
const motionCustomize = {
  version: 1,
  targets: [
    {
      id: 'detected',
      cardinality: 'event',
      shape: 'span',
      vocabulary: { cap: 'motion', eventName: 'onMotionChanged' },
      deviceTypes: [DeviceType.Camera],
      apply: 'replace',
      applyAuthority: { kind: 'camera-sensors', timeoutField: 'motionCooldownMs' },
      eventName: 'onMotionChanged',
      start: 'rising-edge',
      end: 'falling-edge-or-timeout',
      timeoutMs: MOTION_SPAN_TIMEOUT_MS,
      combine: 'any',
      sourceModes: ['in-addition', 'confirm', 'replace'],
      sources: [{ kind: 'binary' }, { kind: 'switch' }],
      sourceReport: { status: 'assignment-status' },
      advancedExpression: false,
    },
  ],
} as const satisfies CapabilityCustomizeSpec
import { MotionRegionSchema } from './motion-detection.cap.js'
import { MotionSourceEnum } from './pipeline-runner.cap.js'

/**
 * Hardware / firmware motion sensor cap — binary detected state plus
 * a timestamp of the last observation. Distinct from
 * `motion-detection.cap.ts` which owns the LOCAL ML motion pipeline;
 * `motion` is the lightweight readout from on-camera motion (Reolink
 * `GetMdState`, Baichuan push `type: motion`, ONVIF analytics).
 *
 * Native-motion providers also fan out to `detection.camera-native`
 * with `source: 'onboard'` so cross-cutting system services
 * (alert-center, advanced-notifier) can subscribe once and receive
 * motion from every camera.
 */
/**
 * How long after a camera's last rising edge `pipeline-analytics` closes the
 * motion EPISODE row it kept open for it (D475) — "il delay della cap" [the cap's delay], in
 * the operator's words. One authority for the whole system: the writer of a
 * `Camera` device's slice (the orchestrator, D696) writes this SAME constant
 * in `autoClearAfterMs` while `detected: true` (never a camera's own clock —
 * Hikvision used to seed its internal 3 s inactivity timer here, a different
 * clock for a different purpose), and `MotionEpisodeTracker` imports it directly rather
 * than reading the live cap value on the hot path. A `Sensor` device (HA
 * binary sensor, Homematic) gets a genuine push both ways and has no episode
 * to close on a timer, so it writes `null`, never this constant.
 */
export const MOTION_CLOSE_AFTER_MS = 15_000

export const MotionStatusSchema = z.object({
  detected: z.boolean(),
  /** Ms epoch of the last detected-true observation. Null if never detected. */
  lastDetectedAt: z.number().nullable(),
  /**
   * `MOTION_CLOSE_AFTER_MS` while `detected: true` on a `Camera` device (the
   * orchestrator writes it, D696), `null` while false and on every `Sensor`
   * device (D475) — see that constant's doc for the one-authority rule.
   *
   * ## Reading this field still arms nothing
   *
   * It reads like an instruction to the consumer ("revert after N ms if
   * no fresh push arrives") and it is not one: nothing in this repo reads
   * the LIVE cap value to drive a timer. `pipeline-analytics`'s motion-episode
   * close DOES now use the same number — `MOTION_CLOSE_AFTER_MS` — but as an
   * imported constant, not as a read of `device.state.motion.value`, so this
   * field stays what it always was: DESCRIPTIVE output, mirroring an answer
   * computed elsewhere. Building a self-clear timer out of a READ of this
   * field would add a second falling-edge authority beside whichever one
   * already owns the device, and two that can disagree are worse than one.
   * Consumers that need a falling edge SHAPED differently — held open across
   * a flapping source — debounce on their own side and say so, as
   * `addon-export-alexa/src/motion-clear-hold.ts` and
   * `addon-export-hap`'s `RESET_DEBOUNCE_MS` both do.
   *
   * ## Who writes it (D696)
   *
   * - **Cameras** — the orchestrator, and nothing else. It writes the camera's
   *   EFFECTIVE motion (`addon-pipeline-orchestrator`
   *   `camera-sensors/motion-slice.ts`), alongside the effective
   *   `MotionOnMotionChanged` it emits or receives: the camera-sensors bridge
   *   for a split camera, an unsplit emitter's direct event, the analyzer and
   *   device activity, as the camera's `motionSources` counts them. A source
   *   that never sends a clear falls one window after its last `true`.
   *   `lastDetectedAt` moves only on an effective rise. No camera provider
   *   writes this slice (not even a boot seed), and neither does the runner's
   *   phase machine: its phase is "a session is attached" for every on-motion
   *   session, not motion, and it now has its own `DetectionPhaseTransition`.
   *   A provider's `isDetected` and `getStatus` answer from the hub's slice
   *   (`hubMotionNativeProvider`).
   * - **Sensors** (Home Assistant binary sensors, Homematic, Matter, Alexa
   *   imports) — the provider pushes both edges itself, from the upstream
   *   system's own state change. That is the sensor's own fact.
   *
   * `scripts/check-onboard-motion-emitters.ts` refuses any other writer of a
   * `motion` slice; each sensor writer is a named exemption.
   *
   * This replaces the D475 §4 rule ("the phase machine is the sole writer").
   * That rule was never true: Hikvision and Amcrest wrote the slice raw beside
   * it, every provider seeded it at boot, and every session left it
   * `detected: true` after its detach.
   */
  autoClearAfterMs: z.number().nullable(),
})

export type MotionStatus = z.infer<typeof MotionStatusSchema>

/**
 * Payload of `motion.onMotionChanged` event + the corresponding bus
 * event `EventCategory.MotionOnMotionChanged`. Single source of truth
 * — both the cap event surface and the bus payload type alias to this
 * schema.
 */
export const MotionOnMotionChangedDataSchema = z.object({
  deviceId: z.number(),
  detected: z.boolean(),
  timestamp: z.number(),
  source: MotionSourceEnum,
  regions: z.array(MotionRegionSchema).readonly().optional(),
  /** Who started it (D672). Absent = the camera itself. Only `onboard` carries `sensor`. */
  triggeredBy: MotionTriggeredBySchema.optional(),
})
export type MotionOnMotionChangedData = z.infer<typeof MotionOnMotionChangedDataSchema>

export const motionCapability = {
  name: 'motion',
  scope: 'device',
  mode: 'singleton',
  /**
   * Providers register per-device natives via `ctx.registerNativeCap`
   * (Hikvision/Reolink/Amcrest/Wyze/HA/Homematic/Alexa/Matter) — there is
   * NO system singleton provider. Without this flag `resolveCapMount`
   * derived `{ kind: 'singleton' }`, so `motion.getStatus`/`isDetected`
   * resolved via `registry.getSingleton('motion')` (always null) and every
   * call 412'd "provider not available" while bindings listed a live
   * `motion` native (2026-08-02). The flag routes the router through
   * `requireDeviceScoped` → `getProviderForDevice`, like `motion-trigger`,
   * `snapshot` and every other per-device native cap.
   */
  deviceNative: true,
  deviceTypes: [DeviceType.Camera, DeviceType.Sensor],
  methods: {
    /**
     * Pull the current motion state synchronously. Convenience shortcut
     * for consumers that don't need the full status object; equivalent
     * to `getStatus()?.detected ?? false`. Will likely be folded into
     * `getStatus` once the auto-injected status surface lands in every
     * consumer.
     */
    isDetected: method(z.object({ deviceId: z.number() }), z.boolean()),
  },
  events: {
    /**
     * Fires every time the runner transitions a camera between
     * `watching` and `active` phases. `source` carries which motion
     * path drove the transition; `regions` is populated only for
     * `source: 'analyzer'` (frame-diff regions from the ML motion
     * detector) — onboard sources don't carry per-frame regions
     * here (camera-provided zones / AI metadata live in dedicated
     * channels: `detection.camera-native`, future zone capability).
     *
     * Consumers that want all motion pushes (even with `detected`
     * unchanged) should subscribe to the status subscription via
     * `device-manager.subscribeDeviceStatusAggregate` instead.
     */
    onMotionChanged: { data: MotionOnMotionChangedDataSchema },
  },
  status: {
    schema: MotionStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — the last observed motion snapshot, mirrored
   * by the kernel and readable cross-process via
   * `device.state.motion.value`. Reads never invoke the provider, so
   * UIs and other addons can poll the cached state safely.
   */
  runtimeState: MotionStatusSchema,

  /**
   * Runtime-state durability: **session** — the writer of this slice
   * writes only on an EDGE, so a restored `detected: true` would stay
   * frozen until the next one instead of being corrected. The next edge
   * re-publishes the real state, and the orchestrator re-publishes every
   * camera when it starts writing (D696; on who writes it, see
   * `autoClearAfterMs` above).
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. A PIR sensor is a series; a camera is not (its motion is an addon series and a ledger).
   */
  history: {
    fields: {
      detected: { kind: 'boolean', excludeDeviceTypes: [DeviceType.Camera] },
    },
  },
  customize: motionCustomize,
} as const satisfies CapabilityDefinition

export type IMotionProvider = InferProvider<typeof motionCapability>
