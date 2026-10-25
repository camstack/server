/**
 * The tracking tape, schema v2 (D681, spec §3.2–§3.6; v2 by D683 §8.3 — the
 * model-free appearance descriptor `app` and the L2 `fusion` record).
 *
 * A tape is what the hub's tracker was GIVEN, pixel-free: boxes, classes,
 * scores, relative time, the gate's decisions and what the live tracker did.
 * Every object is `z.strictObject`: an unknown key is refused, never carried.
 * That is the whole privacy mechanism of a tape committed to a public repo —
 * a field added to `FrameResult` later (a descriptor, a crop) cannot reach a
 * tape unless someone whitelists it here AND bumps `TAPE_VERSION`.
 *
 * Absolute time is NOT in the schema: a hub segment's origin lives in its file
 * name, and every record carries `t` relative to it. The hour of day was
 * removed by the operator (decision 12); `lighting` is all a tape says about
 * the light.
 */
import { APPEARANCE_BIN_COUNT, DetectionSourceSchema } from '@camstack/types'
import { z } from 'zod'
import { DetectionSensitivitySettingsSchema } from '../detection-sensitivity-settings.js'
import { RETIRED_TRACKING_KEYS, TrackingSettingsSchema } from '../tracking-settings.js'
import { TRACK_DROP_REASONS } from '../pipeline/tracker-v2/types.js'

export const TAPE_FORMAT = 'camstack-tracking-tape'
export const TAPE_VERSION = 2
/** The recorder's id on every header. The addon carries no version at runtime;
 *  the import date is recorded in the fixture's `manifest.json`. */
export const TAPE_RECORDER_ID = 'pipeline-analytics/tape-recorder'

const TapeBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])
export type TapeBox = z.infer<typeof TapeBoxSchema>

/** The planes a processor runs on — the production enum, not a copy. */
export const TapePlaneSchema = DetectionSourceSchema
export type TapePlane = z.infer<typeof TapePlaneSchema>

export const TapeLightingSchema = z.enum(['day', 'ir'])
export type TapeLighting = z.infer<typeof TapeLightingSchema>

/** `h:<12 hex>` on a hub segment, `p<n>` on a promoted/committed tape (§3.6). */
const TapeFaceIdSchema = z.string().regex(/^(h:[0-9a-f]{12}|p[1-9][0-9]*)$/)
/** The only face ids a COMMITTED tape may carry. */
export const COMMITTED_FACE_ID = /^p[1-9][0-9]*$/

/** What a processor is built from — the production settings schemas, strict. */
const TapeProcessorInputsSchema = z.strictObject({
  sensitivity: z.strictObject(DetectionSensitivitySettingsSchema.shape),
  tracking: z.strictObject(TrackingSettingsSchema.shape),
  stillSpeedFracPerSec: z.number().optional(),
})
export type TapeProcessorInputs = z.infer<typeof TapeProcessorInputsSchema>

const TapeZoneSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['polygon', 'tripwire']),
  polygon: z.array(z.strictObject({ x: z.number(), y: z.number() })),
})
export type TapeZone = z.infer<typeof TapeZoneSchema>

const TapeZoneRuleSchema = z.strictObject({
  id: z.string(),
  zoneIds: z.array(z.string()).min(1),
  mode: z.enum(['include', 'exclude']),
  classFilter: z.array(z.string()).optional(),
  overlapThreshold: z.number().optional(),
  bboxInclusionPct: z.number().optional(),
  preferMask: z.boolean().optional(),
  enabled: z.boolean(),
})
export type TapeZoneRule = z.infer<typeof TapeZoneRuleSchema>

const TapeSceneSchema = z.strictObject({
  zones: z.array(TapeZoneSchema),
  rules: z.array(TapeZoneRuleSchema),
  zoneMembershipMinOverlap: z.number(),
  lowScoreFloor: z.number().nullable(),
})
export type TapeScene = z.infer<typeof TapeSceneSchema>

const TapeStationaryEntrySchema = z.strictObject({
  id: z.string(),
  cls: z.string(),
  b: TapeBoxSchema,
  /** `becameStationaryAt` relative to the file's origin — usually negative. */
  since: z.number(),
})
export type TapeStationaryEntry = z.infer<typeof TapeStationaryEntrySchema>

/** A recorder session id: 16 lower-case hex characters (64 random bits). */
const TapeSessionSchema = z.string().regex(/^[0-9a-f]{16}$/)

