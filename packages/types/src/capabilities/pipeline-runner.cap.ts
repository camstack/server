import { z } from 'zod'
import type { ConfigField } from '../interfaces/config-ui.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { MotionRegionSchema } from './motion-detection.cap.js'
import { DetectionSourceSchema } from './pipeline-analytics.cap.js'
import { PipelineStepInputSchema } from './pipeline-executor.cap.js'
import {
  CameraMetricsSchema,
  CameraMetricsWithDeviceIdSchema,
} from './schemas/orchestrator-metrics.js'
import { AudioStreamPickSchema, FrameHandleSchema } from './schemas/streaming-shared.js'
import { ZoneSchema } from './zones.cap.js'
import { MotionTriggeredBySchema } from '../pipeline/camera-sensors.js'
import {
  NodeBenchRunnerInputSchema,
  NodeBenchRunnerStatusSchema,
} from '../pipeline/node-benchmark/schemas.js'

/**
 * A bounding box in NORMALIZED [0,1] frame coordinates for `getNativeCrop`. The
 * decode worker resolves it against the RETAINED native frame's real pixel dims,
 * so the caller supplies only the detection-res bbox divided by the detection
 * dims — no native resolution to plumb.
 */
export const NativeCropBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})

/** Result of a best-effort native-resolution crop (`getNativeCrop`). */
export const NativeCropResultSchema = z.object({
  /**
   * Packed rgb (24-bit) pixels of the crop. Present on the DEFAULT (raw) path —
   * same-node (in-process / UDS) callers get zero-copy RGB and encode locally.
   * OMITTED when the caller requested `encodeJpeg` (the cross-node compressed
   * path below), where shipping raw RGB is both an invariant violation and, for
   * a native full frame (~26 MB at 4K), larger than Moleculer's 10 MB
   * `maxPacketSize` → the packet is dropped and the call 60s-times-out. That is
   * the cross-node native-media miss: `bytes` is replaced by `jpeg`.
   */
  bytes: z.instanceof(Uint8Array).optional(),
  /**
   * Base64 JPEG of the crop — the COMPRESSED cross-node payload. The OWNING node
   * (which holds the native surface) encodes it in-process, so a native 4K frame
   * ships as ~0.5–2 MB (well under `maxPacketSize`) and NO raw pixels ever cross
   * a process boundary (CLAUDE.md invariant #21). Present ONLY when the request
   * set `encodeJpeg: true`; `bytes` is then absent.
   */
  jpeg: z.string().optional(),
  /**
   * The SAME compressed JPEG as `jpeg`, as bytes (D462). Present instead of
   * `jpeg` when the request set `acceptJpegBytes`; a request that did not gets
   * `jpeg` exactly as before. MsgPack and the mesh leg both carry binary —
   * `bytes` above has crossed this boundary as a `Uint8Array` all along — so
   * base64 was buying nothing but a multi-megabyte string in the relay's heap.
   */
  jpegBytes: z.instanceof(Uint8Array).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * Which source served this crop, so a quality-sensitive consumer (the native
   * `keyFrame`) can reject a degraded fallback:
   * - `native` — cut from the decode worker's retained NATIVE surface (the
   *   quality path). A subject-tile serve is also native-resolution and stays
   *   `native` here: the public enum cannot name `tile` without a breaking cap
   *   change. Runner telemetry distinguishes lease vs tile via `source` on the
   *   internal crop result (`nativeHits` vs `tileHits`).
   * - `ram-fullframe` — the native surface MISSED but the request was full-frame,
   *   so the ≤640 RAM `RetainedFrameStore` served it (honest lower-res; legit for
   *   the blank-frame guard / 640-snapshot resolve, NOT for the clean keyFrame).
   *
   * OPTIONAL: a pre-tier runner (version skew) omits it — an ABSENT `tier` MUST be
   * treated as `native` (accepted) by every consumer so mixed-version clusters
   * keep the pre-tier behaviour. An ROI miss returns `null` (no tier at all).
   */
  tier: z.enum(['native', 'ram-fullframe']).optional(),
})

export type NativeCropBbox = z.infer<typeof NativeCropBboxSchema>
export type NativeCropCapResult = z.infer<typeof NativeCropResultSchema>

/**
 * What a PARKED frame is for — the `kind` half of the `(deviceId, trackId,
 * kind)` key ([D422](../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)).
 *
 * - `keyFrame` — the track's clean best FULL frame at native width (capped by
 *   the caller's `maxWidth`). What `keyFrame` + `keyFrameSmall` are written
 *   from, and what the detail plane's full-frame rung cuts from.
 * - `thumbnail` — the best-shot subject slab: the caller's 16:9 central-square
 *   window, cut by the runner at uncapped native resolution.
 *
 * The runner never interprets `trackId`; it is an opaque key the hub owns.
 */
export const ParkedFrameKindSchema = z.enum(['keyFrame', 'thumbnail'])
export type ParkedFrameKind = z.infer<typeof ParkedFrameKindSchema>

/**
 * Why a park did NOT happen. Every one is logged on the runner with
 * `tags: { deviceId }` and the handle's measured age, because a handle already
 * gone at park time IS the defect the 150–500 ms window exists to prevent —
 * never a reason to retry in a loop.
 *
 * - `handle-gone` — the native surface no longer resolves this handle (never
 *   registered, past the lease bound, or the worker released it). `detail`
 *   carries the runner's own miss reason.
 * - `encode-failed` — pixels resolved and the JPEG encode threw.
 */
export const ParkRefusalSchema = z.enum(['handle-gone', 'encode-failed'])
export type ParkRefusal = z.infer<typeof ParkRefusalSchema>

/** Answer to `parkTrackFrame` — a discriminated union, so "not parked" always names why. */
export const ParkTrackFrameResultSchema = z.discriminatedUnion('parked', [
  z.object({
    parked: z.literal(true),
    /** The node holding the parcel — what a later retrieval must be pinned to. */
    nodeId: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** JPEG bytes the parcel costs on the node. */
    bytes: z.number().int().nonnegative(),
    /** Whether this park replaced a parcel already held for the key. */
    replaced: z.boolean(),
  }),
  z.object({
    parked: z.literal(false),
    nodeId: z.string(),
    reason: ParkRefusalSchema,
    /** Age of the handle at the park, on the runner's clock; null if unknown. */
    handleAgeMs: z.number().nullable(),
    detail: z.string().optional(),
  }),
])
export type ParkTrackFrameResult = z.infer<typeof ParkTrackFrameResultSchema>

