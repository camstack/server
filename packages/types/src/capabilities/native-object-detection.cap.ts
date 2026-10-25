import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * On-camera AI object detection cap. Surfaces per-device the classes
 * the firmware can detect and the last-seen instance of each. The
 * provider also fan-outs these to the global `detection.camera-native`
 * event bus with `source: 'onboard'` so cross-cutting system services
 * (alert-center, advanced-notifier, recording-engine) can subscribe
 * once and receive events from every camera.
 *
 * Distinct from `motion-detection` (ML pipeline) and `motion` (hardware
 * PIR or firmware motion pulse): this cap is specifically the AI
 * classifier output coming FROM the camera, not the local pipeline.
 */
export const NativeObjectClassEnum = z.enum([
  'person',
  'vehicle',
  'animal',
  'face',
  'package',
  'other',
])

export type NativeObjectClass = z.infer<typeof NativeObjectClassEnum>

export const NativeDetectionSchema = z.object({
  class: NativeObjectClassEnum,
  timestamp: z.number(),
  /** Firmware-provided confidence [0..1]. Reolink pushes don't carry it → undefined. */
  confidence: z.number().min(0).max(1).optional(),
})

export type NativeDetection = z.infer<typeof NativeDetectionSchema>

export const NativeObjectDetectionStatusSchema = z.object({
  /**
   * Last observed instance per class. Missing entries mean the class
   * is supported but nothing has been seen since the provider started.
   *
   * MUST be a partial record: providers seed an empty `{}` on cold-start
   * and write one class at a time as detections arrive. In Zod 4
   * `z.record(enum, …)` is EXHAUSTIVE (requires every enum key), so a
   * partial write throws "expected object, received undefined" for every
   * unseen class. `z.partialRecord` keeps the enum-key narrowing while
   * allowing the sparse shape the providers actually write.
   */
  lastByClass: z.partialRecord(NativeObjectClassEnum, NativeDetectionSchema.nullable()),
  /** Classes the firmware is capable of detecting — enumerated at device register. */
  supportedClasses: z.array(NativeObjectClassEnum).readonly(),
  /**
   * Whether forwarding of onboard AI detections is enabled for this device.
   *
   * Cold-start OFF on every camera. A vendor does not decide which detector a
   * camera runs — that is the operator's choice, and it is made where every
   * other detection choice is made. `geometry` on
   * {@link NativeObjectDetectionOptionsSchema} is how the form says what the
   * choice would buy this particular camera.
   */
  enabled: z.boolean(),
})

export type NativeObjectDetectionStatus = z.infer<typeof NativeObjectDetectionStatusSchema>

/**
 * WHEN a camera's onboard detections carry geometry.
 *
 * - `boxed` — always. The provider holds a standing channel for the boxes, so
 *   a detection is a trackable subject whenever the camera sees one.
 * - `while-streaming` — only while some stream of this camera is already open.
 *   The boxes ride the video's own side-channel rather than a feed of their
 *   own, so they cost nothing and they exist only when something is pulling.
 *   On Reolink this is every BATTERY camera: a persistent second feed is real
 *   radio drain, but a camera that is awake is awake precisely because
 *   something is in front of it, and its stream is already being pulled.
 * - `flag-only` — never. The firmware ships the class and nothing else; the
 *   pipeline needs geometry to make a subject, so such a push reaches the
 *   tracker as motion and no further.
 *
 * Reported and not inferred, because the operator's question in front of the
 * picker is "what do I get", and these are three different answers (D14: the
 * derived form is only as honest as `getOptions`).
 */
export const NativeObjectGeometryEnum = z.enum(['boxed', 'while-streaming', 'flag-only'])
export type NativeObjectGeometry = z.infer<typeof NativeObjectGeometryEnum>

export const NativeObjectDetectionOptionsSchema = z.object({
  /** Classes this firmware can detect — the same list the status reports. */
  supportedClasses: z.array(NativeObjectClassEnum).readonly(),
  /** What a detection from this camera carries. */
  geometry: NativeObjectGeometryEnum,
})
export type NativeObjectDetectionOptions = z.infer<typeof NativeObjectDetectionOptionsSchema>

export const NativeObjectDetectionSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
})
export type NativeObjectDetectionSettingsPatch = z.infer<
  typeof NativeObjectDetectionSettingsPatchSchema
>

export const NativeObjectDetectionRuntimeStateSchema = NativeObjectDetectionStatusSchema.extend({
  /** Required by createRuntimeStateBridge — epoch ms of last refresh. */
  lastFetchedAt: z.number(),
})

export type NativeObjectDetectionRuntimeState = z.infer<
  typeof NativeObjectDetectionRuntimeStateSchema
>

export const nativeObjectDetectionCapability = {
  name: 'native-object-detection',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  // NO `deviceConfig` here, deliberately. This cap briefly grew a derived form
  // with an on/off switch, and that was a second authority for a question
  // `detectionSources` already owns on the camera's pipeline config — D62: a
  // switch that disagrees with the one that owns the function is worse than no
  // switch. What survives is `getOptions`, which is a statement of CAPABILITY
  // (what this firmware detects, and whether a detection carries geometry) for
  // the surface that does own the choice.
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), NativeObjectDetectionOptionsSchema),
    setSettings: method(
      z.object({ deviceId: z.number(), settings: NativeObjectDetectionSettingsPatchSchema }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    setEnabled: method(z.object({ deviceId: z.number(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  events: {
    onDetected: {
      data: z.object({
        deviceId: z.number(),
        detection: NativeDetectionSchema,
      }),
    },
  },
  status: {
    schema: NativeObjectDetectionStatusSchema,
    kind: 'push',
  },
  runtimeState: NativeObjectDetectionRuntimeStateSchema,

  /**
   * Runtime-state durability: **restored** — `enabled` is an operator toggle on a camera whose refresh is a no-op and whose staleMs is Infinity. There is no hardware value to re-read — losing it loses the setting.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — event-like and nested per class; detections live in the objects ledger.
   */
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type INativeObjectDetectionProvider = InferProvider<typeof nativeObjectDetectionCapability>