export const TapeHeaderSchema = z.strictObject({
  kind: z.literal('header'),
  format: z.literal(TAPE_FORMAT),
  version: z.literal(TAPE_VERSION),
  tapeId: z.string().min(1),
  deviceId: z.number().int().positive(),
  lighting: TapeLightingSchema,
  recorder: z.string(),
  planes: z.strictObject({
    pipeline: TapeProcessorInputsSchema.optional(),
    onboard: TapeProcessorInputsSchema.optional(),
  }),
  scene: TapeSceneSchema,
  stationaryEntries: z.array(TapeStationaryEntrySchema),
  /**
   * (Task 12 fix round, H1) The recorder SESSION a segment was written in: a
   * random id minted once per recorder start (one per boot), carrying no time
   * and no node. A promotion reads a change of session between consecutive
   * segments as a `restart` gap whatever the previous segment's end reason —
   * a rotation closes a segment `segment-end`, and a boot that dies before
   * the camera's next frame writes no `addon-stopped` after it. Every segment
   * carries it; a PROMOTED tape omits it, because its session changes have
   * already become `restart` gaps in its body. Added under v1: no tape had
   * been written.
   */
  session: TapeSessionSchema.optional(),
})
export type TapeHeader = z.infer<typeof TapeHeaderSchema>

export const TapeDetectionSchema = z.strictObject({
  id: z.string(),
  k: z.enum(['first-level', 'detail']),
  cls: z.string(),
  ocls: z.string().optional(),
  ot: z.union([z.literal(1), z.literal(2)]).optional(),
  s: z.number(),
  b: TapeBoxSchema,
  src: z.enum(['frame', 'recovery', 'onboard']),
  /** Native recovery evidence: `[score, cropSidePx, viewPx]`. */
  nr: z.tuple([z.number(), z.number(), z.number()]).optional(),
  pid: z.string().optional(),
  fid: TapeFaceIdSchema.optional(),
  fs: z.number().optional(),
  /**
   * (v2, D683 §8.3) The model-free appearance descriptor
   * (`ObjectDetection.appearance`): `v` its version, `b` its
   * {@link APPEARANCE_BIN_COUNT} quantised bins, `g` the grey flag. A vector
   * about a box, never pixels, and no learned weights (O6) — which is why it
   * may be committed. Absent when the runner computed none.
   */
  app: z
    .strictObject({
      v: z.literal(1),
      b: z.array(z.number().int().min(0).max(255)).length(APPEARANCE_BIN_COUNT),
      g: z.boolean(),
    })
    .optional(),
})
export type TapeDetection = z.infer<typeof TapeDetectionSchema>

const TapeDiscardSchema = z.strictObject({
  b: TapeBoxSchema,
  cls: z.string(),
  s: z.number(),
  r: z.enum(['class-filter', 'below-threshold', 'full-frame-guard', 'zone-gate']),
})
export type TapeDiscard = z.infer<typeof TapeDiscardSchema>

const TapeGateSchema = z.strictObject({
  strong: z.array(z.strictObject({ det: z.string(), entry: z.string().optional() })),
  weak: z.array(z.string()),
  confirmed: z.array(z.string()),
  woken: z.array(z.string()),
})
export type TapeGate = z.infer<typeof TapeGateSchema>

export const TapeLiveSchema = z.strictObject({
  trk: z.string(),
  det: z.string().optional(),
  m: z.boolean(),
  st: z.enum(['new', 'entered', 'left', 'moving', 'idle']),
  rs: z.enum(['sole-subject', 'sole-subject-veto-lifted', 'multi-subject']).optional(),
  lsh: z.literal(true).optional(),
})
export type TapeLive = z.infer<typeof TapeLiveSchema>

export const TapeFrameSchema = z.strictObject({
  kind: z.literal('frame'),
  t: z.number(),
  plane: TapePlaneSchema,
  w: z.number(),
  h: z.number(),
  rootModelId: z.string().optional(),
  shed: z.literal(true).optional(),
  /**
   * The `package-detection` step RAN on this frame (`FrameResult.
   * packageLooked`, D687) — what makes an empty doormat on a tape an absence
   * rather than silence. Absent when it did not run. Added under v1: optional,
   * and a tape written before it simply never attests a look.
   */
  pl: z.literal(true).optional(),
  dets: z.array(TapeDetectionSchema),
  disc: z.array(TapeDiscardSchema),
  inj: z.array(z.string()),
  gate: TapeGateSchema.optional(),
  live: z.array(TapeLiveSchema),
})
export type TapeFrame = z.infer<typeof TapeFrameSchema>

const TapeSkipSchema = z.strictObject({
  kind: z.literal('skip'),
  t: z.number(),
  plane: TapePlaneSchema,
  w: z.number(),
  h: z.number(),
  dets: z.array(TapeDetectionSchema),
  disc: z.array(TapeDiscardSchema),
  reason: z.literal('dropout'),
})
export type TapeSkip = z.infer<typeof TapeSkipSchema>