/** A retrieved parcel — the runner's own JPEG, base64 for the wire. */
export const ParkedTrackFrameSchema = z.object({
  /**
   * Base64 JPEG — the pre-D462 wire. OPTIONAL since D462: a request that set
   * `acceptJpegBytes` is answered in `jpegBytes` and this is then absent.
   * Exactly one of the two is present.
   */
  jpeg: z.string().optional(),
  /** The same JPEG as bytes, for a caller that declared it reads them (D462). */
  jpegBytes: z.instanceof(Uint8Array).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The frame instant the parcel shows (the caller's clock, echoed back). */
  timestamp: z.number(),
  /** When the node stored it (the node's clock). */
  parkedAt: z.number(),
})
export type ParkedTrackFrame = z.infer<typeof ParkedTrackFrameSchema>

/** Parent detection context passed to `runDetailSubtree` — the crop's
 *  originating detection, in FRAME-space coordinates. Reuses
 *  `NativeCropBboxSchema`'s `{x,y,w,h}` shape (same numeric fields; here
 *  the coordinates are frame-space rather than getNativeCrop's
 *  normalized [0,1] convention). */
const DetailParentSchema = z.object({
  bbox: NativeCropBboxSchema,
  className: z.string(),
})

/** One child-step result from `runDetailSubtree` — an embedding, label,
 *  or refined detection produced by running the crop-subtree on a
 *  single tracked detection. */
const DetailResultSchema = z.object({
  stepId: z.string(),
  className: z.string(),
  score: z.number(),
  /** FRAME-space bbox (already mapped back from crop space). */
  bbox: NativeCropBboxSchema.optional(),
  embedding: z.string().optional(), // base64 float32 vector
  /**
   * L2 magnitude of the RAW pre-normalization embedding. Additive and optional
   * so an older runner that does not send it degrades to "unmeasurable", which
   * the consuming gate treats as accept — never as reject.
   */
  embeddingMagnitude: z.number().optional(),
  /**
   * Model that produced `embedding` — the SAME contract `labelModelId` has for
   * `label`, and for the same reason: the producing node is the only side that
   * knows which model actually ran, and re-deriving it downstream is exactly
   * the inference this model exists to forbid.
   *
   * Additive and optional, so a runner that predates it degrades to
   * "unmeasurable" rather than to a wrong answer — the consumer falls back to
   * its previous assumption instead of refusing.
   *
   * Its absence was not cosmetic. `FaceRecognizer` needs the probe's model id
   * to use `face-matcher`'s same-model gate (`sample.modelId !== probe.modelId`);
   * with nothing on the wire it took the id from the GALLERY, so the gate
   * compared the gallery against itself and could never fire. That turned the
   * one guard protecting the face feature space into a tautology, and it is
   * why swapping `face-embedding`'s model would NOT have stranded the enrolled
   * gallery as the catalog comment predicts — it would have scored the new
   * model's vectors against the old model's samples in one cosine space.
   */
  embeddingModelId: z.string().optional(),
  label: z.string().optional(), // classifier answer / plate text
  /**
   * The tier `label` occupies, copied VERBATIM from the producing step's
   * `StepDefinition.labelTier` (roadmap 4g). Present only when `label` is.
   *
   * It rides the wire rather than being resolved by the consumer because the
   * declaration lives with the step definition, which only the executing node
   * has: post-analysis holds no step registry, and re-deriving the tier from
   * `className` there would be exactly the inference this model exists to
   * forbid. A `label` that arrives WITHOUT this field is refused by the write
   * rule and logged (`label tier undeclared`) — an older runner therefore
   * stops enriching rather than guessing, which is why addon-pipeline is
   * deployed BEFORE addon-post-analysis.
   */
  labelTier: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Model that produced `label` — carried into the tier's attribution. */
  labelModelId: z.string().optional(),
  alignedCropJpeg: z.string().optional(), // byte-identical embedding input (faces)
  /** Face short side (px) measured on the NATIVE crop surface. The `bbox`
   *  above is detection-frame px (≈6× smaller on a 4K camera) — min-face-size
   *  consumers MUST prefer this when present (2026-07-22 native-gate fix). */
  nativeFaceShortSidePx: z.number().optional(),
  /**
   * The five facial landmarks of a `face` detail, in the SAME frame space as
   * `bbox` (D644). Additive and optional: post-analysis stores them beside the
   * face's source frame so a future alignment can be re-derived exactly; a
   * runner that predates the field sends none and the face is stored without.
   */
  landmarks: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
})
export type DetailParent = z.infer<typeof DetailParentSchema>
export type DetailResult = z.infer<typeof DetailResultSchema>

/**
 * Why an executing node REFUSED a stateless step run (`runStatelessStep`).
 *
 * A refusal is a first-class answer, not an error, because the caller's next
 * move depends on WHICH one it is — and because "the pass produced nothing"
 * must never be reachable without a named, counted cause. The two tiers:
 *
 * - **node-level** (`unknown-step`, `model-not-servable`) — this node can
 *   never serve this (step, model) pair. The caller drops it from its rotation
 *   and retries the same work elsewhere; nothing about the work changes.
 * - **work-level** (`unreadable-frame`, `execution-failed`) — this node is
 *   fine, this one request is not. Retrying it on another node would only
 *   spread the same failure.
 */
const StatelessStepRefusalSchema = z.enum([
  /** The step id is not in this node's catalog (version skew / custom addon). */
  'unknown-step',
  /**
   * This node cannot run the PINNED model on the format it would dispatch on.
   *
   * The load-bearing refusal. `resolveModelForFormat` SUBSTITUTES a model with
   * no build for the node's format with that format's default — silently, with
   * one info line — which across a fleet pass fills one vector index from two
   * different encoders. That is [D52](../../../docs/decisions/adr-0052.md) one
   * level down, with nothing in the data to hint at it. The node refuses
   * instead of substituting.
   */
  'model-not-servable',
  /** The supplied frame could not be decoded, or the bbox was degenerate. */
  'unreadable-frame',
  /** The step ran and threw / produced no frame result. */
  'execution-failed',
])
export type StatelessStepRefusal = z.infer<typeof StatelessStepRefusalSchema>

/**
 * Answer to `runStatelessStep` — a discriminated union rather than a nullable
 * result, because `null` is exactly what made the camera-bound detail path
 * unable to tell "refused" from "never asked".
 */
const RunStatelessStepResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ran'),
    /** The node that actually executed it — the pin, echoed back for the log. */
    nodeId: z.string(),
    /**
     * The model the step ran with.
     *
     * The node verified this exact id has a build for the format it dispatched
     * on BEFORE running, so the executor's format resolution returns it
     * unchanged. A caller that pinned a model must compare this field and
     * treat a mismatch as a refusal — the whole point of the pin is that a
     * pass writes one feature space.
     */
    modelId: z.string(),
    details: z.array(DetailResultSchema),
  }),
  z.object({
    kind: z.literal('refused'),
    nodeId: z.string(),
    reason: StatelessStepRefusalSchema,
    /** Human-readable specifics — the format tried, the formats shipped, etc. */
    detail: z.string(),
  }),
])

/**
 * Per-camera tunable ranges + defaults. Single source of truth used
 * by both the Zod data schema (validation + default fallback) and
 * the device settings UI (slider min/max/step). Touch one place and
 * both sides stay aligned.
 */
const motionCooldownMsField = { min: 0, max: 60_000, default: 30_000, step: 500 } as const
// Upper bound on how long an on-motion detection session is HELD OPEN past the
// motion cooldown while a confirmed non-stationary track is still active
// (orchestrator-side session-hold — a slow subject can evade VMD yet still be
// tracked). `0` disables the hold entirely (legacy cooldown-only behaviour).
const maxSessionHoldMsField = { min: 0, max: 600_000, default: 120_000, step: 5_000 } as const
/**
 * Quiet period that closes an `audioMode: 'on-motion'` audio window. Floor of
 * 5s so a rearm can never degenerate into per-event stream churn; default 90s
 * comfortably outlives the gap between two PIR wakes on a battery camera.
 */
const audioMotionWindowMsField = { min: 5_000, max: 600_000, default: 90_000, step: 5_000 } as const
const motionFpsField = { min: 1, max: 30, default: 4, step: 1 } as const
const detectionFpsField = { min: 1, max: 30, default: 10, step: 1 } as const
/**
 * The occupancy re-check interval. DEFAULT 300 s (2026-08-13 — was 30 s).
 *
 * The recheck is now on by default (a parked car is invisible to occupancy
 * rules until the stationary registry has been rebuilt by motion, which after a
 * restart may be never on a quiet camera). Each cycle re-subscribes a detection
 * session — an RTSP re-dial — so the switch is only affordable at a WIDE
 * interval: 300 s is ~12 re-dials an hour per camera, against 120 at the old
 * 30 s. A parked car is therefore counted within 5 minutes of a restart.
 *
 * Why not wider: `max` is 300 and raising it is TRAIN-BOUND, not addon-bound —
 * the host validates `attachCamera` against ITS copy of this schema, so a
 * runner asked for 600 would be rejected by the hub until a `@camstack/server`
 * carrying the wider bound is installed everywhere. 300 is the widest value
 * that ships with an addon deploy.
 */
// Default 300 s (D136; docs/architecture/object-detection.md): the recheck exists
// for a static subject (a parked car), and each cycle is an RTSP re-dial plus
// `occupancyRecheckFrames` inferences. 30 s was tried on 2026-08-13 and reverted —
// it starved the decode path across the fleet. The cost is paid only while
// occupancyArmed.
const occupancyRecheckSecField = { min: 0, max: 300, default: 300, step: 5 } as const
const occupancyRecheckFramesField = { min: 1, max: 10, default: 4, step: 1 } as const

/**
 * Frames one PRE-ROLL catch-up burst may send to inference at session open.
 *
 * The default of 12 over a ~4 s retained window is one frame per ~333 ms of
 * footage, and costs ~480 ms of ONE inference permit at the 40 ms/frame this
 * fleet measures — one-shot, and only ever taken while a permit would still be
 * spare for live. `0` turns the burst off entirely (the history is still
 * decoded, because that is how the dial reaches a decodable GOP, and is then
 * discarded — the pre-D411 behaviour).
 */
const preRollInferenceFramesField = { min: 0, max: 30, default: 12, step: 1 } as const

/**
 * Source enum for motion signals fed to the runner. Extensible — add
 * new variants here when new motion-trigger paths are wired in
 * (`wasm-cross-camera`, `event-bus-relay`, etc.). The runner uses
 * the variant for diagnostics + to route the cap-state event payload
 * (analyzer attaches detected `regions[]`; onboard does not — the
 * camera typically only reports a binary signal plus an optional
 * channel/AI class which lives in dedicated event channels).
 *
 * - `onboard` — the camera's firmware said something moved.
 * - `analyzer` — this runner's frame-diff said so, and attaches `regions[]`.
 * - `device-activity` — the DEVICE said it is doing its job: the
 *   `recording-signal` LEVEL the same device raises for the recorder
 *   ([D380](../../../../docs/decisions/adr-0380-a-device-decided-recording-is-a-mode-with-no-schedule-seeded-once.md)),
 *   republished as a motion source. It attaches **nothing** — no regions, no
 *   class: the only fact it carries is that the device is active, and a robot
 *   vacuum that is itself the moving object has no region worth sending. It is
 *   a LEVEL, so unlike `onboard` it has a real falling edge, and unlike
 *   `analyzer` it must not open the frame-diff side-channel — the runner's
 *   `handleOnboardMotionAnalyzer` gate is `source === 'onboard'` and stays that
 *   way ([D392](../../../../docs/decisions/adr-0392-a-device-that-says-it-is-working-is-a-motion-source-of-its-own.md)).
 */
export const MotionSourceEnum = z.enum(['onboard', 'analyzer', 'device-activity'])
export type MotionSource = z.infer<typeof MotionSourceEnum>

/**
 * What opened an on-motion detection SESSION: the motion source that passed the
 * camera's `motionSources` gate, and what raised it (the camera itself, or a
 * sensor the operator attached — D672). `sensorName` is the attached sensor's
 * device name as the orchestrator's camera-sensors resolution last read it;
 * absent when unknown or when the camera itself triggered.
 *
 * Carried on the session attach ONLY so the runner's `DetectionPhaseTransition`
 * can say what started the session (D672 rule 11, amended 2026-10-06). The
 * runner never decides anything on it.
 */
export const SessionTriggerSchema = z.object({
  source: MotionSourceEnum,
  triggeredBy: MotionTriggeredBySchema,
  sensorName: z.string().optional(),
})
export type SessionTrigger = z.infer<typeof SessionTriggerSchema>

/**
 * List of motion sources active on a camera. Empty array is valid:
 * "no source" — happens for battery cams without firmware motion when
 * the operator hasn't opted into the SW analyzer (would hold the
 * substream open continuously and defeat the sleep cycle). The runner
 * accepts the empty list as "no motion-driven phase transitions" and
 * relies on the operator-set `detectionMode` to drive activation
 * (`'always-on'`) — `'on-motion'` with no source effectively pins the
 * phase to `'watching'`, which is the desired battery-cam-without-
 * firmware behaviour.
 *
 * Single source of truth for the array shape — every consumer
 * (orchestrator, runner, settings UI, dispatch) imports from here.
 */
export const MotionSourcesSchema = z.array(MotionSourceEnum)
export type MotionSources = z.infer<typeof MotionSourcesSchema>

/**
 * The operator-facing name of each MOTION source (D672: `onboard` = the
 * camera's sensors — its own motion plus any sensor attached to it). The wire
 * value stays `onboard`; only the label changed. `detectionSources: 'onboard'`
 * ("Camera onboard AI") and the notification source filter keep their labels.
 */
export const MOTION_SOURCE_LABELS: Readonly<Record<MotionSource, string>> = {
  analyzer: 'Frame-diff Analyzer (motion addon)',
  onboard: 'Camera sensors',
  'device-activity': 'Device activity (the device says it is working)',
}

/** A value this build does not know (a newer node's) is shown as itself. */
export function motionSourceLabel(value: string): string {
  const parsed = MotionSourceEnum.safeParse(value)
  return parsed.success ? MOTION_SOURCE_LABELS[parsed.data] : value
}

/** The order the motion-source picker offers them in (not the enum's order). */
const MOTION_SOURCE_PICKER_ORDER: readonly MotionSource[] = [
  'analyzer',
  'onboard',
  'device-activity',
]

/**
 * Which root detector a camera runs — EXACTLY ONE.
 *
 * Deliberately the SAME vocabulary post-analysis already tags every detection
 * with (`DetectionSource`) rather than a second spelling of the same two
 * ideas: the value an operator picks here is the value that comes back on the
 * track, the overlay and the debug row.
 *
 * ## Why one, and why it is still an array
 *
 * Two roots on one camera is a capability nobody asked for and the operator has
 * since ruled out. It was never free: both planes feed the SAME per-device
 * stationary registry, both can promote the same parked object, and the two
 * detectors disagree about the same box by construction — which is the
 * disagreement D505 had to arbitrate. Removing the case removes the arbitration.
 *
 * The ARRAY shape survives because the stored settings and the attach payload
 * already speak it on every camera of every fleet, and a cap input that
 * suddenly refuses a stored value makes the camera un-attachable — a fail-closed
 * in the one direction that costs an operator their cameras. So the wire stays
 * tolerant and the TYPE is exact: a longer list is truncated to its first
 * element rather than refused, and `max(1)` is what every consumer can then
 * rely on.
 *
 * AT MOST one, not exactly one. The EMPTY list is a legal, deliberate pick —
 * a camera an operator left with no root detector — and `planDetectionSources`
 * has always said so: inventing a root for them is how a default acts without
 * anybody choosing it. Tightening this to `length(1)` broke that, and the
 * suite caught it.
 *
 * Measured before tightening (2026-09-15, this fleet, 6 h of attaches): 3327
 * `["pipeline"]` and 2 `["onboard"]`. Not one camera had two.
 */
export const DetectionSourcesSchema = z.preprocess(
  // The truncation is here and not in a consumer so there is ONE place where a
  // legacy two-root value becomes a one-root value (D62).
  (value) => (Array.isArray(value) && value.length > 1 ? value.slice(0, 1) : value),
  z.array(DetectionSourceSchema).max(1),
)
export type DetectionSources = z.infer<typeof DetectionSourcesSchema>

/**
 * Input shape for `pipeline-runner.reportMotion` cap method. Exported
 * so cap-side consumers (the orchestrator forward, the runner addon's
 * cap implementation, tests) can reuse the type instead of redeclaring
 * the field set.
 */
export const ReportMotionInputSchema = z.object({
  deviceId: z.number(),
  detected: z.boolean(),
  source: MotionSourceEnum.default('analyzer'),
  regions: z.array(MotionRegionSchema).readonly().optional(),
})
export type ReportMotionInput = z.infer<typeof ReportMotionInputSchema>

/**
 * Where a runner gets a camera's decoded frames (cross-node Phase 2,
 * restream-owner model — P2c).
 *
 * - `local-broker` (DEFAULT): today's path — subscribe to the co-located
 *   stream-broker's shm frame plane. Every pre-P2c attach payload (no
 *   `frameSource` key) parses to this, so the field is additive with zero
 *   behavior change.
 * - `remote-restream`: the detect node is NOT the camera's source-owner.
 *   The runner acquires the owner's COMPRESSED passthrough restream
 *   (`streamBroker.getStreamWithCodec({video:'copy'})` — refcounted, the
 *   double-pull guard) and decodes LOCALLY via a satellite frame plane +
 *   pull-mode decoder session pinned to its own node. The shm ring stays
 *   node-local; only H.264/H.265 packets cross the wire.
 *   `hubHostnameOverride` mirrors the recorder's `recordingHubHostname`:
 *   when set it overrides the `CAMSTACK_HUB_URL`-derived host the runner
 *   dials for the owner's restream.
 */
export const RunnerFrameSourceSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('local-broker') }),
    z.object({
      kind: z.literal('remote-restream'),
      /** The camera's source-owner node (slice 1: always the hub). */
      ownerNodeId: z.string(),
      /**
       * The owner's LAN-reachable host, resolved by the orchestrator from the
       * per-node `reachableHost` override (Cluster UI). When present the runner
       * dials THIS host for the owner's restream, in preference to the
       * `CAMSTACK_HUB_URL`-derived default. Absent → auto-detect fallback.
       */
      ownerReachableHost: z.string().optional(),
      /** Operator override for the owner host the runner dials. */
      hubHostnameOverride: z.string().optional(),
    }),
  ])
  .describe('Per-camera frame-source mode for the runner (P2c)')
export type RunnerFrameSource = z.infer<typeof RunnerFrameSourceSchema>

/**
 * What ONE step runs with on ONE roster device for THIS camera (D650): the
 * device's per-(node,device) base with the camera's override for that device
 * on top — the same `override ?? base` merge the orchestrator applies to the
 * elected device (`applyDeviceProvisioning`). Absent `modelId` ⇒ the executor
 * resolves the device format's default, exactly as on the elected device.
 */
export const RunnerJumpStepProvisioningSchema = z.object({
  modelId: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})
export type RunnerJumpStepProvisioning = z.infer<typeof RunnerJumpStepProvisioningSchema>

/**
 * One ENABLED inference device on the runner's node, as the step-tree
 * device-jump resolver sees it (phase 1). The orchestrator populates this
 * roster on the attach payload whenever the camera is elected onto a specific
 * `deviceKey` and the node has ≥2 enabled devices — it is the candidate set the
 * runner auto-jumps an enrichment step to when the elected device's format
 * cannot run that step's model. `weight`/`maxSessions` mirror the balancer's
 * per-device knobs so the auto choice is weighted-least-loaded.
 */
export const RunnerInferenceDeviceSchema = z.object({
  deviceKey: z.string(),
  weight: z.number().positive().default(1),
  maxSessions: z.number().int().positive().nullable().default(null),
  /**
   * Per-step provisioning for this camera on THIS device (D650), keyed by step
   * id. A step the runner jumps here runs with these fields, never with the
   * elected device's: `modelId` / `settings` are REPLACED on the jumped subtree
   * (a step absent from the map runs with neither — the target format default).
   * Absent field ⇒ an orchestrator that predates D650: the jumped step keeps
   * the elected device's provisioning, as before.
   */
  steps: z.record(z.string(), RunnerJumpStepProvisioningSchema).optional(),
})
export type RunnerInferenceDevice = z.infer<typeof RunnerInferenceDeviceSchema>

/**
 * Camera assignment payload sent by `addon-pipeline-orchestrator` to a
 * specific runner instance via `attachCamera`. Carries everything the
 * runner needs to subscribe to the local broker and execute inference.
 *
 * Stateless-pipeline model: the pipeline content (`steps`, optional
 * `audio`) travels with the attach payload. The runner keeps it in RAM
 * for the lifetime of the attach — on rebalance, edit, or restart the
 * orchestrator re-sends the latest snapshot. Engine is NOT carried: it is
 * node-local, resolved by the executing runner at dispatch time.
 */