const TapeProcessorRecordSchema = z.strictObject({
  kind: z.literal('processor'),
  t: z.number(),
  plane: TapePlaneSchema,
  inputs: TapeProcessorInputsSchema,
  reason: z.enum(['created', 'rebuilt']),
})
export type TapeProcessorRecord = z.infer<typeof TapeProcessorRecordSchema>

const TapeSceneRecordSchema = z.strictObject({
  kind: z.literal('scene'),
  t: z.number(),
  scene: TapeSceneSchema,
})
export type TapeSceneRecord = z.infer<typeof TapeSceneRecordSchema>

/** Why the processor ended the chain (D683 round 4): 'dropped' (never
 *  linked) or 'stationary' (a promoted subject that moved; linkable at its
 *  last sighting) — parsed against the ONE list live's `TrackDropReason`
 *  is derived from (review M3). v1's `'stationary-promotion'` is upcast. */
const TapeDropReasonSchema = z.enum(TRACK_DROP_REASONS)
const TapeDropSchema = z.strictObject({
  kind: z.literal('drop'),
  t: z.number(),
  plane: TapePlaneSchema,
  trk: z.string(),
  reason: TapeDropReasonSchema,
})
export type TapeDrop = z.infer<typeof TapeDropSchema>

/**
 * The face recognizer's verdict on a live track (§3.6): settled on an identity
 * (`fid`, the same pseudonym vocabulary as `dets[].fid`) or had it taken back
 * (`fid: null`). Identity is decided per TRACK in post-analysis, never on the
 * runner's face detail, so this — not a frame's `fid` — is where the "two
 * different recognised faces" cannot-link comes from. `trk` joins `live[].trk`.
 */
const TapeIdentitySchema = z.strictObject({
  kind: z.literal('identity'),
  t: z.number(),
  trk: z.string(),
  fid: TapeFaceIdSchema.nullable(),
})
export type TapeIdentity = z.infer<typeof TapeIdentitySchema>

/**
 * (v2, D683) An L2 fusion the LIVE tracker committed between frames: the
 * chain `members` (live provisional ids) now answers to `survivor`, and
 * `absorbed` is the root it took over. Every id is a LIVE id, like
 * `drop.trk` — recorded, never remapped. `t` is the fusion's own frame time.
 */
const TapeFusionSchema = z.strictObject({
  kind: z.literal('fusion'),
  t: z.number(),
  plane: TapePlaneSchema,
  survivor: z.string(),
  absorbed: z.string(),
  members: z.array(z.string()).min(1),
})
export type TapeFusion = z.infer<typeof TapeFusionSchema>

const TapeGapSchema = z.strictObject({
  kind: z.literal('gap'),
  fromT: z.number(),
  toT: z.number(),
  reason: z.enum(['backpressure', 'restart']),
})
export type TapeGap = z.infer<typeof TapeGapSchema>

const TapeEndSchema = z.strictObject({
  kind: z.literal('end'),
  durationMs: z.number(),
  frames: z.number().int(),
  skips: z.number().int(),
  gaps: z.number().int(),
  /** `recorder-error` (Task 10 fix round): the recorder threw inside an open
   *  segment and ended it rather than resume after a silent hole. Like every
   *  reason other than `segment-end`/`size-cap`, a promotion reads the silence
   *  after it as a `restart` gap. Added under v1: no tape had been written. */
  reason: z.enum([
    'segment-end',
    'size-cap',
    'switched-off',
    'addon-stopped',
    'window-end',
    'recorder-error',
  ]),
})
export type TapeEnd = z.infer<typeof TapeEndSchema>
export type TapeEndReason = TapeEnd['reason']

const TapeRecordSchema = z.discriminatedUnion('kind', [
  TapeHeaderSchema,
  TapeFrameSchema,
  TapeSkipSchema,
  TapeProcessorRecordSchema,
  TapeSceneRecordSchema,
  TapeDropSchema,
  TapeIdentitySchema,
  TapeFusionSchema,
  TapeGapSchema,
  TapeEndSchema,
])
export type TapeRecord = z.infer<typeof TapeRecordSchema>
export type TapeBodyRecord =
  | TapeFrame
  | TapeSkip
  | TapeProcessorRecord
  | TapeSceneRecord
  | TapeDrop
  | TapeIdentity
  | TapeFusion
  | TapeGap
/**
 * (Task 19 fix round 1, M1.) `TapeIdentity` joins this union so `replayTape`
 * can hand it to `TapeTracker.control` — a tracker needs it to resolve a
 * face-recognizer cannot-link onto the LIVE tracklet it names (`trk`),
 * which nothing else on this union carries. See the narrow `live[]`
 * exception in `trackers/tape-tracker.ts`.
 */