const RunnerCameraConfigSchema = z.object({
  deviceId: z.number(),
  /**
   * Operator-facing scheduling mode for the SW object detection
   * pipeline. Replaces the legacy 2-state `priority` toggle.
   *
   *   - `'disabled'`   — runner never subscribes to the substream for
   *                      detection; phase stays idle. Bindings stay
   *                      bound; this is the runtime-level off switch.
   *   - `'always-on'`  — phase starts in `'active'` and never falls
   *                      back to `'watching'`.
   *   - `'on-motion'`  — phase starts in `'watching'`; transitions to
   *                      `'active'` when a motion source fires; falls
   *                      back to `'watching'` after `motionCooldownMs`.
   */
  detectionMode: z.enum(['disabled', 'always-on', 'on-motion']).default('on-motion'),
  /** Audio scheduling mode — same values as `detectionMode`. The
   *  audio-analyzer addon reads this to decide whether to subscribe
   *  to the audio decoded stream. */
  audioMode: z.enum(['disabled', 'always-on', 'on-motion']).default('always-on'),
  motionCooldownMs: z
    .number()
    .min(motionCooldownMsField.min)
    .default(motionCooldownMsField.default),
  /**
   * Orchestrator-side on-motion session-hold cap (ms). While an on-motion
   * detection session is active and ≥1 confirmed non-stationary track is
   * still live, the orchestrator keeps the session open past
   * `motionCooldownMs` (a slowly-moving subject can stop re-triggering the
   * camera's VMD yet is still being tracked frame-to-frame) — up to this many
   * ms since the session opened, after which it closes regardless. `0`
   * disables the hold (legacy cooldown-only teardown). Not consumed by the
   * runner itself — carried here so it shares the per-camera device-settings
   * surface with `motionCooldownMs`; the orchestrator reads it off the
   * resolved `CameraDetectionConfig`.
   */
  maxSessionHoldMs: z
    .number()
    .min(maxSessionHoldMsField.min)
    .max(maxSessionHoldMsField.max)
    .optional(),
  /**
   * Orchestrator-side quiet period (ms) that closes an `audioMode:
   * 'on-motion'` audio window, measured from the LAST motion event.
   *
   * This exists because the falling edge cannot be relied on. Camera-native
   * providers emit motion as a RISING EDGE ONLY (Reolink's Baichuan push and
   * its email-push SMTP path both emit `detected: true` and never the
   * counterpart); only the frame-diff analyzer emits falls. So on an
   * onboard-only camera a window that closed only on `detected: false` never
   * closed at all, and `on-motion` silently behaved as `always-on` — on a
   * battery camera, the one failure mode the mode exists to prevent.
   *
   * Every motion event rearms this timer WITHOUT restarting the stream, so a
   * burst of re-fires costs nothing. A falling edge, when one does arrive,
   * still closes earlier via `motionCooldownMs` — whichever comes first wins.
   *
   * Not consumed by the runner: carried here so it shares the per-camera
   * device-settings surface with `motionCooldownMs`, exactly like
   * `maxSessionHoldMs`.
   */
  audioMotionWindowMs: z
    .number()
    .min(audioMotionWindowMsField.min)
    .max(audioMotionWindowMsField.max)
    .optional(),
  motionFps: z
    .number()
    .min(motionFpsField.min)
    .max(motionFpsField.max)
    .default(motionFpsField.default),
  detectionFps: z
    .number()
    .min(detectionFpsField.min)
    .max(detectionFpsField.max)
    .default(detectionFpsField.default),
  motionStreamId: z.string(),
  detectionStreamId: z.string(),
  /**
   * Which rung this camera's audio analysis listens on — `auto` (the lowest
   * AVAILABLE native rung) or an explicit one.
   *
   * Not consumed by the runner: carried here so it travels with the camera's
   * config the way `audioMotionWindowMs` does, and so the orchestrator's
   * watchdog resolves the same stream the audio subscription did. OPTIONAL
   * with no default — absent means `auto`, which is what every camera written
   * before this field had, and an absent optional adds nothing to the
   * generated cap-input defaults (D537).
   */
  audioStreamPick: AudioStreamPickSchema.optional(),
  /**
   * Motion sources that can activate the pipeline. At least one must
   * be present. Multiple sources OR-ed: any one firing arms the
   * cooldown timer and transitions watching → active. The same
   * `motionCooldownMs` applies to whichever source(s) fire — the
   * timer rearms on every `reportMotion(true)` and expires after the
   * window, returning the runner to `watching`.
   *
   * - `analyzer`: ML/frame-diff motion detection (motion-wasm or other
   *   analyzer providers) running on decoded frames in this runner.
   * - `onboard`: camera-native motion pushes (Reolink Baichuan, ONVIF
   *   analytics). The provider emits its raw push as `ProviderMotion`
   *   (D673); the orchestrator's camera-sensors bridge re-emits the camera's
   *   effective motion as `MotionOnMotionChanged`, which is what reaches
   *   `reportMotion`.
   */
  motionSources: MotionSourcesSchema.default(['analyzer']),
  /**
   * What opened this attach, on a SESSION attach only (see
   * {@link SessionTriggerSchema}). OPTIONAL with no default: absent on a
   * standing attach, an occupancy burst, a re-dispatch with no motion event
   * behind it, and every attach from an orchestrator older than the field — the
   * runner then names no source on the phase event.
   */
  sessionTrigger: SessionTriggerSchema.optional(),
  /**
   * WHICH root detector runs for this camera. The detection counterpart of
   * {@link motionSources}, same shape and same discipline: a per-camera list
   * of sources the system understands, vendor-agnostic, owned here.
   *
   * - `pipeline` — this runner's own root step on decoded pixels (`steps`).
   * - `onboard` — the CAMERA's own detector, admitted only when it is named
   *   here. Its boxes reach post-analysis on the same
   *   `PipelineInferenceResult` payload as the pipeline's, so an onboard-born
   *   track gets the same tracker, the same overlay and the same detail
   *   subtree (face / plate / embedding).
   *
   * `['onboard']` alone is the REPLACEMENT: this runner's root step does not
   * run, and that is where a camera with a usable onboard detector buys back
   * its share of the accelerator. It saves the root inference, not the decode
   * — the detail subtree still needs pixels to cut crops from.
   *
   * A camera whose onboard detections carry no geometry cannot serve as a root
   * step at all (there is nothing to track), and the cap that knows this says
   * so on `native-object-detection.getOptions().geometry`. On Reolink that is
   * every battery camera: the boxes ride a sub-stream a battery camera never
   * attaches, so such a camera stays on `['pipeline']` and its onboard AI is
   * worth exactly what it already is — a wake signal with a class.
   *
   * Defaults to `['pipeline']`, which is byte-for-byte today's behaviour: a
   * vendor never turns a detector on for the operator, and neither does a
   * default.
   */
  detectionSources: DetectionSourcesSchema.default(['pipeline']),
  pipelineEnabled: z.boolean().default(true),
  // ── Stateless-pipeline: content carried with the attach ───────────
  // Engine is NOT carried on the attach payload — it is node-local: the
  // executing runner resolves its own format default at dispatch time.
  /** Ordered tree of video steps. Absent → runner skips video detection. */
  steps: z.array(PipelineStepInputSchema).readonly().optional(),
  /** Audio classification branch. `enabled:false` disables, null skips. */
  audio: z
    .object({
      // Absent when the operator hasn't explicitly chosen an audio model —
      // the runner resolves its own format default at runtime.
      modelId: z.string().optional(),
      enabled: z.boolean(),
    })
    .nullable()
    .optional(),
  /**
   * Per-camera detection zones (user + onboard) snapshot at dispatch
   * time. Forwarded so motion-wasm + pipeline-executor running on the
   * runner can apply include/exclude/monitor logic without an extra
   * round-trip to the hub. The orchestrator re-dispatches the camera
   * whenever its `zones` device-state slice changes, so the runner's
   * copy stays in sync. Empty array → no zone filtering.
   */
  zones: z.array(ZoneSchema).readonly().default([]),
  /**
   * When true (default) and the camera's `motionSources` contains only
   * `'onboard'`, the runner dynamically opens the same WASM frame-diff
   * motion-frames subscription on each `MotionOnMotionChanged
   * source:'onboard'` event and tears it down after `motionCooldownMs`.
   * This causes `runMotionAnalysis` to emit `MotionZonesRaw` /
   * `MotionAnalysis` during active-motion windows without the
   * substream being held open continuously.
   *
   * Set to `false` to disable the dynamic analyzer for this camera
   * (e.g. very low-bandwidth links where the extra substream is
   * undesirable). Has no effect when `motionSources` already includes
   * `'analyzer'` — the analyzer runs continuously in that case and
   * this gate is bypassed.
   */
  onboardMotionDrivesAnalyzer: z.boolean().default(true),
  /**
   * Master toggle for the occupancy re-check. When `false` the runner never arms
   * the periodic recheck timer, regardless of `occupancyRecheckSec`; the
   * `occupancyRecheckSec` / `occupancyRecheckFrames` sliders only take effect
   * (and only render) when this is enabled.
   *
   * DEFAULT `true` since 2026-08-13 (was `false`). It was off because the
   * recheck re-subscribes a detection session every N seconds while `watching`
   * — each cycle creates+tears a session ⇒ an RTSP re-dial ⇒ latency, a major
   * pull-decoder churn source. What that bought was a blind spot: a STATIONARY
   * object is counted only while the stationary registry holds it, and the
   * registry rebuilds from motion, so after a restart a parked car was invisible
   * to every occupancy rule until something moved in front of it. The churn is
   * now paid on the interval instead — see `occupancyRecheckSecField`.
   */
  /**
   * Infer the session's PRE-ROLL — the retained history the restreamer replays
   * at session open — instead of decoding it and throwing it away.
   *
   * DEFAULT `true`, and the default is the argument. This is not a new
   * capability being offered cautiously: the pre-roll is ALREADY requested,
   * already served, already decoded and already paid for on every on-motion
   * detection session that asks for history. What shipped was a last-moment
   * discard — `FrameSlot`'s throttle compares wall clocks, and ~4 s of media
   * arriving inside a few hundred ms of wall clock looks to it like one frame's
   * worth. Device 102, 2026-09-08: a re-run of the SAME model over the stored
   * recording scored the subject `vehicle 0.5669` — above the 0.50 floor —
   * 1.68 s BEFORE the live track was born, on a frame that was in the pre-roll,
   * was decoded, and was freed.
   *
   * Shipping that as opt-in would ship the bug: an operator cannot discover a
   * setting whose absence looks exactly like a camera that noticed the cyclist
   * late. What makes ON safe is not a switch but the BOUND —
   * `preRollInferenceFrames`, a wall-clock ceiling, and a lane that never takes
   * the last inference permit — so the switch exists for the camera where the
   * history is worthless (a doorbell whose subject is always already at the
   * door), not as a hedge against the feature.
   */
  preRollInferenceEnabled: z.boolean().default(true),
  preRollInferenceFrames: z
    .number()
    .min(preRollInferenceFramesField.min)
    .max(preRollInferenceFramesField.max)
    .default(preRollInferenceFramesField.default),
  occupancyRecheckEnabled: z.boolean().default(true),
  occupancyRecheckSec: z
    .number()
    .min(occupancyRecheckSecField.min)
    .max(occupancyRecheckSecField.max)
    .default(occupancyRecheckSecField.default),
  occupancyRecheckFrames: z
    .number()
    .min(occupancyRecheckFramesField.min)
    .max(occupancyRecheckFramesField.max)
    .default(occupancyRecheckFramesField.default),
  /**
   * Where this runner gets the camera's decoded frames (P2c). Defaulted so
   * every existing payload behaves as `local-broker` — the pre-Phase-2 path.
   * Populated with `remote-restream` by the orchestrator ONLY when the
   * camera's detect node differs from its source-owner (P2d, gated by the
   * `remoteSourcingNodes` rollout setting).
   */
  frameSource: RunnerFrameSourceSchema.default({ kind: 'local-broker' }),
  /**
   * Inference-device selector for this camera's sessions (Phase 2 multi-device).
   * Format `<backend>:<device>` (e.g. `openvino:gpu`, `edgetpu:usb`, `cpu`);
   * omitted ⇒ the runner's default device. The engine itself stays node-local —
   * this only selects WHICH device pool of that node runs the session.
   */
  deviceKey: z.string().optional(),
  /**
   * Step-tree device-jump roster (phase 1): the node's ENABLED inference
   * devices, populated by the orchestrator ONLY when `deviceKey` is set and the
   * node has ≥2 enabled devices. The runner uses it to AUTO-jump an enrichment
   * step whose model has no build for the elected device's format onto another
   * enabled device of the SAME node (weighted-least-loaded). Absent/single-entry
   * ⇒ no jump possible; the step runs on `deviceKey`.
   */
  inferenceDevices: z.array(RunnerInferenceDeviceSchema).readonly().optional(),
})

/**
 * Per-device settings UI fields the runner cap owns. Co-located with
 * the Zod data schema so a single change to defaults / ranges /
 * options propagates to both the wire contract AND the rendered UI.
 *
 * Consumers spread this into their own ConfigUISchema sections
 * (e.g. orchestrator's deviceSettingsSchema) instead of redeclaring
 * the fields. The ranges are read from the `*Field` constants above
 * so values stay in sync with `RunnerCameraConfigSchema`.
 *
 * Fields NOT included here are intentional — they're either internal
 * wire (motionStreamId, detectionStreamId) or live in a different
 * config surface (priority, motionStreamProfile/detectionStreamProfile
 * — the orchestrator transforms them into stream IDs before dispatch).
 */
export const RunnerCameraDeviceUIFields: readonly ConfigField[] = [
  {
    key: 'motionSources',
    type: 'multiselect',
    label: 'Motion Sources',
    default: ['analyzer'],
    // `device-activity` is offered on every camera, defaulted on only where
    // the device can raise it (the orchestrator's `hasActivitySignal` ladder)
    // — a camera that never publishes `recording-signal` simply never fires it.
    options: MOTION_SOURCE_PICKER_ORDER.map((value) =>
      value === 'onboard'
        ? {
            value,
            label: MOTION_SOURCE_LABELS[value],
            description: "The camera's own motion, plus any sensor attached to it",
          }
        : { value, label: MOTION_SOURCE_LABELS[value] },
    ),
  },
  // `detectionSources` is deliberately NOT a field here: it is the first control
  // of the camera's Detection pipeline → Steps editor (read and written through
  // `pipeline-orchestrator.getCameraDetectionSource` / `setCameraDetectionSource`),
  // so there is one control for one authority (D62).
  // Analyzer-only knobs — gated on `motionSources` containing the
  // `analyzer` (frame-diff) source. When the operator picks
  // `onboard`-only (camera-native VMD), running an analyzer pipeline
  // would burn CPU for no signal, so we hide the FPS / cooldown /
  // stream-profile tuning entirely. The dependent section header in
  // the orchestrator reads "Frame-diff Analyzer" → these fields
  // disappear together when the source isn't selected.
  {
    key: 'motionFps',
    type: 'slider',
    label: 'Motion FPS (analyzer)',
    min: motionFpsField.min,
    max: motionFpsField.max,
    step: motionFpsField.step,
    default: motionFpsField.default,
    showValue: true,
    unit: 'fps',
    nullable: true,
    nullLabel: 'Default',
    showWhen: { field: 'motionSources', includes: 'analyzer' },
  },
  {
    key: 'detectionFps',
    type: 'slider',
    label: 'Detection FPS',
    min: detectionFpsField.min,
    max: detectionFpsField.max,
    step: detectionFpsField.step,
    default: detectionFpsField.default,
    showValue: true,
    unit: 'fps',
    // Nullable → the operator can pick "Default" (null) to track the field
    // default instead of pinning a number; the orchestrator resolves null →
    // detectionFpsField.default at dispatch.
    nullable: true,
    nullLabel: 'Default',
  },
  // Motion cooldown applies to BOTH analyzer and onboard sources —
  // every reportMotion(true) re-arms the cooldown regardless of the
  // emitting source, so the operator must be able to tune it for
  // onboard-only cameras too. Without this the field silently
  // disappeared when the user picked "Camera sensors" only.
  {
    key: 'motionCooldownMs',
    type: 'slider',
    label: 'Motion Cooldown',
    description:
      'Time without a fresh motion event before the active phase ends. Applies to all motion sources — every motion event re-arms the timer.',
    min: motionCooldownMsField.min,
    max: motionCooldownMsField.max,
    step: motionCooldownMsField.step,
    default: motionCooldownMsField.default,
    showValue: true,
    unit: 's',
    displayScale: 1000,
    nullable: true,
    nullLabel: 'Default',
  },
  // Session-hold cap: how long an on-motion detection session may be held
  // open past the cooldown while a subject is still being tracked but has
  // stopped re-triggering motion (a slow-moving car/person evades VMD). The
  // orchestrator resets the teardown clock each frame a non-stationary track
  // is seen, bounded by this cap so a lingering track can never pin the
  // session forever. "Default" tracks the field default; set to 0 to disable.
  {
    key: 'maxSessionHoldMs',
    type: 'slider',
    label: 'Max session hold',
    description:
      'Upper bound on how long detection keeps running past the motion cooldown while a subject is still moving in-frame but no longer triggering motion. Prevents the detection box from stopping on a slow-moving subject. Set to 0 to disable.',
    min: maxSessionHoldMsField.min,
    max: maxSessionHoldMsField.max,
    step: maxSessionHoldMsField.step,
    default: maxSessionHoldMsField.default,
    showValue: true,
    unit: 's',
    displayScale: 1000,
    nullable: true,
    nullLabel: 'Default',
  },
  // Audio quiet period — only rendered when the operator actually picked
  // `on-motion` audio. Camera-native motion has no falling edge, so this
  // timer (not a `detected:false`) is what ends the audio window; see the
  // schema field's doc comment.
  {
    key: 'audioMotionWindowMs',
    type: 'slider',
    label: 'Audio window after motion',
    description:
      'How long audio keeps being analysed after the last motion event. Each new motion event extends the window without restarting the audio stream.',
    min: audioMotionWindowMsField.min,
    max: audioMotionWindowMsField.max,
    step: audioMotionWindowMsField.step,
    default: audioMotionWindowMsField.default,
    showValue: true,
    unit: 's',
    displayScale: 1000,
    nullable: true,
    nullLabel: 'Default',
    showWhen: { field: 'audioMode', equals: 'on-motion' },
  },
  // Only meaningful for onboard-only cameras — when `motionSources`
  // contains `'analyzer'` the analyzer runs continuously already.
  {
    key: 'onboardMotionDrivesAnalyzer',
    type: 'boolean',
    label: 'Run motion analyzer on onboard motion',
    description:
      'When onboard motion is detected, temporarily start the frame-diff analyzer to emit zone results. Stops after the motion cooldown window.',
    default: true,
    showWhen: { field: 'motionSources', includes: 'onboard' },
  },
  // Master checkbox for the pre-roll pass; the frame budget below renders only
  // when it is on. ON by default (D411): the history is already requested,
  // served and decoded, and an operator cannot discover a switch whose absence
  // looks exactly like a camera that noticed the subject late.
  {
    key: 'preRollInferenceEnabled',
    type: 'boolean',
    style: 'checkbox',
    label: 'Detect in the pre-roll',
    description:
      'Run detection over the few seconds of footage the camera had already buffered when motion fired, so a subject that was in view before the trigger is found at the moment it appeared rather than seconds later. The burst is bounded and never delays live detection.',
    default: true,
  },
  {
    key: 'preRollInferenceFrames',
    type: 'slider',
    label: 'Pre-roll frames',
    description:
      'How many frames of buffered history may be detected on, per session. Higher samples the history more densely; 0 disables the pass.',
    min: preRollInferenceFramesField.min,
    max: preRollInferenceFramesField.max,
    step: preRollInferenceFramesField.step,
    default: preRollInferenceFramesField.default,
    showValue: true,
    showWhen: { field: 'preRollInferenceEnabled', equals: true },
  },
  {
    key: 'occupancyRecheckEnabled',
    type: 'boolean',
    style: 'checkbox',
    label: 'Occupancy re-check',
    description:
      'Periodically re-sample a few frames during the watching phase, so objects that are simply parked are still counted (motion gating alone loses them after a restart). On by default at a wide interval; turn it off on cameras where the extra decoder re-dial is expensive.',
    default: true,
  },
  {
    key: 'occupancyRecheckSec',
    type: 'slider',
    label: 'Occupancy re-check interval',
    description:
      'How often (in seconds) the runner re-samples a few frames to confirm the scene is truly empty during the watching phase.',
    min: occupancyRecheckSecField.min,
    max: occupancyRecheckSecField.max,
    step: occupancyRecheckSecField.step,
    default: occupancyRecheckSecField.default,
    showValue: true,
    unit: 's',
    showWhen: { field: 'occupancyRecheckEnabled', equals: true },
  },
  {
    key: 'occupancyRecheckFrames',
    type: 'slider',
    label: 'Occupancy re-check frames',
    description: 'Number of frames sampled per occupancy re-check burst.',
    min: occupancyRecheckFramesField.min,
    max: occupancyRecheckFramesField.max,
    step: occupancyRecheckFramesField.step,
    default: occupancyRecheckFramesField.default,
    showValue: true,
    showWhen: { field: 'occupancyRecheckEnabled', equals: true },
  },
] as const