/** (v2, D683) `TapeFusion` joins it too: a fusion is what the live tracker
 *  decided between frames — `RecordedTracker` reports it, `ProcessorTracker`
 *  recomputes its own and ignores it. */
export type TapeControlRecord =
  | TapeProcessorRecord
  | TapeSceneRecord
  | TapeDrop
  | TapeIdentity
  | TapeFusion

/** A version with no upcaster. Named, so an old reader says WHY it refused. */
export class TapeVersionError extends Error {
  constructor(readonly version: number) {
    super(`tracking tape version ${String(version)} has no upcaster in this reader`)
    this.name = 'TapeVersionError'
  }
}

/** A function per readable version that lifts a raw record to the CURRENT
 *  shape, keyed by the version the record was WRITTEN at. v2 is current. */
type TapeUpcaster = (raw: unknown) => unknown
const identity: TapeUpcaster = (raw) => raw

const V1HeaderPeekSchema = z.looseObject({ kind: z.literal('header') })
const V1ProcessorPeekSchema = z.looseObject({ kind: z.literal('processor') })
/** v1's only drop reason: every v1 promotion DISPOSED its track, which was
 *  therefore never linked — `'dropped'` today (D683 Task 14, review H1). */
const V1PromotionDropPeekSchema = z.looseObject({
  kind: z.literal('drop'),
  reason: z.literal('stationary-promotion'),
})
const V1_PROMOTION_DROP_REASON = 'dropped' satisfies (typeof TRACK_DROP_REASONS)[number]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strip every {@link RETIRED_TRACKING_KEYS} key from a raw `tracking` blob
 * (Task 13, D683: a committed tape must stay readable across the retirement).
 * Pure — returns a new object, never mutates `tracking`. A malformed
 * `tracking` (not a plain object) is returned unchanged so the strict parse
 * that follows reports the real fault, not a miscast one.
 */
function stripRetiredTrackingKeys(tracking: unknown): unknown {
  if (!isPlainRecord(tracking)) return tracking
  const next: Record<string, unknown> = { ...tracking }
  for (const key of RETIRED_TRACKING_KEYS) delete next[key]
  return next
}

/** Strip retired tracking keys from a raw `TapeProcessorInputs`-shaped value
 *  (`{ sensitivity, tracking, stillSpeedFracPerSec? }`), pure. */
function stripProcessorInputsTracking(inputs: unknown): unknown {
  if (!isPlainRecord(inputs)) return inputs
  return { ...inputs, tracking: stripRetiredTrackingKeys(inputs.tracking) }
}

/** Strip retired tracking keys from a raw header's `planes.pipeline` /
 *  `planes.onboard`, pure. A plane absent from the raw header stays absent. */
function stripPlanesTracking(planes: unknown): unknown {
  if (!isPlainRecord(planes)) return planes
  const next: Record<string, unknown> = { ...planes }
  if ('pipeline' in planes) next.pipeline = stripProcessorInputsTracking(planes.pipeline)
  if ('onboard' in planes) next.onboard = stripProcessorInputsTracking(planes.onboard)
  return next
}

/**
 * v1 → v2 (D683): a header comes back with `version: 2` and its retired
 * tracking keys stripped from every plane it carries; a `processor` record
 * (Task 12's `kind: 'processor'`, written at v1 like everything before this
 * change) has them stripped from `inputs.tracking`. Every other record is
 * unchanged — v2's new fields (`app`, the `fusion` record) are optional or
 * new, so a v1 record is already v2-shaped otherwise. A v1 `drop` carried
 * `'stationary-promotion'`, the one reason v1 had; it reads as `'dropped'`.
 */
const upcastV1: TapeUpcaster = (raw) => {
  const header = V1HeaderPeekSchema.safeParse(raw)
  if (header.success) {
    return {
      ...header.data,
      version: TAPE_VERSION,
      planes: stripPlanesTracking(header.data.planes),
    }
  }
  const processor = V1ProcessorPeekSchema.safeParse(raw)
  if (processor.success) {
    return { ...processor.data, inputs: stripProcessorInputsTracking(processor.data.inputs) }
  }
  const drop = V1PromotionDropPeekSchema.safeParse(raw)
  if (drop.success) return { ...drop.data, reason: V1_PROMOTION_DROP_REASON }
  return raw
}

const TAPE_UPCASTERS: ReadonlyMap<number, TapeUpcaster> = new Map([
  [1, upcastV1],
  [2, identity],
])

/** Parse one raw record written at `version`. Throws on anything not v2-shaped. */
export function parseTapeRecord(raw: unknown, version: number): TapeRecord {
  const upcast = TAPE_UPCASTERS.get(version)
  if (upcast === undefined) throw new TapeVersionError(version)
  return TapeRecordSchema.parse(upcast(raw))
}