/**
 * Runtime load summary returned by `getLocalLoad`. Used by the orchestrator's
 * load-balancing levels (L2 capacity-based, L3 hardware-aware) to decide
 * which agent should receive a new camera assignment.
 */
const RunnerLocalLoadSchema = z.object({
  /** Moleculer node id of this runner instance. */
  nodeId: z.string(),
  /** Total cameras currently attached (regardless of phase). */
  attachedCameras: z.number(),
  /** Cameras currently in `active` phase (running detection inference). */
  activeCameras: z.number(),
  /** Average inference FPS across all attached cameras. */
  avgInferenceFps: z.number(),
  /** Average inference latency in ms across all attached cameras. */
  avgInferenceTimeMs: z.number(),
  /** Total queue depth across motion + detection queues. */
  queueDepthTotal: z.number(),
  /**
   * Per-inference-device live load (multi-device C4). One entry per deviceKey
   * this runner currently has attached cameras on, so the orchestrator's second
   * `balance()` pass (over a node's devices) weights on real per-pool session
   * counts. Empty on single-device / pre-multi-device runners. There is no
   * per-device queue depth: the inference pool's backlog has no accessor, and
   * a field that always read 0 was removed rather than shown as a measurement
   * (D762).
   */
  devices: z
    .array(
      z.object({
        deviceKey: z.string(),
        backend: z.string(),
        attachedCameras: z.number(),
      }),
    )
    .default([]),
  /** Hardware capability flags reported by this node. */
  hardware: z.object({
    hasGpu: z.boolean(),
    inferenceBackend: z.string().optional(),
    cpuCores: z.number().optional(),
  }),
  /**
   * Who writes a camera's `motion` runtime slice (D696). `'orchestrator'`: this
   * runner never writes it. ABSENT = a runner older than D696, which still
   * writes the slice from its phase machine; the orchestrator does not write
   * while any runner node is absent-or-unanswered, so one slice never has two
   * writers.
   */
  motionSliceWriter: z.literal('orchestrator').optional(),
})

/**
 * Aggregate runtime metrics for the runner's whole local pool. Mirrors the
 * legacy `OrchestratorMetricsSchema` shape so existing dashboards keep
 * working unchanged when they switch to reading from the runner cap.
 */
const FrameLazyCountersSchema = z.object({
  framesDecoded: z.number(),
  framesAdmitted: z.number(),
  framesDroppedPixelFree: z.number(),
  viewsMaterialized: z.number(),
  viewsSkipped: z.number(),
  workerToRunnerBytes: z.number(),
  runnerToPoolRawBytes: z.number(),
  runnerToPoolJpegBytes: z.number(),
  onDemandFullFrameRequests: z.number(),
  onDemandCropRequests: z.number(),
  nativeHits: z.number(),
  nativeMisses: z.number(),
  tileHits: z.number(),
  tileMisses: z.number(),
  fallbackHits: z.number(),
  fallbackMisses: z.number(),
  retainedWritesAvoided: z.number(),
  residentRefs: z.number(),
  residentBytes: z.number(),
  releases: z.number(),
  evictions: z.number(),
  staleMisses: z.number(),
})

const FrameLazyMetricsSchema = z.object({
  node: FrameLazyCountersSchema,
  cameras: z.array(FrameLazyCountersSchema.extend({ deviceId: z.number() })),
})

const RunnerLocalMetricsSchema = z.object({
  nodeId: z.string(),
  activeCameras: z.number(),
  throttledCameras: z.number(),
  avgInferenceTimeMs: z.number(),
  queueDepth: z.number(),
  frameLazy: FrameLazyMetricsSchema.optional(),
})

/**
 * Pipeline Runner capability — runtime detection workhorse.
 *
 * One instance per node. Receives camera assignments from
 * `addon-pipeline-orchestrator`, subscribes to the local stream-broker for
 * decoded frames, drains motion + detection queues, calls the local
 * `motion-detection` and `pipeline-executor` capabilities, and emits typed
 * `pipeline.inference-result` and `detection.motion-analysis` events on
 * the bus.
 *
 * Distinct from `pipeline-orchestrator` (the hub-side load balancer) — the
 * runner has zero knowledge of other agents, no global state, and never
 * makes assignment decisions itself.
 */
/**
 * Why a runner declined to look at a camera out of band. Named rather than a
 * bare `false`: a camera asleep on battery (D173), one attached elsewhere, one
 * already mid-session and one already bursting are four different facts, and a
 * caller told only "no" cannot tell a protection from a bug.
 */
export const OccupancyBurstRefusalSchema = z.enum([
  'not-attached',
  'battery-asleep',
  'not-watching',
  'already-bursting',
])
export type OccupancyBurstRefusal = z.infer<typeof OccupancyBurstRefusalSchema>

export const pipelineRunnerCapability = {
  name: 'pipeline-runner',
  scope: 'system',
  mode: 'singleton',
  methods: {
    // ── Camera lifecycle (called by orchestrator) ────────────────────
    /** Attach a camera to this runner. Subscribes to local broker. */
    attachCamera: method(RunnerCameraConfigSchema, z.object({ success: z.literal(true) }), {
      kind: 'mutation',
    }),
    /** Detach a camera. Unsubscribes from local broker, clears queues. */
    detachCamera: method(
      z.object({ deviceId: z.number() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation' },
    ),
    /**
     * Report an external motion event for a camera. Drives the runner's
     * phase machine: every `detected: true` clears + rearms the
     * cooldown timer (`motionCooldownMs`); when the timer expires the
     * camera returns to `watching`. `detected: false` is a no-op —
     * onboard sources never send an explicit clear, the timer is the
     * single closure path.
     *
     * `source` discriminates which motion path triggered the event so
     * the runner can attach the right metadata to the cap-state event
     * (analyzer carries `regions[]`, onboard does not). `regions` is
     * populated only for `source: 'analyzer'` — the analyzer's
     * frame-diff result. Always-on cameras silently ignore
     * reportMotion calls.
     */
    reportMotion: method(ReportMotionInputSchema, z.object({ success: z.literal(true) }), {
      kind: 'mutation',
    }),

    // ── Observability (called by orchestrator + dashboards) ──────────
    /** Return load summary used by the orchestrator's load balancer. */
    getLocalLoad: method(z.void(), RunnerLocalLoadSchema),
    /** Return aggregate runtime metrics for this runner instance. */
    getLocalMetrics: method(z.void(), RunnerLocalMetricsSchema),
    /** Per-camera metrics for cameras attached to this runner. */
    getCameraMetrics: method(z.object({ deviceId: z.number() }), CameraMetricsSchema.nullable()),
    /** All per-camera metrics in one round-trip. */
    getAllCameraMetrics: method(z.void(), z.array(CameraMetricsWithDeviceIdSchema).readonly()),
    /** List the deviceIds currently attached to this runner. */
    getLocalCameras: method(z.void(), z.array(z.number()).readonly()),

    /**
     * Look at a camera NOW, out of band, because something just happened that
     * only a fresh look can settle.
     *
     * The periodic recheck (`occupancyRecheckSec`, 300 s) exists to watch a
     * still scene. It is the wrong instrument for a QUESTION that has just been
     * asked: on device 102 a parked car's departure was observed, a departure
     * strike was armed — and then the motion session ended, the strike decayed
     * after its 30 s TTL, and the next periodic look arrived up to five minutes
     * later with nothing left to confirm. Every one of those departures was
     * settled by the entry ageing out 6 to 10 minutes of observed time later,
     * and the notification's clip showed an empty space with nothing leaving
     * it.
     *
     * Two numbers make the ask specific, and a caller that ignores them wastes
     * the burst: a confirmation must land at least
     * `DEPARTURE_CONFIRM_MIN_GAP_MS` (3 s) after the read that armed the
     * strike — before that it is the same optical event and is refused — and
     * `DEPARTURE_ABSENCE_MIN_READS` (5) consecutive unassociated frames are
     * needed, while `occupancyRecheckFrames` defaults to FOUR. A burst of four
     * can never confirm an absence; that is why two periodic looks were always
     * required.
     *
     * The runner answers whether it actually started one. A refusal is NAMED,
     * never a silent `false`: a camera that is asleep on battery (D173 — this
     * must not become a self-initiated wake), detached, mid-session or already
     * bursting are four different facts, and a caller told only "no" cannot
     * tell a protection from a bug.
     */
    requestOccupancyBurst: method(
      z.object({
        deviceId: z.number(),
        /** How many frames to collect. The caller sizes this against what its
         *  own confirmation needs; the runner clamps it to the field's range. */
        frames: z.number().int().positive().optional(),
        /** Why, for the log. A burst nobody can attribute is a cost nobody can
         *  defend — the periodic one at least has a timer to point at. */
        reason: z.string(),
      }),
      z.object({
        started: z.boolean(),
        refusedBecause: OccupancyBurstRefusalSchema.optional(),
      }),
      // A mutation: it starts a decode dial and spends inference. A query that
      // does that is a query in name only, and the access map reads `kind` to
      // decide who may call it.
      { auth: 'admin', kind: 'mutation' },
    ),

    /**
     * Best-effort NATIVE-resolution crop of a retention-ring frame. Given the
     * `FrameHandle` that rode an inference-result event and a normalized `bbox`,
     * the runner asks the decode worker still holding that frame's NATIVE
     * surface to GPU/CPU-crop ONLY the ROI at native res and download just the
     * crop. Routed to the frame's owning node by `handle.nodeId`; NEVER ships a
     * full native frame.
     *
     * Miss behaviour differs by request shape (see `NativeCropResultSchema.tier`):
     * - an ROI (subject-crop) miss returns `null` — the caller reports the miss
     *   and retries; it is NEVER handed a ≤640 crop masquerading as native.
     * - a FULL-FRAME miss falls back to the ≤640 RAM `RetainedFrameStore`, tagged
     *   `tier: 'ram-fullframe'` (honest lower-res for the blank-frame guard /
     *   640-snapshot resolve). A native hit is tagged `tier: 'native'`.
     */
    getNativeCrop: method(
      z.object({
        handle: FrameHandleSchema,
        bbox: NativeCropBboxSchema,
        maxWidth: z.number().int().positive().optional(),
        /**
         * The caller reads a `Uint8Array` (D462). When set, a JPEG answer comes
         * back in `jpegBytes` instead of base64 `jpeg`. Absent means the old
         * wire — never assume consent: a pre-D462 caller parses the field as
         * base64 and bytes would decode to garbage rather than fail.
         */
        acceptJpegBytes: z.boolean().optional(),
        /**
         * When `true`, the runner encodes the resolved crop to JPEG ON THE
         * OWNING NODE and returns it in `jpeg` (base64) INSTEAD of raw `bytes`.
         * Callers set this for CROSS-NODE fetches (`handle.nodeId` is a remote
         * agent) so the compressed payload fits Moleculer's `maxPacketSize` and
         * no raw pixels cross the process boundary. Same-node callers omit it
         * and keep the zero-copy raw `bytes` path. Additive + optional: a
         * pre-encode runner (version skew) ignores it and returns `bytes`, so
         * the caller falls back to encoding locally.
         */
        encodeJpeg: z.boolean().optional(),
      }),
      NativeCropResultSchema.nullable(),
    ),

    /**
     * Two-plane design: run the DETAIL subtree (crop children —
     * embedding, classifier, refiner steps whose `inputClasses ≠ null`)
     * for a single tracked detection. The per-frame plane (`runPipeline`
     * with `plane: 'frame'`) skips crop children entirely; a track-level
     * caller invokes this per-track, on its own cadence, instead of on
     * every frame. `steps` narrows which configured children to run
     * (default: all configured children for `parent.className`).
     *
     * ## Three pixel sources, and WHO decides the rectangle
     *
     * Tried in this order; the difference between them is not the pixels but
     * which side derives the crop, and confusing the two is how the CLIP index
     * ended up holding two incomparable feature spaces:
     *
     * 1. `frameHandle` — shm lease/session, preferred and zero-copy. **The
     *    runner cuts**, applying the cluster crop convention.
     * 2. `frameJpeg` — a FULL FRAME supplied by the caller (the embedding
     *    rebuild's stored key frame). **The runner cuts**, applying the same
     *    convention to the same function, so a rebuilt vector lands in the same
     *    feature space as a live one.
     * 3. `cropJpeg` — an ALREADY-CUT tile. **The caller decided the
     *    rectangle**; the runner applies NO padding and no squaring and feeds
     *    it to the model verbatim. Only for the lease-miss retry, where the
     *    caller holds pixels the runner can no longer reach.
     *
     * Returns `null` when no source resolves (handle evicted and no fallback
     * supplied), when the camera is not attached, or when no enabled step
     * matches — every one of those is logged on the runner with the deviceId.
     */
    runDetailSubtree: method(
      z.object({
        deviceId: z.number(),
        frameHandle: FrameHandleSchema.optional(),
        /**
         * FULL FRAME (base64 JPEG). The runner derives the crop rectangle from
         * `parent.bbox` with the cluster crop convention and cuts it itself —
         * do NOT pre-crop for this field, that is what `cropJpeg` is.
         */
        frameJpeg: z.string().optional(),
        /**
         * PRE-CUT tile (base64 JPEG), used verbatim — NO padding is applied.
         * The fallback when the lease/session backing the frame is gone and the
         * caller already holds a crop.
         */
        cropJpeg: z.string().optional(),
        parent: DetailParentSchema,
        steps: z.array(z.string()).optional(), // subset filter; default = all configured children
        /**
         * The camera's root model already drew this step's boxes (D730): a
         * `license_plate` inside the parent vehicle. The named step is NOT
         * inferred — these FRAME-space boxes are its output — and its
         * requested children (the plate reader) run on them. Absent ⇒ every
         * requested step infers as before.
         */
        supplied: z
          .object({
            stepId: z.string(),
            modelId: z.string(),
            boxes: z.array(z.object({ bbox: NativeCropBboxSchema, score: z.number() })).min(1),
          })
          .optional(),
      }),
      z.object({ details: z.array(DetailResultSchema) }).nullable(),
      { kind: 'mutation' },
    ),

    /**
     * Run ONE enrichment step against caller-supplied pixels, with NO camera
     * session — no attach, no frame handle, no device affinity.
     *
     * ## Why this exists next to `runDetailSubtree` and not inside it
     *
     * `runDetailSubtree` resolves its step tree from the LIVE ATTACH STATE. That
     * is correct for it: its reason to exist is a frame HANDLE, and a handle is
     * only resolvable while a decode session is open. But it makes the method
     * useless to anything walking history — cameras run `detectionMode:
     * 'on-motion'` and detach ~30 s after motion stops, so a fleet-wide
     * embedding rebuild found most cameras detached and rebuilt only whatever
     * happened to be attached at that second (measured 2026-08-06: 1125 tracks
     * scanned, 121 rebuilt, 601 refused as "camera is not attached").
     *
     * A caller that ships its own pixels needs none of that machinery. So this
     * method takes the three things a step actually needs — an image, a box, a
     * step id — resolves the step from the CATALOG rather than from an
     * attachment, and runs it on whichever node the caller pinned.
     *
     * ## What it deliberately keeps
     *
     * The crop rectangle is derived by the SAME `deriveDetailCropRect` call the
     * live detail plane uses, from the same cluster-wide convention
     * ([D52](../../../docs/decisions/adr-0052.md)). `frameJpeg` is a FULL frame,
     * never a pre-cut tile, for exactly the reason `runDetailSubtree` documents:
     * a caller that cuts is a second feature space.
     *
     * ## What it deliberately drops
     *
     * No device jump and no `deviceKey`: the jump roster comes from the attach
     * config, which does not exist here. The step runs on the node's default
     * engine. This is a maintenance path, not a latency-sensitive one.
     *
     * ## Routing
     *
     * NOT device-bound. `sourceDeviceId` is DIAGNOSTIC — the camera whose track
     * these pixels came from, so every log line on the executing node can carry
     * `tags: { deviceId }`. It is deliberately not named `deviceId`: that field
     * is a routing hint that would send the call to the camera's owning node,
     * which is the placement constraint this method exists to remove. Callers
     * choose the node with `nodePin(nodeId)`; unpinned, an unowned call is
     * served hub-in-process like any other singleton.
     */
    runStatelessStep: method(
      z.object({
        /** Catalog step id, e.g. `clip-embedding`. */
        stepId: z.string(),
        /**
         * REQUIRED model pin. The node runs this exact model or refuses with
         * `model-not-servable` — it never substitutes a format default, because
         * a fleet pass that round-robins across nodes would then fill one index
         * from several encoders.
         */
        modelId: z.string(),
        /** FULL FRAME, base64 JPEG. The runner cuts — do NOT pre-crop. */
        frameJpeg: z.string(),
        /**
         * The subject box, NORMALISED [0,1] against `frameJpeg`. Normalised on
         * purpose: the caller stores boxes against a downscaled analysis frame
         * while the stored key frame is native-resolution, and the only side
         * that reliably knows the image's pixel dimensions is the side that
         * decodes it. Denormalising here removes a second reader of the
         * dimensions and the class of mismatch that comes with it.
         */
        bbox: NativeCropBboxSchema,
        /** Parent class of the subject (`person`, `vehicle`, …) — carried into the result. */
        className: z.string(),
        /** Camera the pixels came from. Diagnostics + log tags ONLY — never routing. */
        sourceDeviceId: z.number(),
      }),
      RunStatelessStepResultSchema,
      { kind: 'mutation' },
    ),

    /**
     * PARK a frame for a track at the instant it is judged to matter
     * ([D422](../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)).
     *
     * The hub's `BestDetectionTracker` — the single "best per track" policy —
     * concludes a frame is a track's best and calls this on the node that
     * owns `handle` (`nodePin(handle.nodeId)`), while the handle is young. The
     * runner cuts `bbox` from the native surface it already holds (a full
     * frame for `keyFrame`, the caller's subject window for `thumbnail`),
     * encodes ONE JPEG, and keeps it under `(deviceId, trackId, kind)`. Every
     * later consumer retrieves by that key (`getParkedTrackFrame`) — a lookup
     * that cannot miss on age. D52 holds: the rectangle is cut by the runner,
     * never a pre-cut tile the caller decided. D9/D18 hold: one compressed
     * encode at a decision point, never a stream.
     *
     * Idempotent per `(trackId, kind)`: a later park replaces (the ranking is
     * the hub's; this adds no second opinion), an out-of-order older instant
     * is ignored. Bounded per device and per node on the runner
     * (`parked-frame-store.ts`), oldest-first eviction, never a refusal for
     * space. A refusal names its reason and is logged on the runner with the
     * handle's measured age — it is never retried into a loop.
     */
    parkTrackFrame: method(
      z.object({
        deviceId: z.number(),
        /** Opaque to the runner — the hub's track id. */
        trackId: z.string(),
        kind: ParkedFrameKindSchema,
        handle: FrameHandleSchema,
        /** Normalized [0,1] window to cut. `{0,0,1,1}` for a full frame. */
        bbox: NativeCropBboxSchema,
        /** Width cap for a full-frame park (the `keyFrame` native cap). */
        maxWidth: z.number().int().positive().optional(),
        /** The frame instant (caller's clock) — orders parks for one key. */
        timestamp: z.number(),
      }),
      ParkTrackFrameResultSchema,
      { kind: 'mutation' },
    ),

    /**
     * Retrieve a parked parcel by `(deviceId, trackId, kind)`. Pinned to the
     * node that answered the park (`ParkTrackFrameResult.nodeId`). `null` means
     * nothing was parked under that key on this node — never "too old".
     */
    getParkedTrackFrame: method(
      z.object({
        deviceId: z.number(),
        trackId: z.string(),
        kind: ParkedFrameKindSchema,
        /**
         * The caller reads a `Uint8Array` (D462). When set, a JPEG answer comes
         * back in `jpegBytes` instead of base64 `jpeg`. Absent means the old
         * wire — never assume consent: a pre-D462 caller parses the field as
         * base64 and bytes would decode to garbage rather than fail.
         */
        acceptJpegBytes: z.boolean().optional(),
      }),
      ParkedTrackFrameSchema.nullable(),
    ),

    /**
     * Drop every parcel of a track — the hub closed it. Idempotent. A track
     * whose release is lost ages out on the runner under a hard ceiling.
     */
    releaseParkedTrackFrames: method(
      z.object({ deviceId: z.number(), trackId: z.string() }),
      z.object({ released: z.number().int().nonnegative() }),
      { kind: 'mutation' },
    ),

    // ── Node benchmark measurement (D791) ─────────────────────────────
    /**
     * Start measuring THIS node for the orchestrator's node benchmark: the
     * bench clip decoded once into RAM, each device × candidate detector on an
     * open-loop ramp (`device`), then the chosen pipeline with the requested
     * detail steps (`pipeline`). Everything runs in-process with the executor
     * — no frame crosses a node (D9) — and writes nothing: no track, event,
     * media or notification. Reached by `nodePin(nodeId)`. Answers at once;
     * one run per node; the run stops itself at `deadlineAtMs`.
     */
    startNodeBench: method(
      NodeBenchRunnerInputSchema,
      z.object({ accepted: z.literal(true), runId: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The run's progress and every finished cell; null when this runner does not know `runId`. */
    getNodeBenchStatus: method(
      z.object({ runId: z.string() }),
      NodeBenchRunnerStatusSchema.nullable(),
      { auth: 'admin' },
    ),
    /** Stop the run; what it finished is kept. */
    abortNodeBench: method(z.object({ runId: z.string() }), z.object({ aborted: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // NOTE: Phase 6 (settings redesign) removed `getTuning` / `setTuning`.
    // The four tuning fields are now exposed via the addon-level settings
    // API (`pipeline-runner.getAddonSettings / updateAddonSettings`) and
    // rendered in the admin UI via `NodeAddonsSettingsPanel` instead of
    // the dedicated `NodeTuningTab` that used to call these cap methods.
  },
} as const satisfies CapabilityDefinition

export type IPipelineRunnerProvider = InferProvider<typeof pipelineRunnerCapability>

/**
 * Named input/output types for `runDetailSubtree`, derived from the cap
 * definition above (`InferProvider`) rather than a standalone exported zod
 * schema — the method's input stays an INLINE `z.object({...})` literal so
 * `scripts/lib/parse-cap.ts`'s `deviceBound` regex (which only scans a
 * method's own inline call body for `deviceId: z.number(`) keeps detecting
 * it as device-bound and `generate-device-proxy.ts` keeps mounting it on
 * `DeviceProxy.pipelineRunner`. Extracting the input into a separate named
 * schema constant (as `RunnerCameraConfigSchema` does for `attachCamera`)
 * would silently drop it from the device proxy — verified via `npm run
 * codegen` while implementing this cap.
 */
export type RunDetailSubtreeInput = Parameters<IPipelineRunnerProvider['runDetailSubtree']>[0]
export type RunDetailSubtreeResult = NonNullable<
  Awaited<ReturnType<IPipelineRunnerProvider['runDetailSubtree']>>
>

/**
 * Named input/output types for `runStatelessStep`, derived the same way and for
 * the same reason as the `runDetailSubtree` pair above — the method's input
 * stays an inline `z.object({…})` literal so `scripts/lib/parse-cap.ts` keeps
 * classifying it correctly. Here the classification wanted is the OPPOSITE one:
 * there is no `deviceId: z.number(` in the body, so the method is NOT
 * device-bound and never lands on `DeviceProxy` — placement is the caller's
 * `nodePin`, not the camera's owner.
 */
export type RunStatelessStepInput = Parameters<IPipelineRunnerProvider['runStatelessStep']>[0]
export type RunStatelessStepResult = Awaited<
  ReturnType<IPipelineRunnerProvider['runStatelessStep']>
>

export {
  FrameLazyCountersSchema,
  FrameLazyMetricsSchema,
  RunnerCameraConfigSchema,
  RunnerLocalLoadSchema,
  RunnerLocalMetricsSchema,
}
