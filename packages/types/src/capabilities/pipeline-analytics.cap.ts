import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { PeerBytesTicketSchema } from '../interfaces/addon-peer-bytes.js'
import {
  BirthDecisionQueryInputSchema,
  BirthDecisionRecordSchema,
} from '../interfaces/birth-decision-ledger.js'
import {
  ArchivedDebugNoteQueryInputSchema,
  ArchivedDebugNoteSchema,
} from '../interfaces/debug-note-archive.js'
import {
  OpsLogEntrySchema,
  OpsLogQueryInputSchema,
  OpsLogReasonSchema,
} from '../interfaces/ops-log.js'
import {
  RelocatableMediaCountInputSchema,
  RelocatableMediaCountSchema,
  RelocateJobSchema,
  RelocateMediaInputSchema,
  StorageMigrationLeaseInputSchema,
  StorageMigrationMediaMoveInputSchema,
  UnstampedEventMediaCountSchema,
} from '../interfaces/relocate.js'
import { EventOwnerTypeSchema, MediaPresenceOwnerKindSchema } from '../media/media-owner-key.js'
import { MotionTriggeredBySchema } from '../pipeline/camera-sensors.js'
import {
  ClearTrackRelationInputSchema,
  ClearTrackRelationResultSchema,
  ListTrackRelationsInputSchema,
  ListTrackRelationsResultSchema,
  SetTrackPurityInputSchema,
  SetTrackPurityResultSchema,
  SetTrackRelationInputSchema,
  TrackRelationSchema,
} from '../interfaces/track-relations.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { PackageLlmVerdictSchema } from './schemas/package-llm-verdict.js'
import { MaskPolygonShapeSchema, MaskRectShapeSchema } from './mask-shape.js'
import { RETRAIN_REVIEW_STATUSES } from '../retrain-review.js'
import { CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS } from '../pipeline/cluster-model-scope.js'
import { AudioClassifyOutcomeSchema } from './schemas/detection-shared.js'
import { ClipSearchStrictnessSchema } from '../types/clip-model.js'
import { BoundingBoxSchema } from './schemas/detection-shared.js'

/**
 * pipeline-analytics — device-scoped wrapper cap. Refines raw
 * per-frame detections emitted by the pipeline runner into tracked
 * objects, per-kind event collections (motion / object / audio), and
 * persisted media. Owns the post-detection domain end-to-end:
 *
 *   runner emits PipelineInferenceResult
 *     ↓ (event bus)
 *   pipeline-analytics subscriber
 *     ↓ SORT tracker + zone engine + state analyzer + event emitter
 *   → three DB collections (one per kind), one FS media tree, one
 *     unified event emitter (FrameTracked + TrackStarted/Ended +
 *     DetectionEvent on bus)
 *
 * Pure subscriber model. No `processFrame` cap method — the runner
 * already publishes the raw frame on the bus. The cap surface is
 * only QUERIES + per-device settings, bound on/off via
 * `device-manager.setWrapperActive`. `defaultActive: true` because
 * every camera with a detection pipeline wants its raw detections
 * refined; operators opt out per-device via BindingsTab when needed.
 *
 * Replaces the legacy `analysis-pipeline`, `analysis-data-persistence`
 * (per-device surface) and `track-trail` caps — see P11 cleanup.
 */

// ── Shared sub-schemas ──────────────────────────────────────────────

const TrackStateSchema = z.enum(['new', 'entered', 'left', 'moving', 'idle'])
export type TrackState = z.infer<typeof TrackStateSchema>

const EventKindSchema = z.enum(['motion', 'object', 'audio'])
export type EventKind = z.infer<typeof EventKindSchema>

/**
 * Spatial filter for `listTracks` — the rect + polygon variants of the shared
 * MaskShape vocabulary (see `mask-shape.ts`). Coordinates are NORMALIZED 0..1
 * of the camera frame (top-left origin), matching the drawing-plane editor.
 */
const TrackZoneFilterSchema = z.discriminatedUnion('kind', [
  MaskRectShapeSchema,
  MaskPolygonShapeSchema,
])
export type TrackZoneFilter = z.infer<typeof TrackZoneFilterSchema>

// ── Extensible per-device event kinds ────────────────────────────────
//
// `listEventKinds` advertises every event vocabulary a camera can emit:
// built-ins (motion / audio), detection classes actually observed on the
// device, and sensor kinds contributed by LINKED devices (device-manager
// `getLinkedDevices` — device-tree children / same-location / manual list).

/** Closed icon vocabulary so clients render a known glyph per kind. */
export const EventKindIconSchema = z.enum([
  'motion',
  'audio',
  'person',
  'vehicle',
  'animal',
  'door',
  'pir',
  'smoke',
  'water',
  'button',
  'package',
  'generic',
])
export type EventKindIcon = z.infer<typeof EventKindIconSchema>

export const EventKindCategorySchema = z.enum([
  'motion',
  'audio',
  'detection',
  'sensor',
  'control',
  'custom',
  'package',
])
export type EventKindCategory = z.infer<typeof EventKindCategorySchema>

/** Taxonomy level — macro (timeline lane) vs sub (events-page leaf). */
export const EventKindLevelSchema = z.enum(['macro', 'sub'])
export type EventKindLevel = z.infer<typeof EventKindLevelSchema>

const EventKindDescriptorSchema = z.object({
  /** Stable kind id (e.g. 'motion', 'vehicle', 'car', 'lock'). */
  kind: z.string(),
  /** i18n key resolved on the UI side; `label` is the English fallback. */
  labelKey: z.string(),
  /** English fallback label (kept for clients that don't translate). */
  label: z.string(),
  /** Hex color for timeline/legend rendering. */
  color: z.string(),
  /** Dictionary id → lucide component on the UI side. */
  iconId: z.string(),
  /** Legacy closed-vocab glyph — fallback for `iconId`. */
  icon: EventKindIconSchema,
  category: EventKindCategorySchema,
  /** Macro parent for this kind ('car' → 'vehicle'); null for a macro. */
  parentKind: z.string().nullable(),
  /** Derived from `parentKind`, explicit for the client tree. */
  level: EventKindLevelSchema,
  /** Which cap + device contributes this kind. For built-ins the camera
   *  itself; for sensor kinds the LINKED source device. */
  source: z.object({ capName: z.string(), deviceId: z.number() }),
})
export type EventKindDescriptor = z.infer<typeof EventKindDescriptorSchema>

/** One camera's event vocabulary, as returned by `listEventKindsBatch`. */
const EventKindsForDeviceSchema = z.object({
  deviceId: z.number(),
  kinds: z.array(EventKindDescriptorSchema).readonly(),
})
export type EventKindsForDevice = z.infer<typeof EventKindsForDeviceSchema>

// ── Sensor events (state changes of linked devices, per camera) ──────

const SensorEventSchema = z.object({
  id: z.string(),
  /** The CAMERA the event is attributed to (a sensor linked to N cameras
   *  yields N rows, one per camera). */
  deviceId: z.number(),
  /** The linked sensor device whose state changed. */
  sourceDeviceId: z.number(),
  /** Event kind id — matches an `EventKindDescriptor.kind`. */
  kind: z.string(),
  /** Snapshot of the sensor cap's runtime-state slice at the change. */
  value: z.record(z.string(), z.unknown()).nullable(),
  timestamp: z.number(),
})
export type SensorEvent = z.infer<typeof SensorEventSchema>

// ── Track (unified: identity + positions + snapshots) ───────────────

/**
 * One stored sighting on a track's trajectory.
 *
 * The array these live in is returned in TIME order (D399) — it is APPENDED in
 * arrival order, and the two detector passes interleave, so a consumer must not
 * assume the two are the same on a row written by an older build.
 */
const TrackPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  timestamp: z.number(),
  bbox: BoundingBoxSchema,
  /**
   * Which detector pass measured this box (D399): `frame` is the full-frame
   * pass on the analysis raster, `recovery` is the native-resolution
   * small-subject second pass (D377/D378). Both write into one array, and until
   * this field existed the only way to tell them apart was that full-frame boxes
   * are exact multiples of 1.2 while recovery boxes are full-precision floats.
   * Absent on rows written before D399.
   */
  source: z.enum(['frame', 'recovery']).optional(),
  /** Detection score of this box, so a position can be weighed and not only
   *  plotted. Absent on rows written before D399. */
  score: z.number().optional(),
})

const TrackSnapshotSchema = z.object({
  timestamp: z.number(),
  position: TrackPositionSchema,
  /** The snapshot's media row id (D482); resolve via `listTrackMedia({ trackId })`. */
  mediaId: z.number().int(),
})

/**
 * Normalized 0..1 trajectory envelope (min/max over every position bbox,
 * divided by the track's detection-frame dims), computed at persist time.
 * Absent when the frame dims were unknown when the track was persisted
 * (legacy rows / dims-less sources) and on active (in-RAM) tracks.
 */
const TrackEnvelopeSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
})
export type TrackEnvelope = z.infer<typeof TrackEnvelopeSchema>

/**
 * Row projection for track list queries. `full` (default) returns the
 * complete Track including the frame-rate `positions[]` history and the
 * `snapshots[]` references — megabytes across a page of tracks. `slim`
 * keeps every scalar the list surfaces actually render (ids, class(es),
 * label / audioLabels / importance enrichment, firstSeen/lastSeen, state,
 * zonesVisited, bestEventId, envelope, hasFace, hasEmbeddedFace, hasRider) and returns `positions` /
 * `snapshots` as EMPTY arrays — detail views re-fetch the full row via
 * `getTrack`. Mirrors the event-store `projection` convention
 * (`getObjectEvents` et al.).
 */
const TrackProjectionSchema = z.enum(['full', 'slim'])
export type TrackProjection = z.infer<typeof TrackProjectionSchema>

/**
 * One audio-classification label heard on the track's camera while the
 * track was alive, aggregated per label. An "episode" is one persisted
 * audio event (the confident-classification path: score ≥ the device's
 * `classificationMinScore`, class-change-or-heartbeat coalesced) — NOT
 * one 32 ms inference chunk, so counts stay human-scaled.
 */
const TrackAudioLabelSchema = z.object({
  label: z.string(),
  /** Highest classification score observed across the label's episodes. */
  peakScore: z.number(),
  /** Number of coalesced audio-event episodes carrying this label. */
  count: z.number(),
  firstAt: z.number(),
  lastAt: z.number(),
})
export type TrackAudioLabel = z.infer<typeof TrackAudioLabelSchema>

/**
 * How a track was produced. `pipeline` (default / absent) = the spatial
 * detection+tracking pipeline. Every OTHER value is a SYNTHETIC projection —
 * no positions, a single snapshot, and no bbox trajectory at all:
 *
 *  - `sensor` — a linked sensor/control device state change.
 *  - `audio` — an audio event on the camera itself that was anomalous for
 *    THAT camera, loud, and heard while nothing visual was happening (D62).
 *
 *  - `onboard` — the CAMERA's own firmware, paired with a decoded frame in
 *    that frame's pixel space. A real root detector and a SPATIAL one: its
 *    boxes are the same kind of fact `pipeline`'s are, produced by a different
 *    detector.
 *
 * `onboard` was missing here while `DetectionSourceSchema` already had it, so
 * a persisted onboard track failed `safeParse` on read and came back with NO
 * source at all — which `isSpatialTrack` then admitted by accident, through the
 * `undefined` arm rather than by anybody's decision, and which `excludeSources`
 * could not name.
 *
 * The spatial subsystems (tracker association, occupancy count, re-id /
 * embedding, resurrection) MUST skip every synthetic source. Test for that
 * with `isSpatialTrack`, which allow-lists the spatial sources explicitly — a
 * `!== 'sensor'` check silently readmits every source added after it was
 * written.
 */
export const TrackSourceSchema = z.enum(['pipeline', 'onboard', 'sensor', 'audio'])
export type TrackSource = z.infer<typeof TrackSourceSchema>

/**
 * The `excludeSources` filter on `listTracks` / `listRecentTracks`: track
 * SOURCES to leave out. ABSENT or EMPTY excludes nothing.
 *
 * ## Why the query needs a source dimension at all
 *
 * `classes` cannot express it, and trying made a filter that lies. A synthetic
 * row carries no accumulated `classes[]`, and `whereJsonArrayAny` is a
 * deliberate SUPERSET — an unreadable column keeps its row. So on the live hub
 * every class selection returned every synthetic row: `classes: ['person']`
 * came back with 66 contact markers and 29 audio markers attached, and a class
 * that exists nowhere at all still answered 116 rows, all of them synthetic.
 * "Sensor" and "Audio" selected the identical set, because neither selected
 * anything — they merely failed to exclude the rows the escape hatch keeps.
 *
 * Provenance is `source`, never a class name (D189 put every audio row on
 * `className: 'audio'` precisely so the audio VOCABULARY could stop colliding
 * with the detection one). This is the filter that speaks it.
 *
 * ## Why EXCLUDE and not an allow-list
 *
 * A stored client preference outlives this enum. An allow-list persisted by a
 * viewer that has never heard of a source added next year would hide it
 * forever, silently — the same shape as the `!== 'sensor'` check this file
 * already warns about. An exclusion list can only ever hide what it names.
 *
 * ## NULL is `pipeline`
 *
 * Pipeline rows carry no `source` at all (the column is nullable and the
 * completed-track persist omits it), so the provider compiles this as a
 * NULL-safe `whereNotIn` when `pipeline` is NOT excluded, and as a positive
 * `whereIn` over the surviving sources when it is. Both are exact; neither
 * leaves a row's fate to a default.
 *
 * It is a REAL query filter, not a post-read drop: paging must tell the truth
 * about how much is left.
 */
export type ExcludeSourcesDoc = readonly TrackSource[]

/**
 * Where a track sits in the RETRAIN lifecycle (D81).
 *
 *  - `none` — never marked, or un-marked. Evictable.
 *  - `staging` — the operator wants this track as training material and has not
 *    finished with it. **This is the only state retention holds**: the track and
 *    everything it owns (object events, crops, keyframes, CLIP vector) survive
 *    the device's age window.
 *  - `trained` — the retrain page has taken what it needed. The frames it chose
 *    were COPIED into the retrain dataset at selection time, so the dataset no
 *    longer depends on the track's media and the track becomes EVICTABLE again.
 *    Terminal for the plain `markForTrain` toggle: returning it to `staging` is
 *    a deliberate action of the retrain page, not a side effect of a checkbox.
 *
 * There is no `null`. The state is stored `TEXT NOT NULL DEFAULT 'none'` so that
 * every row is selectable by a positive predicate. (The filter language has
 * since grown the NULL-safe `whereNot` / `whereNotIn` and an `IS NULL` reading
 * of `where: { f: null }`, which is how {@link TrackSourceSchema} can be
 * filtered on a NULLABLE column — see `excludeSources`. It did not when this
 * column was designed, and a NOT NULL column is still the better shape.)
 */
export const RetrainStatusSchema = z.enum(['none', 'staging', 'trained'])
export type RetrainStatus = z.infer<typeof RetrainStatusSchema>

/**
 * Longest debug note the hub will store, in characters.
 *
 * The bound is at the WIRE, not on the viewer's `TextInput`: three surfaces
 * write this patch and only one of them is the app, so a `maxLength` prop
 * bounds one caller and leaves the column open to the other two. The number is
 * generous for the sentence this field is for ("the box jumps to the fence when
 * the car passes") and small enough that the note never dominates the track row
 * every slim list read already pays for.
 */
export const MAX_TRACK_DEBUG_NOTE_LEN = 500

/**
 * Per-track OPERATOR flags — set by hand from the admin UI or the viewer, never
 * by the pipeline. Spread into `TrackSchema` and `KeyEventSchema` from one place
 * so the two surfaces cannot drift.
 *
 * **Absent ≠ false.** A track that has never been touched omits the field; an
 * explicitly un-flagged track carries `false`. Legacy rows written before the
 * columns existed read as absent, and a consumer that needs a boolean should say
 * `flag === true`, not `flag !== false`.
 *
 * `markForTrain` is the WIRE FACE of {@link RetrainStatusSchema}, not a column:
 * it is exactly `retrainStatus === 'staging'`, in both directions. Writing
 * `true` moves `none → staging`, writing `false` moves `staging → none`, and a
 * `trained` track reports `false` while refusing both writes. The boolean is
 * kept because three surfaces drive a toggle off it; anything that needs to tell
 * "never marked" from "already trained" must read `retrainStatus`.
 *
 * `debug` does NOT pin; it is attention, not durability.
 *
 * `debugNote` is the operator's own words about WHAT should be checked on this
 * track, and it lives and dies with `debug` — see {@link MAX_TRACK_DEBUG_NOTE_LEN}.
 *
 * `favourited` IS a BOOLEAN pin (durability bit), not a retrain lifecycle.
 * A favourited track is skipped by retention the same way `staging` is, but
 * it does not enter `none|staging|trained` and has no staging budget.
 */
const TrackFlagFields = {
  /** Operator marked this track as training material — i.e. `retrainStatus` is
   *  `'staging'`. */
  markForTrain: z.boolean().optional(),
  /** Operator marked this track for diagnostic attention. */
  debug: z.boolean().optional(),
  /**
   * What the operator wants CHECKED on this track, in their own words.
   *
   * The flag alone says "look at this" and nothing about what for; a debug set
   * reviewed hours later is a list of tracks with no question attached. Bound
   * to `debug` on the WRITE side — the body clears it when `debug` goes off,
   * and refuses it on a track whose debug is off — so a note can never outlive
   * the attention it belongs to.
   *
   * `''` is a real value ("marked, nothing to add"); the ABSENT key means
   * "leave whatever is stored alone", which is what lets a surface turn debug
   * on without a note (a cancelled prompt) and what lets it edit the note
   * without touching the flag.
   */
  debugNote: z.string().max(MAX_TRACK_DEBUG_NOTE_LEN).optional(),
  /** Operator favourited this track. Pins it against pruning. */
  favourited: z.boolean().optional(),
} as const

/**
 * The lifecycle field itself, on the READ surfaces only (`Track`, `KeyEvent`).
 * Deliberately NOT part of {@link TrackFlagFields}: that group also builds the
 * write patch, and the status is not something the toggle sets — it is what the
 * toggle's boolean is derived from. Absent on an in-RAM track never touched;
 * always present on a persisted row (the column default materialises `'none'`).
 */
const TrackRetrainFields = {
  retrainStatus: RetrainStatusSchema.optional(),
} as const

/**
 * The write half: a PARTIAL patch. An omitted key is left untouched, so setting
 * one flag can never clear the other — the toggles are independent and are
 * driven from three surfaces that do not know about each other.
 */
export const TrackFlagsPatchSchema = z.object(TrackFlagFields)
export type TrackFlagsPatch = z.infer<typeof TrackFlagsPatchSchema>

/**
 * The resolved flag state after a write. Both fields are REQUIRED here (absent
 * collapses to `false`) so a caller can drive a toggle's checked state off the
 * mutation result without a re-fetch.
 */
export const TrackFlagsSchema = z.object({
  trackId: z.string(),
  markForTrain: z.boolean(),
  debug: z.boolean(),
  /** The note as it STANDS after the write — never absent here (a track with no
   *  note reports `''`), for the same reason the booleans are required: a
   *  surface that has just written must be able to render the note it now owns
   *  without a re-fetch, and an absent key would read as "unchanged" on a
   *  screen that has no previous value to keep. */
  debugNote: z.string(),
  favourited: z.boolean(),
  /** The lifecycle state the boolean was derived from. Required here (unlike on
   *  a track row) because this shape is only ever produced by the write body,
   *  which always knows it — and a surface that has just written needs to render
   *  `trained` without a re-fetch. */
  retrainStatus: RetrainStatusSchema,
})
export type TrackFlags = z.infer<typeof TrackFlagsSchema>

/**
 * WHICH tier a label occupies. The slot a label lands in is DECLARED by the
 * step that produced it (`StepDefinition.labelTier`), never inferred from the
 * text or the step's name.
 *
 *  - `1` — a SUB-CLASS: finer than the macro class, still a taxonomy token.
 *    `animal-type` (`dog`, `bird`), `vehicle-type` (`van`), and the root
 *    detector's own raw class when it is finer than the macro it maps to.
 *  - `2` — an INSTANCE: the finest thing said about this subject.
 *    `species` (`Turdus migratorius`), `identity` (`Alice`), `plate-text`.
 *
 * The macro class itself (`person`, `vehicle`, `animal`, `package`, `face`,
 * `plate`, `audio`) is NOT a tier — it is `className`, and a macro token
 * offered for either label slot is refused (2026-08-07 rule; the refusal is
 * logged as `label tier collapse refused`).
 */
export const LabelTierSchema = z.union([z.literal(1), z.literal(2)])
export type LabelTier = z.infer<typeof LabelTierSchema>

/**
 * WHO decided a label, and when. Carried per tier so a value can be traced to
 * the step and model that produced it — which is what makes the write rule
 * arguable after the fact ("why is 592's label `dog` and not `Canis lupus`?")
 * and what lets a migrated, UNATTRIBUTED value be told apart from a real one.
 *
 * `stepId` is the pipeline step id (`animal-classifier`, `bird-classifier`,
 * `plate-ocr`, `face-embedding`, `object-detection`), or the sentinel
 * `migration:4g` for a value the 4g migration moved from the single-slot era —
 * that value has no provenance, and the write rule lets ANY properly-attributed
 * write of the same tier replace it regardless of score.
 */
export const LabelAttributionSchema = z.object({
  stepId: z.string(),
  modelId: z.string().optional(),
  decidedAt: z.number(),
  /**
   * The GALLERY id behind a recognised tier-2 label — a face-gallery
   * `Identity.id` or a plate-gallery `Vehicle.id` (both `randomUUID`).
   *
   * The text alone is a DISPLAY NAME, and a display name is renameable: a
   * notification rule authored on "Alice" stopped matching the moment the
   * operator fixed the spelling in the gallery, and nothing said so. The id is
   * the thing that does not move, so it is what a rule matches on
   * (`NcConditions.identities`) and the text is what a human is shown.
   *
   * Absent when the label names no gallery row — a plate the OCR read but no
   * vehicle claims, a sub-class, a species, any tier-1 value.
   */
  identityId: z.string().optional(),
})
export type LabelAttribution = z.infer<typeof LabelAttributionSchema>

/**
 * The TIERED label model (roadmap 4g), spread into `TrackSchema` and
 * `ObjectEventSchema` from ONE place so the two surfaces cannot drift — a
 * track and its events always answer the same question the same way.
 *
 * Two scalar columns, not an array: every consumer wants "the coarse one" or
 * "the fine one", and an array made both a scan. `label` is tier 1, `subLabel`
 * is tier 2, and each carries its own score + attribution.
 *
 * **Reading it.** What a human should be shown is `subLabel ?? label` — the
 * finest thing known. Before 4g the single `label` column held the finest
 * value, so a consumer that has not been updated reads the tier-1 slot and
 * shows nothing on a species-only row; that is why the migration puts every
 * pre-4g value in tier 2 (it cannot regress a display that reads the fallback)
 * and why the read surfaces were changed in the same train.
 *
 * **Writing it.** The slots are independent, which is the whole point: a
 * tier-1 write (`bird`) can never overwrite a tier-2 value (`Turdus
 * migratorius`), so fineness cannot regress by construction. Within a tier the
 * higher score wins. One rule, one implementation — see
 * `pipeline/label-tier.ts` in addon-post-analysis.
 */
const TieredLabelFields = {
  /** Tier 1 — the sub-class. See {@link LabelTierSchema}. */
  label: z.string().optional(),
  /** Confidence of the tier-1 value, as reported by the deciding step. */
  labelScore: z.number().optional(),
  /** Provenance of the tier-1 value. See {@link LabelAttributionSchema}. */
  labelMeta: LabelAttributionSchema.optional(),
  /** Tier 2 — the instance. See {@link LabelTierSchema}. */
  subLabel: z.string().optional(),
  /** Confidence of the tier-2 value, as reported by the deciding step. */
  subLabelScore: z.number().optional(),
  /** Provenance of the tier-2 value. See {@link LabelAttributionSchema}. */
  subLabelMeta: LabelAttributionSchema.optional(),
} as const

/** Per-camera slice of a training-export estimate. */
export const TrainingExportDeviceTotalsSchema = z.object({
  deviceId: z.number(),
  tracks: z.number().int(),
  files: z.number().int(),
  bytes: z.number().int(),
})
export type TrainingExportDeviceTotals = z.infer<typeof TrainingExportDeviceTotalsSchema>

/**
 * What a training export WOULD contain. Computed from media index rows only —
 * no blob is read to produce this.
 */
export const TrainingExportSummarySchema = z.object({
  generatedAt: z.number(),
  trackCount: z.number().int(),
  fileCount: z.number().int(),
  byteCount: z.number().int(),
  /** More marked tracks exist than a single pass carries. */
  truncated: z.boolean(),
  devices: z.array(TrainingExportDeviceTotalsSchema).readonly(),
})
export type TrainingExportSummary = z.infer<typeof TrainingExportSummarySchema>

/**
 * Where one frame of a track was inferred: the runner NODE that emitted it
 * (`PipelineInferenceResultPayload.nodeId`), the inference DEVICE its root ran
 * on (`FrameResult.rootDeviceKey`, e.g. `openvino:npu`) and the ROOT model
 * (`FrameResult.rootModelId`). Absent members are unknown, never empty: a
 * camera's onboard detector names no device or model, and a runner older than
 * `rootDeviceKey` names no device.
 */
export const TrackPlacementSchema = z.object({
  nodeId: z.string(),
  deviceKey: z.string().optional(),
  modelId: z.string().optional(),
})
export type TrackPlacement = z.infer<typeof TrackPlacementSchema>

const TrackSchema = z.object({
  trackId: z.string(),
  deviceId: z.number(),
  className: z.string(),
  ...TieredLabelFields,
  producingDeviceName: z.string().optional(),
  /* Synthetic (source:'sensor') tracks: NAME of the device that produced the event. */
  /** Track provenance. Absent ⇒ `pipeline` (legacy rows). */
  source: TrackSourceSchema.optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  /** Frame-rate position history (subject to maxPositionHistory cap). */
  positions: z.array(TrackPositionSchema).readonly(),
  /** Periodic snapshots at snapshotIntervalMs cadence — DEBUG media, produced
   *  only while `MediaSettings.debugMediaEnabled` is on for the camera (D299;
   *  the retired `saveThumbnails` used to gate this and the rolling
   *  `lastFrame` together). Empty is the healthy default, not a capture gap. */
  snapshots: z.array(TrackSnapshotSchema).readonly(),
  /** Deduplicated zones the track has entered at least once. Zone IDS. */
  zonesVisited: z.array(z.string()).readonly(),
  /**
   * Human NAMES for {@link zonesVisited}, resolved at READ time against the
   * `zones` capability.
   *
   * `zonesVisited` persists ids (`cfeec78c-8d69-…`), which no operator can type
   * and no card can render — so every free-text search surface was structurally
   * unable to answer "show me the tracks in Uscio", and did not fail loudly, it
   * just returned nothing. Resolving here rather than in each client keeps ONE
   * derivation and costs the clients no extra call (the `zones` cap is
   * per-device, so a client-side resolve would be a per-camera fan-out on a
   * surface built to avoid exactly that).
   *
   * Resolved, never invented: a zone deleted since the track was written has no
   * name and is DROPPED, so this array can be shorter than `zonesVisited` — the
   * two are not positionally aligned. Absent when the track visited no zone, or
   * when the zone catalogue could not be read.
   */
  zoneNames: z.array(z.string()).readonly().optional(),
  /** Deduplicated set of detector classes observed for this track over its
   *  life (a track may be reclassified, e.g. person→vehicle). Absent on
   *  legacy rows written before class accumulation shipped. */
  classes: z.array(z.string()).readonly().optional(),
  /** Cumulative normalized distance travelled (0..1 units = full frame width). */
  totalDistance: z.number(),
  state: TrackStateSchema,
  active: z.boolean(),
  /** Deterministic key-event importance score in [0,1] (server-computed at
   *  track expiry, recomputed on late label). Absent on legacy rows written
   *  before scoring shipped — consumers degrade to absence / compute-on-read. */
  importance: z.number().optional(),
  /** Id of the track's highest-confidence ObjectEvent (its representative
   *  "best" frame). Absent when the track produced no object events. */
  bestEventId: z.string().optional(),
  /** Tag of the importance sub-signal that dominated the score
   *  (identity|dwell|proximity|class|confidence|travel|zone). */
  importanceReason: z.string().optional(),
  /** Audio-classification labels heard on the camera during the track's
   *  life (score ≥ device `classificationMinScore`), aggregated per label.
   *  Absent on legacy rows / tracks with no confident audio. */
  audioLabels: z.array(TrackAudioLabelSchema).readonly().optional(),
  /** Normalized 0..1 trajectory envelope (see {@link TrackEnvelopeSchema}).
   *  Populated from the persisted envelope columns on historical reads;
   *  absent on legacy rows, dims-less tracks and active (in-RAM) tracks. */
  envelope: TrackEnvelopeSchema.optional(),
  /**
   * A face DETECTOR found a face on this track — nothing more. It says the
   * detail plane produced a `face` detail; it does NOT say the face was
   * embedded, matched, above `minFacePx`, or that the recognizer was even
   * enabled. Set once and never cleared.
   *
   * **This exists so "face present but not recognised" is expressible.** A
   * recognised identity lands in `subLabel` (attributed to the face chain via
   * `subLabelMeta.stepId`), so before this field a track with an unmatched face
   * and a track with no face at all were byte-identical on the wire and no
   * surface could tell them apart. The read is `hasFace === true && subLabel
   * === undefined`.
   *
   * **Absent ≠ false.** Every row written before the column existed omits it,
   * and so does every server that predates the field — a consumer must test
   * `=== true` and render nothing otherwise, never infer "no face".
   */
  hasFace: z.boolean().optional(),
  /**
   * This track has a face row IN THE GALLERY: a crop **and** an embedding — a
   * face an operator could ASSIGN to an identity.
   *
   * The STRICT twin of {@link hasFace}, and the pair only earns its keep
   * because the two disagree. `hasFace` is stamped at the TOP of the face
   * branch, before every gate, and means no more than "a face detector produced
   * a face detail". This one is stamped at the single moment the gallery row
   * LANDS — after `FaceRecognizer.onTrackEnd` successfully persists it, i.e.
   * past the embedding-magnitude verdict, the `minFacePx` detection gate, the
   * candidate gate, the imageless-track drop (no crop was ever captured) and
   * the crop-store drop. Everything between the detector and that insert can
   * legitimately refuse the face, so a flag written any earlier promises the
   * operator something to assign and delivers nothing.
   *
   * **Independent of recognition.** A face collected but never auto-matched is
   * still assignable — it is in fact the face an operator most wants to reach —
   * so this is NOT gated on `recognizedIdentityId`. Recognition lands in
   * `subLabel`; this says only that the raw material exists.
   *
   * **Set once, never cleared.** A track that produced a gallery row produced
   * one; deleting the row later is the gallery's business, not this flag's.
   *
   * **Absent ≠ false**, the same rule as {@link hasFace}: every row written
   * before the column omits it, and so does every server that predates the
   * field. A consumer must test `=== true` and render nothing otherwise —
   * never infer "no assignable face".
   */
  hasEmbeddedFace: z.boolean().optional(),
  /**
   * This subject CONTAINS a folded rider — a person the rider-pairing step
   * ([D34](../decisions/adr-0034.md)) removed from the frame BEFORE the tracker,
   * so the passage is tracked once and as a VEHICLE.
   *
   * It exists because the fold's record was dishonest. D34 and the code both
   * said "the person is not lost — it is reported so both entities stay on the
   * record"; in fact the pair went into a per-processor RAM field behind an
   * accessor nobody called, and every durable surface said `vehicle`, full
   * stop. This is the composition note that makes the row true.
   *
   * A COMPOSITION, never a class and never a label. "This vehicle contains a
   * person" is not an answer to "what is this" — both label tiers would refuse
   * a macro token anyway (D89), and correctly. Nothing here changes what the
   * subject IS: a cyclist stays one vehicle track, occupancy still counts one,
   * and a `person` rule still does not fire for someone cycling past.
   *
   * **Absent ≠ false**, exactly like {@link hasFace}: every row written before
   * the column, and every hub that predates the field, omits it. Test
   * `=== true` and render nothing otherwise — never infer "no rider".
   */
  hasRider: z.boolean().optional(),
  /**
   * WHY this track ended without a NATIVE best-shot FRAME
   * ([D276](../decisions/adr-0276-a-stand-in-tile-is-provisional-and-a-close-says-why.md),
   * widened by [D400](../decisions/adr-0400-the-picture-is-judged-on-what-is-delivered.md)) —
   * a composed token line (`no-key-frame capture=keyframe:native-missx4`,
   * `derive-returned-null tile=standin`,
   * `native-tile tile=native no-key-frame-at-close`, …) written at close and
   * CLEARED by the late-keyFrame upgrade when a native tile lands after all.
   * The operator-facing answer to "perché manca l'immagine?" [why is the image missing?] on a track whose
   * tile is a face/plate stand-in, a raster crop, or an icon.
   *
   * **`no-key-frame-at-close` (D400).** The line used to be written ONLY when
   * the TILE ranked below native, so a track whose thumbnail landed natively
   * while its key frame missed carried no reason at all — three of the four
   * `MISSING_KEYFRAME` tracks in the 2026-09-07 operator audit were exactly
   * that shape, and their "niente ultimo" [no last frame] had no cause anywhere on the row.
   * The key frame is the head of a cascade (`keyFrame ⇒ keyFrameSmall ⇒ the
   * lastFrame copy source`), so its absence is now on this line whatever the
   * tile ended up being.
   *
   * **Absent ≠ "missed silently"**: a row written before the column, a hub
   * that predates the field, and every track whose tile landed native all
   * omit it. Render nothing when absent.
   */
  previewMissReason: z.string().optional(),
  /**
   * The ROOT model that produced this track — the `FrameResult.rootModelId` of
   * the frame it was BORN on (D646). What a later replay compares against, so
   * "the original model" is named rather than assumed. A birth fact: never
   * rewritten by a later frame. **Absent ≠ unknown-model**: a row from before
   * the column, and a track the camera's own detector produced, carry none.
   */
  modelId: z.string().optional(),
  /**
   * WHERE the frame that OPENED this track was inferred — the runner node, the
   * inference device and the root model of its birth frame. A birth fact,
   * never rewritten. On a track fused by L2 (D683) it is the placement of the
   * piece born FIRST. Absent on a row written before the field, and on a
   * frame whose runner named no node.
   */
  openedPlacement: TrackPlacementSchema.optional(),
  /**
   * WHERE the last real SIGHTING of this track was inferred — the frame that
   * closed it (a coasted frame is not a sighting). Differs from
   * `openedPlacement` when the camera's session hopped node or device while
   * the subject was in view (D916). On a fused track it is the placement of
   * the piece seen LAST. Absent under the same rule as `openedPlacement`.
   */
  closedPlacement: TrackPlacementSchema.optional(),
  /**
   * Size (px) of the detection frame this track's `positions[].bbox` live in —
   * the frame it was born on, else the camera's latest analysis frame at
   * persist time. Divide a position by these to normalise it. Absent when the
   * size was never known.
   */
  frameWidth: z.number().optional(),
  frameHeight: z.number().optional(),
  ...TrackFlagFields,
  ...TrackRetrainFields,
})
export type Track = z.infer<typeof TrackSchema>
// TrackPosition / TrackSnapshot types stay internal — consumers access
// them through `track.positions[i]` / `track.snapshots[i]`. Top-level
// names are reserved for the legacy interfaces/analysis-persistence.ts
// until P11 cleanup.

// ── Events (per-kind, three separate backing collections) ───────────

const BaseEventFields = {
  /**
   * A SQLite ROWID, assigned by the database (D474).
   *
   * Was a 36-character UUID and cost 263 MB of a 1 117 MB database — paid
   * TWICE per row, in the row and in the primary-key index, across 2.1 million
   * motion, audio and object events. An `INTEGER PRIMARY KEY` in SQLite **is**
   * the rowid: the table itself is that B-tree, so the index stops existing
   * rather than getting smaller. No shorter string does that.
   *
   * Defined once here for all three event kinds, which is why they move
   * together: a per-table migration would have forked this and
   * `COMMON_BASE_COLUMNS` and reunited them two stages later.
   */
  id: z.number().int(),
  deviceId: z.number(),
  timestamp: z.number(),
}

const MotionEventSchema = z.object({
  ...BaseEventFields,
  kind: z.literal('motion'),
  regionCount: z.number(),
  /** Heavy JSON array — omitted in slim projection. */
  regions: z
    .array(
      z.object({
        bbox: BoundingBoxSchema,
        pixelCount: z.number(),
        intensity: z.number(),
      }),
    )
    .readonly()
    .optional(),
  /** Omitted in slim projection. */
  frameWidth: z.number().optional(),
  /** Omitted in slim projection. */
  frameHeight: z.number().optional(),
  /** Populated by B5 (recording playback URL for this event). */
  mediaUrl: z.string().optional(),
  /**
   * The FIRST trigger of an `onboard` episode, written once at open (D672).
   * Absent = not recorded (a row written before D672, or an analyzer /
   * device-activity episode) — never read as "the camera" (D393).
   */
  triggeredBy: MotionTriggeredBySchema.optional(),
  /**
   * One row per motion EPISODE, not one per push (D475). `null` while the
   * episode is still open — a further rising edge extends it in place rather
   * than inserting a new row. Set once, at close, to `lastOnAt - startedAt`
   * (the span from the first rising edge to the LAST one, deliberately NOT
   * `closedAt - startedAt` — the close delay is a quiet CONFIRMATION, not
   * movement, and folding it in would report `MOTION_CLOSE_AFTER_MS` of
   * motion for an instantaneous trigger).
   *
   * **Absent** (not merely `null`) on a row written before D475 — that means
   * "closed the old way, before this column existed", never "still open".
   * Nothing in this codebase may read an absent `durationMs` as an open
   * episode; only `null` means open.
   */
  durationMs: z.number().nullable().optional(),
  /**
   * Ms offsets from `timestamp` (the episode's own first rising edge, so the
   * first entry is always `0`) of every genuine off→on transition the
   * episode saw — "ogni evento on si deve salvare" [every ON event must be saved] (D475). NOT one entry per
   * push: a firmware source that keepalives at ~1 Hz for the whole burst
   * (Reolink, Hikvision) produces exactly one edge; a source that reports an
   * explicit `false` mid-episode and then resumes before the quiet window
   * elapses produces another. Stored compactly — see `motion-edge-codec.ts`
   * — and decoded back to this shape on read. Absent/empty on a legacy row,
   * which must never be read as "no episode happened here".
   */
  edges: z.array(z.number()).readonly().optional(),
})
export type MotionEvent = z.infer<typeof MotionEventSchema>

/** An event BEFORE it has an id — see {@link ObjectEventDraft} (D474). */
export type MotionEventDraft = Omit<MotionEvent, 'id'>

/**
 * Which detection SOURCE produced an object event. `pipeline` = the ML
 * detection pipeline (decoded-frame inference); `onboard` = the camera's
 * native on-device AI. Both flow through the SAME analysis layers (zoning,
 * tracking, per-kind persistence) but stay distinguishable so consumers
 * (advanced-notifier, occupancy, …) can select which source(s) to act on.
 * Absent on legacy rows ⇒ treat as `pipeline`.
 */
export const DetectionSourceSchema = z.enum(['pipeline', 'onboard'])
export type DetectionSource = z.infer<typeof DetectionSourceSchema>

/**
 * Which WAY a subject crossed a zone boundary. An entry and an exit are two
 * different notifications ("the parcel arrived" / "the car left the drive"),
 * and until this existed they were indistinguishable on the persisted record —
 * which is why exits were computed and dropped at the emit boundary rather
 * than doubling every zone-scoped rule.
 */
export const ZoneCrossingDirectionSchema = z.enum(['enter', 'exit'])
export type ZoneCrossingDirection = z.infer<typeof ZoneCrossingDirectionSchema>

/**
 * The confirmed zone crossing that produced an object event. Present ONLY on
 * an event emitted BY a crossing (`zone.enter` / `zone.exit`); a movement-state
 * event (`object.entering` / `leaving` / `stationary` / `loitering`) and an
 * appearance event carry none, so a rule asking for a direction fails closed
 * on them.
 *
 * Exactly ONE crossing per event: the emitter turns each confirmed crossing
 * into its own event, so a frame in which a track enters A while leaving B
 * produces two events with two directions — never one ambiguous row.
 *
 * `zoneId` is load-bearing for an EXIT: the event's `zones` list is the
 * membership the box has NOW, and by definition it no longer contains the zone
 * that was just left. Without the id here, a zone-scoped rule could never match
 * the exit it asked for.
 */
export const ZoneCrossingSchema = z.object({
  direction: ZoneCrossingDirectionSchema,
  /** Admin zone id crossed. */
  zoneId: z.string(),
  /** Zone display name at crossing time (falls back to the id). */
  zoneName: z.string().optional(),
})
export type ZoneCrossing = z.infer<typeof ZoneCrossingSchema>

/** One zone a box was stamped with, and how much of the BOX fell inside it. */
export const ZoneOverlapSchema = z.object({
  zoneId: z.string(),
  zoneName: z.string().optional(),
  /** Percentage of the BOX area inside the zone, 0–100. */
  overlapPct: z.number(),
})
export type ZoneOverlap = z.infer<typeof ZoneOverlapSchema>

const ObjectEventSchema = z.object({
  ...BaseEventFields,
  kind: z.literal('object'),
  /** Detection source. Optional for backward-compat; absent ⇒ `pipeline`. */
  source: DetectionSourceSchema.optional(),
  /**
   * Inference-frame id shared by every object event emitted from the SAME frame
   * — the "scene/parent" key. Lets a consumer group co-occurring detections (e.g.
   * 2 people + 1 dog) under one full frame, and link a track's frames over time
   * (group by `trackId`, pick a representative `frameId` as the parent frame).
   * Optional for backward-compat with pre-existing rows / the slim projection
   * includes it (it is light). Absent on rows written before this field.
   */
  frameId: z.string().optional(),
  /**
   * A PRODUCER-chosen key that makes a synthetic event's emission idempotent
   * (D474).
   *
   * Only the package detector writes it, and it exists because the event id
   * stopped being choosable: the delivery and pick-up rows used to BE their
   * dedupe key (`pa-pkg-<entryId>-delivered`), which is how "never emit a
   * second delivery for this entry" survived a restart. An `INTEGER` rowid is
   * assigned by SQLite, so that key had to move off the primary key rather
   * than be dropped — a detector that cannot recognise its own row re-delivers
   * every parcel on every boot.
   *
   * Absent on every other object event, and on every row written before this
   * field. Never a substitute for `id`: it is unique per (producer, occasion),
   * not per row, and nothing addresses a row by it.
   */
  idempotencyKey: z.string().optional(),
  /** Omitted in slim projection. */
  trackId: z.string().optional(),
  className: z.string(),
  ...TieredLabelFields,
  /** Omitted in slim projection. */
  confidence: z.number().optional(),
  /** Heavy JSON — omitted in slim projection. */
  bbox: BoundingBoxSchema.optional(),
  /** Heavy JSON — omitted in slim projection. */
  zones: z.array(z.string()).readonly().optional(),
  /**
   * How far inside each stamped zone the box actually was, as a percentage of
   * the BOX area.
   *
   * Membership alone cannot express "at least a third of it inside", which is
   * the bar an operator argues with — and the number already existed: the
   * engine computed it, the pipeline logged it, and then discarded it. It
   * matters most on the events that carry no track, where a rule has nothing
   * else to judge by.
   */
  zoneOverlaps: z.array(ZoneOverlapSchema).readonly().optional(),
  /**
   * Present when this event describes a detection the TRACKER refused, so it
   * has no track and never will.
   *
   * A zone-scoped immediate rule asks "is there an animal in the flowerbed
   * NOW?"; tracking answers a different question ("is this the same subject as
   * before?") whose confirmation threshold presumes continuity. On 2026-09-09 a
   * dog at 0.7729, 100% inside a watched zone, was refused three times in six
   * seconds with three different candidate ids — seven analysed frames in the
   * window, the subject in a handful of them, metres apart — and produced no
   * event at all.
   *
   * It is NAMED rather than merely implied by a missing `trackId`: an event
   * with no track and no reason is indistinguishable from a track whose media
   * went missing, and a consumer that asks this one for a best shot or a
   * history is asking for something that never existed.
   */
  spawnRefused: z.string().optional(),
  /** Omitted in slim projection. */
  state: TrackStateSchema.optional(),
  /**
   * The zone crossing this event IS, when it is one. Absent on every other
   * event kind (movement state, appearance, package) — see
   * {@link ZoneCrossingSchema}. Omitted in slim projection.
   */
  zoneCrossing: ZoneCrossingSchema.optional(),
  /** Detection-frame dimensions in pixels — let consumers normalize the
   *  pixel-space `bbox` onto a displayed image. Omitted in slim projection. */
  frameWidth: z.number().optional(),
  frameHeight: z.number().optional(),
  /** Media row id of the crop attached to this event (if any) — D482. */
  mediaId: z.number().int().optional(),
  /** Design B: media row id of the track's native-resolution key frame (the
   *  best-detection full frame). Resolve via the event-media data-plane
   *  (`/addon/<addonId>/event-media/m/<keyFrameMediaId>`) for a detail view that
   *  draws `bbox` over the native frame. Absent on legacy rows / non-decoded
   *  sources — consumers fall back to `mediaId` (the tight crop). */
  keyFrameMediaId: z.number().int().optional(),
  /** Populated by B5 (recording playback URL for this event). */
  mediaUrl: z.string().optional(),
  /**
   * When the change this row records HAPPENED, epoch ms, when that is earlier
   * than {@link timestamp} and the producer could date it (D684).
   *
   * Set on a package PICK-UP row only: its `timestamp` is when the departure
   * was CONCLUDED — five minutes of unseen observed time after the parcel went
   * — and a notification's footage has to be cut around the pick-up, not the
   * empty doormat after it (D682). Stored so every path that rebuilds a
   * notification subject from the row (the boot reconcile, a dry-run) anchors
   * on the same instant the live hook did.
   *
   * `timestamp` keeps its meaning. Absent on every other row and on every
   * pick-up written before D684 — UNKNOWN, never 0 and never `timestamp`.
   */
  observedAt: z.number().optional(),
  /**
   * The delivery was emitted without a vision-model yes (D931).
   *
   * Set only when the packages rule asked for an LLM confirm and the model
   * was unreachable, timed out, or answered something that did not parse.
   * A notification reads it so it can say "possible" instead of a definite
   * delivery. Absent on every other row, and on a confirm that said yes.
   */
  packagePossible: z.boolean().optional(),
  /**
   * The vision model's verdict, when a packages rule asked for one and the
   * model answered the schema (D931). A "no" never becomes a row — the
   * detector drops it and logs the reason. Present on a yes.
   */
  packageLlmVerdict: PackageLlmVerdictSchema.optional(),
  /** The parent track's key-event importance [0,1], propagated to every object
   *  event of the track (so an event row can be sorted by importance without a
   *  track join). Absent on legacy rows / before the track was scored. */
  importance: z.number().optional(),
})
export type ObjectEvent = z.infer<typeof ObjectEventSchema>

/**
 * An event BEFORE it has an id (D474).
 *
 * The id is the ROWID the database assigns, so no producer upstream of the
 * write can name it: a frame processor, a detector or a classifier builds a
 * DRAFT, `insert` returns the id, and only then does an `ObjectEvent` exist.
 * A draft must never be handed to anything that owns media, names an event on
 * the bus, or feeds a notification rule — those all address a row by id.
 */
export type ObjectEventDraft = Omit<ObjectEvent, 'id'>

const AudioEventSchema = z.object({
  ...BaseEventFields,
  kind: z.literal('audio'),
  rms: z.number(),
  dbfs: z.number(),
  classification: z
    .object({
      className: z.string(),
      originalClass: z.string().optional(),
      score: z.number(),
    })
    .optional(),
  /**
   * Whether the classifier RAN on the window behind this row (D660). Absent
   * on rows written before D660 — unknown, NOT classified: until then a
   * window the analyzer's busy gate threw away was stored exactly like one
   * that heard nothing above the floor.
   */
  classifyOutcome: AudioClassifyOutcomeSchema.optional(),
  /** Populated by B5 (recording playback URL for this event). */
  mediaUrl: z.string().optional(),
})
export type AudioEvent = z.infer<typeof AudioEventSchema>

/** An event BEFORE it has an id — see {@link ObjectEventDraft} (D474). */
export type AudioEventDraft = Omit<AudioEvent, 'id'>

// ── Media files (crops / thumbs / snapshots) ────────────────────────

const MediaFileKindEnum = z.enum([
  'crop',
  'thumbnail',
  'snapshot',
  'firstFrame',
  'lastFrame',
  'fullFrame',
  'fullFrameBoxed',
  // Face/plate crops saved per event by addon-post-analysis.
  'faceCrop',
  'plateCrop',
  // Design B: ONE native-resolution frame per track (the best-detection key
  // frame). Face / object-embedding / thumbnail rows link to it by media key.
  'keyFrame',
  // Design C: the 960px-long-side downscaled variant of the clean best-shot
  // `keyFrame` (no box).
  'keyFrameSmall',
  // Best-crop fast-load (2026-07-21): the ~480px-long-side downscale of the
  // square-framed best-shot subject `thumbnail`, derived from the SAME native
  // crop (no second fetch, never upscaled). The reel/lists/grid representative.
  'thumbnailSmall',
  /**
   * THE PIXELS THE CONFIRMATION GATE JUDGED, saved when it did not confirm.
   *
   * The gate re-runs the detector on a crop of the birth frame and can retract
   * the track on what it finds. When that verdict is argued with — "the ML says
   * there is nothing there, but the operator walked past the camera" — the only
   * thing that settles it is the crop itself, and it existed for milliseconds
   * inside a closure and was never written anywhere.
   *
   * Measured on device 106, 2026-09-15: 18 births out of 18 retracted in three
   * hours, every one with `cropSource=native` (so the crop ARRIVED) and none
   * with a `bestScore` (so the detector found nothing compatible in it).
   * Whether the detector was right, or the box/frame pairing was skewed, cannot
   * be decided from a log line — both readings fit every number we have.
   *
   * Written only when the gate did NOT confirm AND the track survives the
   * verdict, so a debug row can never outlive its owner (D161). Track-owned,
   * so it ages out with the track under the one sweep that owns it.
   */
  'confirmationCrop',
  /**
   * A crop stored to EXPLAIN a decision, for a track the operator marked debug.
   *
   * Every other crop here is a model input: a tight box, padded just enough for
   * the network, deliberately excluding the background. That is exactly why
   * three marked traces took a day to read — the evidence for "this is a
   * mirror", "these two boxes were rescued as one object" or "the best shot sat
   * on the frame edge" is by definition OUTSIDE the box, and nothing on the
   * stored pixels said which decision they belonged to.
   *
   * So this one is the opposite by design: a wide context window (the union of
   * the boxes a decision compared, padded well past the subject and floored so
   * a small subject still arrives legible), with the decision, the rival and
   * the deciding numbers burnt into the image — because the media row has no
   * note column and a crop travels without its context.
   *
   * Multi-instance and track-owned: it ages out under the one sweep that owns
   * the track (D161), and it is written only for a debug-marked track, bounded
   * per track.
   */
  'debugCrop',
  /**
   * The CLEAN twin of a boxed timeline tile (D654): `firstFrame` / `snapshot` /
   * `lastFrame` all carry a burnt-in detection box, and a rule asking for the
   * clean scene ("Full frame") was being answered with an annotated one (19 of
   * 38 sampled deliveries). The twin is encoded from the SAME decoded surface
   * in the same write, at the tile's instant, with no box.
   *
   * History: first written 2026-09-03 and withdrawn the same day, while the
   * best-shot change was tried alone; the boxed full-frame deliveries persisted,
   * so D654 writes it again. Accumulating and track-owned: one per appended
   * tile (`firstFrame`, debug `snapshot`).
   */
  'sceneFrame',
  /**
   * The CLEAN twin of the rolling `lastFrame` (D654) — single-instance like the
   * tile it mirrors, so a roll (every 2 s per live track) is one upsert onto a
   * deterministic row, never an append plus a delete.
   */
  'lastSceneFrame',
])
export type MediaFileKind = z.infer<typeof MediaFileKindEnum>

/**
 * One media row's IDENTITY and shape, with no representation of its bytes.
 *
 * This is the half of a media row that is cheap: it comes out of the index
 * without opening a blob, and it is everything a client needs to decide what
 * to render before it renders anything. Both wire shapes below are this plus
 * an address; the STORE's own read-back shape ({@link MediaFileBytes}) is this
 * plus the bytes.
 */
const MediaFileRefSchema = z.object({
  /**
   * The media row's OWN id — the rowid SQLite assigned it (D482).
   *
   * It used to be the row's composite key, `<ownerType>:<ownerId>:<fileKind>
   * [:<timestampMs>]`, which embedded a FOREIGN id. D474 made event ids
   * per-table rowid aliases, so `object:101314` and `motion:101314` are two
   * different rows that spell the same number, and a track whose
   * `bestEventId` was an object event was served a motion event's snapshot —
   * a night-time thumbnail on an afternoon track, with no error anywhere. A
   * surrogate id cannot name the wrong row's owner, because it names no owner
   * at all.
   */
  mediaId: z.number().int(),
  // 'firstFrame' / 'lastFrame' / 'snapshot' (track-owned): full-frame captures
  // at a track's start / end / periodic instants, for the viewer's
  // trajectory-replay canvas (via getTrackMedia). ⚠ ALL THREE ARE ANNOTATED —
  // the track's own bbox is burned into the pixels by
  // `event-media-dispatcher.ts#boxedTimelineFrame`, and there is no clean
  // variant of them. This comment used to describe them as plain "full-frame
  // snapshots"; a notification ladder read that, treated them as the clean
  // scene, and shipped boxed frames to rules that had asked for an unannotated
  // one. The clean whole-scene kinds are 'keyFrame' / 'keyFrameSmall' /
  // 'fullFrame' / 'sceneFrame' (the clean twin of each tile, D654) — see
  // ANNOTATED_SCENE_KINDS in the notification centre.
  // (Event-owned 'snapshot' rows written by motion-event-snapshot.ts and the
  // synthetic-track path ARE clean — the annotation is a property of the
  // track-owned timeline tile, not of the kind name alone.)
  // 'fullFrame' / 'fullFrameBoxed': the detection frame at ORIGINAL resolution,
  // clear and with the box drawn, for the event detail view (vs the small
  // boxed 'thumbnail' clip-list preview).
  // 'faceCrop' / 'plateCrop': crops saved by addon-post-analysis per event.
  kind: MediaFileKindEnum,
  sizeBytes: z.number(),
  timestamp: z.number(),
})
export type MediaFileRef = z.infer<typeof MediaFileRefSchema>

/**
 * A media row AS STORED — its ref plus its bytes, base64.
 *
 * **This is not a wire shape and must never become one.** It is what
 * `MediaStore` reads back and what every server-side picker
 * (`pickCleanMedia`, `pickTrackFallbackMedia`, the last-frame promotion, the
 * track-close ladder) works over, because those decide BETWEEN blobs and then
 * hand exactly one of them to something that needs the pixels. A client never
 * gets this: it gets {@link MediaFile}, and fetches the bytes by URL.
 */
export interface MediaFileBytes extends MediaFileRef {
  readonly base64: string
}

/**
 * One media row ON THE WIRE: what it is, how big it is, and WHERE ITS BYTES
 * ARE — never the bytes themselves.
 *
 * ## Why `url` and not `base64`
 *
 * Measured on the live hub 2026-08-30: `getTrackMedia {trackId, deviceId}`
 * with no `kinds` returned 6 rows / **3 597 219 B**, of which `keyFrame` alone
 * was **2 824 077 B** — one full-resolution frame, base64, so +33 % on the
 * wire. Forty events is ~144 MB. Every byte of it was read off disk,
 * base64-encoded, held whole in a unary tRPC envelope, and materialised in
 * hub-main's heap on the way past — for an `<img>` that would have cached it.
 *
 * `url` points at the `event-media` data plane
 * (`/addon/<addonId>/event-media/m/<mediaId>` — D482), which serves the same blob
 * with an ETag and `Cache-Control: immutable`, honours conditional GETs, can
 * render a `?variant=thumb`, and streams. The hub gate in front of it requires
 * a bearer or the session cookie (`access: 'authenticated'`), so the bytes are
 * no less protected than they were inside a `view`-level cap response — see
 * `data-plane-access.ts` for the rule and the one gap it does not close
 * (per-device scoping).
 *
 * The URL is built from the row's own id, which since D482 says nothing about
 * the row's owner or kind — and that is the point. The published `kind` is not
 * the stored one (a track's face/plate crop is stored as `crop` under
 * `('face'|'plate', '<prefix>-<trackId>')` and published as
 * `faceCrop`/`plateCrop`), and under the old composite key the URL had to be
 * taken from `row.key` verbatim or it 404'd exactly those two rows. An id
 * cannot be mis-reconstructed, because there is nothing in it to reconstruct.
 *
 * ## `base64` is TRANSITIONAL and is going away
 *
 * It is still populated for one reason: the deployed viewer's track-detail
 * HERO tile reads it (`use-track-media-entry.ts` → `parseMediaFiles`, which
 * REQUIRES the field), and a row without it parses as a FAILED read — the red
 * triangle — not as absence. Removing the field before that viewer ships is an
 * outage, not a cleanup. Once the viewer takes its hero bytes from `url`,
 * delete this line and the `withBytes` pass-through in
 * `analytics-query-facade.ts`; nothing else reads it.
 */
const MediaFileSchema = MediaFileRefSchema.extend({
  /** `/addon/<addonId>/event-media/<encoded stored key>`. Always present. */
  url: z.string(),
  /** @deprecated Transitional — see the schema docblock. Use {@link url}. */
  base64: z.string(),
})
export type MediaFile = z.infer<typeof MediaFileSchema>

/**
 * One media row WITHOUT its bytes.
 *
 * A track's media is 5-8 MB of base64 (measured: 7.67 MB across 23 files for a
 * 140 s track), and a client that renders tiles from the media data plane needs
 * to know only WHAT EXISTS — the bytes then arrive per tile, lazily, over HTTP
 * with an immutable cache, instead of all at once inside a tRPC response that
 * blocks the whole view.
 *
 * `sizeBytes` is carried because it is what lets a client decide between the
 * stored blob and a `?variant=thumb` rendering without fetching either, and
 * `url` because a client that had to build the plane path itself is a second
 * copy of a route — the embed, the viewer and the admin UI each grew one.
 */
const MediaFileInfoSchema = MediaFileSchema.omit({ base64: true })
export type MediaFileInfo = z.infer<typeof MediaFileInfoSchema>

// ── Retrain curation (the retrain page) ───────────────────────────
/**
 * The MACRO tier of an annotation — a CLOSED set.
 *
 * This is what the exported detector predicts, so a typo here is a new class
 * with one example in it. `label` and `subLabel` are open strings by contrast:
 * the whole point of the page is teaching the model things it does not know
 * yet, and constraining that vocabulary would make it useless.
 *
 * A macro class is NEVER a label. The provider refuses a write whose `label` or
 * `subLabel` is one of these values, in any casing, because once `person`
 * exists in both tiers "every person box" stops being answerable without
 * knowing every string anyone ever typed — and the damage is retroactive.
 */
export const RetrainMacroClassSchema = z.enum([
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
])
export type RetrainMacroClass = z.infer<typeof RetrainMacroClassSchema>

/** A subject to learn, or a phantom to unlearn (taught by OMISSION). */
export const RetrainAnnotationKindSchema = z.enum(['subject', 'model_error'])
/**
 * Where a box came from. A machine-sourced box is a DRAFT on the page until
 * the operator confirms it; once saved it keeps its source as provenance.
 *
 * - `operator` — drawn by hand.
 * - `assist`   — proposed by a detector run on the copy (the camera's own
 *   model, or a larger teacher model).
 * - `pipeline` — the box the live pipeline actually drew on that frame, read
 *   back from the track store (never a re-run).
 * - `llm`      — proposed by a vision-capable LLM profile.
 */
export const RetrainAnnotationSourceSchema = z.enum(['operator', 'assist', 'pipeline', 'llm'])
export type RetrainAnnotationSource = z.infer<typeof RetrainAnnotationSourceSchema>

/** Normalised `[0,1]` rectangle against the FULL frame — the canonical form. */
const RetrainBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})

/**
 * What a box LOOKED LIKE when it was offered, snapshotted at the moment the
 * operator accepted it. The saved row keeps only the final rectangle; this is
 * the other half of the pair, and the pair is what says whether the operator
 * accepted, nudged, relabelled or replaced a proposal (`retrain-review.ts`).
 *
 * `ref` names the proposal inside its frame: `pipeline:<trackId>` for a box the
 * live pipeline drew, `assist:<n>` for the n-th box of a detector or LLM run,
 * and anything unique for an operator-drawn box (`operator:<n>`). Re-derived
 * pipeline boxes carry the same ref every time, which is what lets a dismissal
 * stay dismissed.
 */
export const RetrainOriginSchema = z.object({
  source: RetrainAnnotationSourceSchema,
  ref: z.string().min(1),
  bbox: RetrainBboxSchema,
  macroClass: RetrainMacroClassSchema,
  label: z.string().optional(),
  score: z.number().optional(),
  modelId: z.string().optional(),
})
export type RetrainOrigin = z.infer<typeof RetrainOriginSchema>

/**
 * A proposal the operator deleted. Durable on the frame, so a deleted pipeline
 * box does not come back as a draft every time the frame is reopened, and so
 * the deletion itself is a recorded fact rather than an absence.
 */
export const RetrainDismissedSchema = z.object({
  ref: z.string().min(1),
  snapshot: RetrainOriginSchema,
})
export type RetrainDismissed = z.infer<typeof RetrainDismissedSchema>

/** What the operator did with a proposal (see `retrain-review.ts`). */
export const RetrainReviewStatusSchema = z.enum(RETRAIN_REVIEW_STATUSES)
export type RetrainReviewStatus = z.infer<typeof RetrainReviewStatusSchema>

export const RetrainBoxReviewSchema = z.object({
  ref: z.string(),
  savedId: z.string().optional(),
  status: RetrainReviewStatusSchema,
  /** The baseline was re-derived, not snapshotted (a pre-origin row). */
  approximate: z.boolean(),
  origin: RetrainOriginSchema.optional(),
  /** The class / label the box carries NOW (a removed box: its origin's). Absent on an older hub. */
  macroClass: RetrainMacroClassSchema.optional(),
  label: z.string().optional(),
  iou: z.number().optional(),
})
export type RetrainBoxReview = z.infer<typeof RetrainBoxReviewSchema>

export const RetrainFrameReviewSchema = z.object({
  boxes: z.array(RetrainBoxReviewSchema).readonly(),
  summary: z.object({
    counts: z.record(RetrainReviewStatusSchema, z.number().int()),
    total: z.number().int(),
    changed: z.number().int(),
    approximate: z.boolean(),
  }),
})
export type RetrainFrameReview = z.infer<typeof RetrainFrameReviewSchema>

/**
 * One annotated subject.
 *
 * `bbox` is normalised against the full frame, ALWAYS. The per-model shapes
 * (letterboxed root / zone-cropped package / subject-cropped classifier) are
 * derived from it at export and never stored — storing them is how one feature
 * space ends up holding two crops of the same subject (D52).
 */
export const RetrainAnnotationSchema = z.object({
  id: z.string(),
  /** The frame's track. Absent on a recording still, which has none. */
  trackId: z.string().optional(),
  deviceId: z.number(),
  /** The COPY in retrain storage — never the source track's media key. */
  mediaKey: z.string(),
  bbox: RetrainBboxSchema,
  macroClass: RetrainMacroClassSchema,
  label: z.string().optional(),
  subLabel: z.string().optional(),
  kind: RetrainAnnotationKindSchema,
  source: RetrainAnnotationSourceSchema,
  /** Which model proposed this box — or, on a `model_error`, drew the phantom. */
  assistModelId: z.string().optional(),
  assistScore: z.number().optional(),
  /** The proposal this box started from, snapshotted at accept time. `null` on
   *  a row saved before origins existed; absent on a draft nobody snapshotted. */
  origin: RetrainOriginSchema.nullable().optional(),
  exportedInBatch: z.string().optional(),
  createdAt: z.number(),
})
export type RetrainAnnotation = z.infer<typeof RetrainAnnotationSchema>

/** The write form — the server owns `id`, `createdAt` and the frame binding. */
export const RetrainAnnotationDraftSchema = RetrainAnnotationSchema.omit({
  id: true,
  trackId: true,
  deviceId: true,
  mediaKey: true,
  createdAt: true,
  exportedInBatch: true,
})
export type RetrainAnnotationDraft = z.infer<typeof RetrainAnnotationDraftSchema>

/** A track sitting in `staging`, with everything the worklist needs to rank it. */
export const RetrainTrackSchema = z.object({
  trackId: z.string(),
  deviceId: z.number(),
  className: z.string(),
  label: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  /** How many frames the dataset already holds from this track. */
  frameCount: z.number().int(),
  /** How many subjects have been annotated on those frames. `0` with
   *  `frameCount: 0` is exactly "staging, still to work". */
  annotationCount: z.number().int(),
})
export type RetrainTrack = z.infer<typeof RetrainTrackSchema>

/** A frame the picker may offer — an index row, no blob was read to produce it. */
export const RetrainFrameCandidateSchema = z.object({
  mediaId: z.number().int(),
  kind: MediaFileKindEnum,
  timestamp: z.number(),
  sizeBytes: z.number().int(),
  /** A copy of this original already exists — selecting it is free and cannot
   *  fail, whatever became of the original. */
  copied: z.boolean(),
})
export type RetrainFrameCandidate = z.infer<typeof RetrainFrameCandidateSchema>

/**
 * One box the live pipeline drew on a copied frame — what a correction starts
 * from. Derived when the frame is listed, from the track store: the subject
 * box recorded on the source media row when there is one, else the track
 * position nearest the frame's capture time. Never stored as an annotation
 * until the operator confirms it.
 */
export const RetrainPipelineBoxSchema = z.object({
  /** Normalised `[0,1]` against the full frame. */
  bbox: RetrainBboxSchema,
  macroClass: RetrainMacroClassSchema,
  label: z.string().optional(),
  subLabel: z.string().optional(),
  /** The detection score of the position used, when it was recorded. */
  score: z.number().optional(),
  /** The root model that produced the track, when it was recorded. */
  modelId: z.string().optional(),
  trackId: z.string(),
  /** `subject-box`: recorded on this very frame. `position`: the track's
   *  position nearest the capture time, `deltaMs` away. */
  basis: z.enum(['subject-box', 'position']),
  deltaMs: z.number(),
})
export type RetrainPipelineBox = z.infer<typeof RetrainPipelineBoxSchema>

/**
 * Where a retrain frame came from: a TRACK's stored media (copy-on-select),
 * or the RECORDING at an instant — the frame a model saw nothing in has no
 * track at all.
 */
export const RetrainFrameOriginSchema = z.enum(['track', 'recording'])
export type RetrainFrameOrigin = z.infer<typeof RetrainFrameOriginSchema>

/** A frame the dataset OWNS: bytes copied at selection time. */
export const RetrainFrameSchema = z.object({
  frameId: z.string(),
  deviceId: z.number(),
  origin: RetrainFrameOriginSchema,
  /** The track it was copied from. Absent on a recording still. */
  trackId: z.string().optional(),
  /** Provenance only. It may already point at nothing — that is expected.
   *  Absent on a recording still. */
  sourceMediaId: z.number().int().optional(),
  /** A recording still: the playhead instant it was taken at. */
  epochMs: z.number().optional(),
  sourceKind: MediaFileKindEnum,
  sizeBytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  copiedAt: z.number(),
  /** When the CAMERA captured the frame. Absent on a copy taken before D785. */
  capturedAt: z.number().optional(),
  /** The operator's "every subject in this frame is boxed". Detector
   *  evaluation keeps only complete frames: an unboxed subject would count as
   *  a false positive. */
  complete: z.boolean(),
  /** The boxes the pipeline drew on this frame. Present on list answers;
   *  empty when nothing the track store holds can be placed on it. */
  pipelineBoxes: z.array(RetrainPipelineBoxSchema).readonly().optional(),
  /** The named collections this frame belongs to. Present on list answers. */
  collectionIds: z.array(z.string()).readonly().optional(),
  /** Bumped by every annotation save. A save that names a stale
   *  `expectedRevision` is refused, so two surfaces cannot overwrite each other. */
  revision: z.number().int().optional(),
  /** Proposals the operator deleted — never re-seeded as drafts. */
  dismissed: z.array(RetrainDismissedSchema).readonly().optional(),
  /** What the operator did with the proposals, computed by the server. */
  review: RetrainFrameReviewSchema.optional(),
  /** The frame's pixels over the admin data plane (full size). Fetch with the
   *  admin bearer token; relative to the hub root. */
  imageUrl: z.string().optional(),
  /** The same, as a ~480 px thumbnail for grids. */
  thumbnailUrl: z.string().optional(),
})
export type RetrainFrame = z.infer<typeof RetrainFrameSchema>

/** Why a copy-on-select could not be honoured — named, never a silent skip. */
export const RetrainCopyRefusalSchema = z.enum([
  /** The original is gone. It blocks THIS selection and nothing else. */
  'source-missing',
  'unreadable-image',
  'write-failed',
])

export const RetrainFrameSelectionSchema = z.object({
  copied: z.array(RetrainFrameSchema).readonly(),
  refused: z
    .array(z.object({ sourceMediaId: z.number().int(), reason: RetrainCopyRefusalSchema }))
    .readonly(),
})
export type RetrainFrameSelection = z.infer<typeof RetrainFrameSelectionSchema>

export const RetrainFrameListSchema = z.object({
  candidates: z.array(RetrainFrameCandidateSchema).readonly(),
  copies: z.array(RetrainFrameSchema).readonly(),
  /** What the page pre-selects — the native key frame when one survives. */
  autoPickMediaId: z.number().int().optional(),
})
export type RetrainFrameList = z.infer<typeof RetrainFrameListSchema>

/** Exclusive partition of a corpus copy's annotation progress (design §4.2). */
export const RetrainFrameWorkStateSchema = z.enum(['unannotated', 'annotated', 'complete'])
export type RetrainFrameWorkState = z.infer<typeof RetrainFrameWorkStateSchema>

/**
 * Filters for paginated corpus list, KPI, and matching export (design §4.4).
 * Every narrowing field is ANDed; omitted fields impose no constraint.
 */
export const RetrainCorpusFilterSchema = z.object({
  workState: RetrainFrameWorkStateSchema.optional(),
  deviceIds: z.array(z.number()).max(500).optional(),
  /** When set, only frames in this named collection. */
  collectionId: z.string().optional(),
  /** Frames that carry at least one saved annotation in one of these classes. */
  classes: z.array(RetrainMacroClassSchema).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
})
export type RetrainCorpusFilter = z.infer<typeof RetrainCorpusFilterSchema>

/**
 * One row on the Frames corpus grid: a wire frame plus its exclusive work
 * state (`workStateOf`), so the UI can badge To do / In progress / Complete
 * when the filter is All (annotation counts are not otherwise on the wire).
 */
export const RetrainCorpusPageFrameSchema = RetrainFrameSchema.extend({
  workState: RetrainFrameWorkStateSchema,
})
export type RetrainCorpusPageFrame = z.infer<typeof RetrainCorpusPageFrameSchema>

export const RetrainCorpusPageSchema = z.object({
  frames: z.array(RetrainCorpusPageFrameSchema).readonly(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})
export type RetrainCorpusPage = z.infer<typeof RetrainCorpusPageSchema>

export const RetrainCorpusKpiCameraRowSchema = z.object({
  deviceId: z.number(),
  unannotated: z.number().int().nonnegative(),
  annotated: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  /** This camera's `complete` count divided by corpus `total`, in `[0,1]`.
   *  `null` when the corpus is empty (no ratio). */
  pctOfCorpus: z.number().min(0).max(1).nullable(),
})
export type RetrainCorpusKpiCameraRow = z.infer<typeof RetrainCorpusKpiCameraRowSchema>

export const RetrainCorpusKpiSchema = z.object({
  total: z.number().int().nonnegative(),
  unannotated: z.number().int().nonnegative(),
  annotated: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  cameras: z.array(RetrainCorpusKpiCameraRowSchema).readonly(),
})
export type RetrainCorpusKpi = z.infer<typeof RetrainCorpusKpiSchema>

/**
 * Which frames an annotated export carries. Every field narrows; an empty
 * filter is every annotated copy. `frameIds` is the primitive a job or
 * download uses; `batchId` re-selects what an earlier export carried
 * (`exportedInBatch`). Frozen dataset versions were removed — live selection
 * resolves to `frameIds` at plan/start.
 */
export const RetrainExportFilterSchema = z.object({
  deviceIds: z.array(z.number()).optional(),
  frameIds: z.array(z.string()).max(20_000).optional(),
  /** Only frames in at least one of these named collections. */
  collectionIds: z.array(z.string()).max(200).optional(),
  /** Single collection (Frames filter bar). ANDed with `collectionIds` when both set. */
  collectionId: z.string().optional(),
  batchId: z.string().optional(),
  /** Only frames the operator marked complete (all subjects boxed). */
  completeOnly: z.boolean().optional(),
  /** Exclusive work-state partition (`workStateOf`); same as the corpus list. */
  workState: RetrainFrameWorkStateSchema.optional(),
  /** Frames with at least one saved annotation in one of these classes. */
  classes: z.array(RetrainMacroClassSchema).optional(),
})
export type RetrainExportFilter = z.infer<typeof RetrainExportFilterSchema>

/**
 * `frames`: the full frame copies, boxes in `annotations.json`.
 * `crops`: additionally one JPEG per subject, cut with the runtime detail-crop
 * convention — the classifier layout.
 */
export const RetrainExportLayoutSchema = z.enum(['frames', 'crops'])
export type RetrainExportLayout = z.infer<typeof RetrainExportLayoutSchema>

/**
 * Where `writeRetrainArchive` streams the tar: one HTTP request whose body is
 * the archive, sent chunk by chunk. Covers a presigned PUT and a provider
 * addon's data-plane upload route alike. Headers are sent verbatim and never
 * logged.
 */
export const RetrainArchiveTargetSchema = z.object({
  kind: z.literal('http'),
  method: z.enum(['PUT', 'POST']),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
})
export type RetrainArchiveTarget = z.infer<typeof RetrainArchiveTargetSchema>

export const RetrainArchiveResultSchema = z.object({
  batchId: z.string(),
  frames: z.number().int(),
  crops: z.number().int(),
  annotations: z.number().int(),
  /** Frames planned but not shipped (unreadable copy, path too long). */
  missing: z.number().int(),
  bytes: z.number().int(),
  /** sha256 of the exact bytes sent. */
  sha256: z.string(),
  /** The target's HTTP status. */
  status: z.number().int(),
})
export type RetrainArchiveResult = z.infer<typeof RetrainArchiveResultSchema>

/** What the operator asked the assist to look for. */
export const RetrainAssistSubjectSchema = z.discriminatedUnion('kind', [
  /** `rfdetr-package` at 0.35 on the ZONE only. Without a zone it refuses. */
  z.object({ kind: z.literal('package'), zone: RetrainBboxSchema.optional() }),
  /** The root detector on the whole frame. */
  z.object({ kind: z.literal('objects'), modelId: z.string(), minScore: z.number().optional() }),
])

/**
 * The assist's answer — a discriminated union, because "the model saw nothing"
 * and "this node cannot run that model" lead to different next moves and a
 * nullable result cannot tell them apart.
 */
export const RetrainAssistResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proposed'),
    modelId: z.string(),
    stepId: z.string(),
    minScore: z.number(),
    /** Drafts, ready to edit. `source: 'assist'` until the operator touches one. */
    proposals: z.array(RetrainAnnotationDraftSchema).readonly(),
    /** Returned by the runner but removed by the threshold. */
    belowThreshold: z.number().int(),
  }),
  z.object({
    kind: z.literal('refused'),
    /** `no-zone` is ours; the rest are the runner's own refusal vocabulary. */
    reason: z.string(),
    detail: z.string().optional(),
  }),
])
export type RetrainAssistResult = z.infer<typeof RetrainAssistResultSchema>

/** A named set over the retrain corpus — membership only, it owns no pixels. */
export const RetrainCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  frameCount: z.number().int(),
})
export type RetrainCollection = z.infer<typeof RetrainCollectionSchema>

export const RetrainCollectionCreateResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), collection: RetrainCollectionSchema }),
  z.object({ kind: z.literal('refused'), reason: z.enum(['empty-name', 'duplicate-name']) }),
])
export type RetrainCollectionCreateResult = z.infer<typeof RetrainCollectionCreateResultSchema>

export const RetrainCollectionRenameResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('renamed'), collection: RetrainCollectionSchema }),
  z.object({
    kind: z.literal('refused'),
    reason: z.enum(['empty-name', 'duplicate-name', 'unknown-collection']),
  }),
])
export type RetrainCollectionRenameResult = z.infer<typeof RetrainCollectionRenameResultSchema>

/**
 * The outcome of adding the frame at a recording instant. Every refusal is
 * named: `still-unavailable` (not recording, a gap, or an undecodable frame —
 * `detail` says which), `still-busy` (the recorder is at its decode bound; try
 * again), `unreadable-image`, `write-failed`, `unknown-collection`.
 */
export const AddRetrainFrameFromRecordingResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('added'),
    collectionId: z.string(),
    frame: RetrainFrameSchema,
    /** The moment was already in the dataset; nothing was decoded. */
    reused: z.boolean(),
  }),
  z.object({
    kind: z.literal('refused'),
    reason: z.enum([
      'unknown-collection',
      'still-unavailable',
      'still-busy',
      'unreadable-image',
      'write-failed',
    ]),
    detail: z.string().optional(),
  }),
])
export type AddRetrainFrameFromRecordingResult = z.infer<
  typeof AddRetrainFrameFromRecordingResultSchema
>

/** A vision LLM profile the AI assist may use, and where it sends the frame. */
export const RetrainAssistProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  kind: z.string(),
  /** `true` when the frame would leave the house (a cloud vendor, or an
   *  endpoint that is not on the local network). The page confirms each such
   *  run, and the provider refuses one without `allowCloud`. */
  leavesHouse: z.boolean(),
})
export type RetrainAssistProfile = z.infer<typeof RetrainAssistProfileSchema>

/** A box the AI assist proposed: a draft, plus the model's own reason. */
export const RetrainLlmProposalSchema = RetrainAnnotationDraftSchema.extend({
  reason: z.string(),
})
export type RetrainLlmProposal = z.infer<typeof RetrainLlmProposalSchema>

/** What the AI assist said about a box that was already on the canvas. */
export const RetrainLlmReviewSchema = z.object({
  /** The `ref` the page sent the box under. */
  ref: z.string(),
  verdict: z.enum(['confirmed', 'wrong-class', 'not-an-object', 'uncertain']),
  suggestedClass: RetrainMacroClassSchema.optional(),
  reason: z.string(),
})
export type RetrainLlmReview = z.infer<typeof RetrainLlmReviewSchema>

/**
 * The AI assist's answer. `proposed` carries drafts (`source: 'llm'`, the
 * model and its confidence) and reviews; items the model got wrong (a box off
 * the frame, an unasked class, an unknown ref) are dropped and counted in
 * `rejected`. A whole answer that is not the schema is `malformed-answer`.
 */
export const RetrainLlmAssistResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proposed'),
    profileId: z.string(),
    model: z.string(),
    /** The frame was sent outside the house for this answer. */
    leftHouse: z.boolean(),
    proposals: z.array(RetrainLlmProposalSchema).readonly(),
    reviews: z.array(RetrainLlmReviewSchema).readonly(),
    rejected: z.number().int(),
  }),
  z.object({
    kind: z.literal('refused'),
    reason: z.enum([
      'unknown-frame',
      'unreadable-frame',
      'unknown-profile',
      'profile-disabled',
      'no-vision',
      'cloud-not-confirmed',
      'llm-error',
      'malformed-answer',
    ]),
    detail: z.string().optional(),
  }),
])
export type RetrainLlmAssistResult = z.infer<typeof RetrainLlmAssistResultSchema>

/** What a dataset version is cut from. Every field narrows. */
export const RetrainDatasetSelectionSchema = z.object({
  deviceIds: z.array(z.number()).readonly().optional(),
  collectionIds: z.array(z.string()).max(200).readonly().optional(),
  frameIds: z.array(z.string()).max(20_000).readonly().optional(),
})
export type RetrainDatasetSelection = z.infer<typeof RetrainDatasetSelectionSchema>

/** The counts a dataset is judged by. */
export const RetrainDatasetStatsSchema = z.object({
  frames: z.number().int(),
  completeFrames: z.number().int(),
  /** `completeFrames / frames`, 0..1. */
  completeness: z.number(),
  /** Boxes to learn (model errors excluded). */
  subjects: z.number().int(),
  modelErrors: z.number().int(),
  /** Complete frames with no subject. */
  hardNegatives: z.number().int(),
  /** Subjects per class × camera × day/night. */
  cells: z
    .array(
      z.object({
        macroClass: z.string(),
        deviceId: z.number(),
        lighting: z.enum(['day', 'night', 'unknown']),
        subjects: z.number().int(),
        frames: z.number().int(),
      }),
    )
    .readonly(),
  cameras: z
    .array(
      z.object({
        deviceId: z.number(),
        frames: z.number().int(),
        completeFrames: z.number().int(),
      }),
    )
    .readonly(),
})
export type RetrainDatasetStats = z.infer<typeof RetrainDatasetStatsSchema>

/**
 * Shape of a historically frozen dataset version (stats + selection). Kept for
 * typed stats/selection helpers and any leftover rows; no public freeze API.
 */
export const RetrainDatasetVersionSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  selection: RetrainDatasetSelectionSchema,
  layout: RetrainExportLayoutSchema,
  completeOnly: z.boolean(),
  frameCount: z.number().int(),
  annotationHash: z.string(),
  manifestSchema: z.string(),
  stats: RetrainDatasetStatsSchema,
})
export type RetrainDatasetVersion = z.infer<typeof RetrainDatasetVersionSchema>

/**
 * Live training corpus criteria — same shape as `TrainingCorpusSelection` on
 * the training cap. Resolved here so plan/start and the annotated export share
 * one definition of "the frames" (`buildRetrainExportPlan`).
 */
export const RetrainTrainingCorpusSelectionSchema = z.object({
  collectionIds: z.array(z.string()).min(1),
  workState: z.enum(['complete', 'annotated_or_complete', 'any_annotated']).default('complete'),
})
export type RetrainTrainingCorpusSelection = z.infer<typeof RetrainTrainingCorpusSelectionSchema>

export const RetrainTrainingCorpusResolveResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resolved'),
    frameIds: z.array(z.string()).max(20_000).readonly(),
    stats: RetrainDatasetStatsSchema,
    annotationHash: z.string(),
    layout: RetrainExportLayoutSchema,
  }),
  z.object({
    kind: z.literal('refused'),
    reason: z.enum(['unknown-collection', 'no-frames']),
    detail: z.string(),
  }),
])
export type RetrainTrainingCorpusResolveResult = z.infer<
  typeof RetrainTrainingCorpusResolveResultSchema
>

/** The outcome of a lifecycle move owned by the retrain page. */
export const RetrainTransitionResultSchema = z.object({
  trackId: z.string(),
  /** Where the track ended up, whatever happened. */
  retrainStatus: RetrainStatusSchema,
  /** `false` ⇒ the move was refused or was a no-op; `reason` says which. */
  changed: z.boolean(),
  reason: z
    .enum(['unknown-track', 'no-frames-copied', 'not-staging', 'not-trained', 'unchanged'])
    .optional(),
})
export type RetrainTransitionResult = z.infer<typeof RetrainTransitionResultSchema>

// ── Query input schemas ─────────────────────────────────────────────

// Hard cap on event-list responses. Without it, queries against the
// 1M+ row analytics tables (audio classifier inserts ~1500 rows/min
// per active camera) return every row + classification blob, blow
// past the tRPC 5s default, and OOM the JSON serializer. Callers
// needing more than MAX in one batch should paginate via since/until.
const DEFAULT_EVENT_QUERY_LIMIT = 1000
const MAX_EVENT_QUERY_LIMIT = 5000

const DeviceEventQueryInput = z.object({
  deviceId: z.number(),
  since: z.number().optional(),
  until: z.number().optional(),
  limit: z.number().int().min(1).max(MAX_EVENT_QUERY_LIMIT).default(DEFAULT_EVENT_QUERY_LIMIT),
  /** `slim` drops heavy JSON fields (regions/bbox/zones) and carries an
   *  optional `mediaUrl` (populated by B5). `full` (default) keeps today's
   *  exact behaviour. Callers may omit this field — the store defaults to
   *  `full` when not provided. */
  projection: z.enum(['full', 'slim']).optional(),
})

const ObjectEventQueryInput = DeviceEventQueryInput.extend({
  classFilter: z.string().optional(),
})

// ── Batched cluster-wide track listing (events page / reel first paint) ──
//
// One call replaces the N-per-camera `listTracks` fan-out: the provider
// merges the requested devices server-side, sorted by `lastSeen` DESC with
// a stable opaque cursor, so the client issues ONE request per page instead
// of one per camera (first paint no longer blocks on the slowest camera).

const RECENT_TRACKS_DEFAULT_LIMIT = 200
const RECENT_TRACKS_MAX_LIMIT = 1000

const RecentTracksQueryInput = z.object({
  /** Devices to merge. An empty array yields `{ tracks: [], nextCursor: null }`. */
  deviceIds: z.array(z.number()),
  /** Window lower bound on `lastSeen` (inclusive). */
  since: z.number().optional(),
  /** Window upper bound on `lastSeen` (inclusive). */
  until: z.number().optional(),
  /** Page size. Default 200, max 1000. */
  limit: z.number().int().min(1).max(RECENT_TRACKS_MAX_LIMIT).default(RECENT_TRACKS_DEFAULT_LIMIT),
  /** Opaque continuation cursor from a previous page's `nextCursor`.
   *  Encodes the (lastSeen, trackId) sort position — treat as opaque. */
  cursor: z.string().optional(),
  /** See {@link TrackProjectionSchema}. Default `full`. */
  projection: TrackProjectionSchema.optional(),
  /** Include stationary-promoted rows (parked objects). Default false: the
   *  feed lists passages; parking records live on the stationary registry. */
  includeStationary: z.boolean().optional(),
  /**
   * Restrict to these track classes. ABSENT or EMPTY means no filter.
   *
   * The same filter `listTracks` takes, because the timeline's class chips must
   * mean the same thing whether the scope is one camera or twelve. Until this
   * existed the scoped feed downloaded a page and narrowed it on the phone
   * while the single-camera path narrowed the read — one filter, two costs.
   *
   * A SUPERSET prefilter on `classes[]`, like its single-camera twin: rows
   * whose class list is unreadable are kept, and the client's rule stays the
   * exact one.
   */
  classes: z.array(z.string()).optional(),
  /** See {@link ExcludeSourcesDoc}. */
  excludeSources: z.array(TrackSourceSchema).optional(),
})
export type RecentTracksQuery = z.infer<typeof RecentTracksQueryInput>

const RecentTracksPageSchema = z.object({
  /** Merged page, ordered by (`lastSeen` DESC, `trackId` DESC). */
  tracks: z.array(TrackSchema).readonly(),
  /** Cursor for the next page, or null when this page is the last. */
  nextCursor: z.string().nullable(),
})
export type RecentTracksPage = z.infer<typeof RecentTracksPageSchema>

// ── Key events (importance-ranked highlights) ───────────────────────
//
// A compact, sortable projection of a completed track for the viewer's
// events page + a future reels feature. One entry per track, carrying the
// server-computed importance score and a pointer to the track's best event.

const KEY_EVENTS_DEFAULT_LIMIT = 50
const KEY_EVENTS_MAX_LIMIT = 200

const KeyEventQueryInput = z.object({
  deviceId: z.number(),
  /** Window lower bound (track firstSeen ≥ since). */
  since: z.number(),
  /** Window upper bound (track firstSeen ≤ until). */
  until: z.number(),
  limit: z.number().int().min(1).max(KEY_EVENTS_MAX_LIMIT).default(KEY_EVENTS_DEFAULT_LIMIT),
  /** Drop tracks scoring below this importance. */
  minImportance: z.number().min(0).max(1).optional(),
  /** Restrict to a single class (e.g. 'person'). */
  classFilter: z.string().optional(),
})

const KeyEventSchema = z.object({
  /** The representative event id (the track's best ObjectEvent, else its trackId). */
  id: z.string(),
  trackId: z.string(),
  /** Track start time (firstSeen). */
  timestamp: z.number(),
  className: z.string(),
  // BOTH tiers, for the same reason the flags are here: the events grid renders
  // one row per track from the feed it already fetched, and `subLabel ?? label`
  // cannot be evaluated from a row that carries only half of it.
  ...TieredLabelFields,
  importance: z.number(),
  /** Highest-confidence ObjectEvent id for the track (empty when none). */
  bestEventId: z.string(),
  /** Track lifetime in ms (lastSeen - firstSeen). */
  windowMs: z.number().optional(),
  // Same shape as `Track.audioLabels` (D189): an `audio` className alone is the
  // taxonomy macro; the heard labels (speech, glass_breaking, …) ride here so
  // the admin card can show the macro without a second `getTrack`. Absent on
  // rows with no confident audio, exactly as on a Track.
  audioLabels: z.array(TrackAudioLabelSchema).readonly().optional(),
  // Carried on the row so the events grid can render each toggle's state from
  // the feed it already fetched — one row per track, so the flags belong here
  // rather than behind a second per-card `getTrack`. The lifecycle status rides
  // along for the same reason: a `trained` badge cannot be derived from the
  // boolean, which reads `false` on a trained track exactly as on an untouched one.
  ...TrackFlagFields,
  ...TrackRetrainFields,
})
export type KeyEvent = z.infer<typeof KeyEventSchema>

/** `getKeyEvents`' window and filters, asked of a SET of cameras at once. */
const KeyEventBatchQueryInput = z.object({
  deviceIds: z.array(z.number()).min(1).max(200),
  since: z.number(),
  until: z.number(),
  /** Applied PER CAMERA, exactly as `getKeyEvents.limit` is — never a total
   *  across the set, which would let a busy camera starve a quiet one of its
   *  rows and change what the merged feed contains. */
  limit: z.number().int().min(1).max(KEY_EVENTS_MAX_LIMIT).default(KEY_EVENTS_DEFAULT_LIMIT),
  minImportance: z.number().min(0).max(1).optional(),
  classFilter: z.string().optional(),
})

/**
 * One camera's key events in a batch answer.
 *
 * The row exists for every requested id. `getKeyEvents` degrades to `[]` on
 * error rather than throwing, so a camera whose store read failed and one with
 * no events in the window were ALREADY indistinguishable per camera — the
 * batch does not make that worse, and the row keeps the deviceId the single
 * method's output never carried (the caller used to stamp it from the fan-out
 * key, which only worked because there was one query per camera).
 */
const KeyEventsForDeviceSchema = z.object({
  deviceId: z.number(),
  events: z.array(KeyEventSchema).readonly(),
})
export type KeyEventsForDevice = z.infer<typeof KeyEventsForDeviceSchema>

// ── Density (timeline histogram) ────────────────────────────────────

/** One non-empty bucket of the timeline histogram. */
export const EventDensityBucketSchema = z.object({
  bucketStart: z.number(),
  motion: z.number().int(),
  object: z.number().int(),
  audio: z.number().int(),
  /**
   * Energy-weighted mean dBFS of the audio events in this bucket — the LEVEL,
   * as opposed to `audio`, which is their COUNT (D431).
   *
   * ABSENT when the bucket holds no audio event. Absence means "nothing was
   * measured", which is not the same claim as silence, and a lane that cannot
   * tell them apart paints a quiet hour at full scale — which is exactly what
   * the count-on-a-level-meter did.
   */
  audioDbfs: z.number().optional(),
})
export type EventDensityBucket = z.infer<typeof EventDensityBucketSchema>

/**
 * Most cameras one `getEventDensityBatch` may name.
 *
 * The same ceiling the sibling batches on this cap already carry
 * (`listEventKindsBatch`, `getKeyEventsBatch`): a tablet grid is tens of
 * cameras, never hundreds, and one call's answer is N × (window / bucketMs)
 * buckets crossing a process boundary.
 *
 * The ceiling is on the SCHEMA, not only on the caller. An over-eager ask is
 * REFUSED — never truncated to the first {@link EVENT_DENSITY_BATCH_MAX} ids,
 * because that answer is indistinguishable from a complete one and the caller
 * would never learn it asked too much. A caller with more cameras sends
 * ⌈n/max⌉ calls.
 */
export const EVENT_DENSITY_BATCH_MAX = 200

/**
 * One camera's row in a `getEventDensityBatch` answer.
 *
 * TWO facts, and the timeline draws them differently:
 *
 *  - `read: 'read'` — the histogram for this camera. `buckets: []` is a real
 *    claim: read, and nothing happened in the window.
 *  - `read: 'unreadable'` — nobody could answer for this camera. `buckets` is
 *    empty and that emptiness means NOTHING; the timeline must render unknown,
 *    not quiet.
 *
 * Fanned out per camera the difference was free — one query rejected while the
 * others resolved — and collapsing to a batch is the exact moment it is lost
 * silently. Every requested id gets a row: a caller that asked for twelve and
 * got eleven cannot tell which one is missing, or that any is.
 */
export const EventDensityForDeviceSchema = z.object({
  deviceId: z.number(),
  read: z.enum(['read', 'unreadable']),
  buckets: z.array(EventDensityBucketSchema).readonly(),
})
export type EventDensityForDevice = z.infer<typeof EventDensityForDeviceSchema>

// ── Enriched frame emitted on bus after refinement ──────────────────
//
// Lightweight: carries only the tracked-detection metadata consumers
// need to overlay track IDs / zones on a live stream. Full Track state
// is queryable via getActiveTracks / getTrack.

const TrackedDetectionSchema = z.object({
  trackId: z.string(),
  className: z.string(),
  confidence: z.number(),
  bbox: BoundingBoxSchema,
  zones: z.array(z.string()).readonly(),
  state: TrackStateSchema,
})

// ── Overlay detection entry on the enriched frame emit ──────────────
//
// Mirrors the ObjectDetection wire shape consumed by DetectionCanvas /
// the viewer overlay: first-level roots pass through from the inference
// frame; `kind:'detail'` entries (face/plate) are SYNTHESIZED per frame
// from per-track detail state (two-plane re-injection). Loose: masks,
// refinedBbox and debug ride along untouched.
const OverlayDetectionSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['first-level', 'detail']),
  macroClass: z.string(),
  score: z.number(),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  labels: z.array(z.looseObject({ label: z.string(), score: z.number() })).readonly(),
  parentId: z.string().optional(),
})

// ── Semantic search (CLIP text→event) ──────────────────────────────

export const ScoredObjectEventSchema = ObjectEventSchema.extend({ score: z.number() })
export type ScoredObjectEvent = z.infer<typeof ScoredObjectEventSchema>

const SearchObjectEventsInput = z.object({
  text: z.string(),
  deviceId: z.number().optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  classFilter: z.string().optional(),
  limit: z.number().default(50),
  /**
   * An ABSOLUTE cosine floor. Optional since D649: a floor is a property of the
   * model (0.2 kept 96% of matched pairs on MobileCLIP S1 and 2.7% on SigLIP2),
   * so an absent one resolves to the searched model's own `searchMinScore`
   * scaled by `strictness`. A number sent here is honoured verbatim.
   */
  minScore: z.number().min(0).max(1).optional(),
  /** Model-relative floor — see `resolveClipSearchMinScore`. Default `loose`. */
  strictness: ClipSearchStrictnessSchema.optional(),
  /**
   * Search THIS CLIP model's index instead of the cluster row's. Every index a
   * model ever wrote stays searchable until it is wiped (the MobileCLIP index
   * through a SigLIP2 cutover and its rollback window). An id with no CLIP
   * metadata is refused; an id other than the cluster row's is ADMIN-only
   * (`model-override-requires-admin`).
   */
  modelId: z.string().min(1).optional(),
})

// ── Track-centric retention cascade counts ──────────────────────────
//
// The track is the ROOT of the analytics data model; retention/deletion
// cascades from it to every derived entity (design §2–5). A cascade run
// reports the per-family deleted totals.
//
// `tracks` is the AUTHORITATIVE headline — the number of persisted track
// roots removed. The leaf families (`events`/`media`/`faces`/`plates`/
// `embeddings`) are reported best-effort: the extensible `TrackScopedStore`
// cascade (design §3) deletes them via a `Promise<void>` contract that does
// not surface per-store totals, so leaf counts default to 0 until the store
// return types are widened (out of the retention-cascade scope). Operators
// read `tracks` for the "clean slate" confirmation.
const TrackCascadeCountsSchema = z.object({
  /** Persisted track roots deleted (authoritative). */
  tracks: z.number().int(),
  /** Object events removed with their tracks (best-effort; see note above). */
  events: z.number().int(),
  /** Track/face/plate-owned media removed (best-effort). Never identity media. */
  media: z.number().int(),
  /** Unassigned (non-enrolled) face reads removed (best-effort). */
  faces: z.number().int(),
  /** Unassigned plate reads removed (best-effort; plate leg deferred to plate-intelligence). */
  plates: z.number().int(),
  /** Per-track CLIP search vectors removed (best-effort). */
  embeddings: z.number().int(),
})
export type TrackCascadeCounts = z.infer<typeof TrackCascadeCountsSchema>

/** Disk-wins reconcile: media rows whose blobs are gone, then empty tracks. */
const DiskReconcileCountsSchema = z.object({
  mediaDropped: z.number().int(),
  tracks: z.number().int(),
  events: z.number().int(),
})
export type DiskReconcileCounts = z.infer<typeof DiskReconcileCountsSchema>

// ── Events management (footprint + prune + ops-log) ─────────────────
//
// The durable event store's disk footprint for the management UI: event ROWS
// (motion + object + audio) counted per camera, plus the event-owned media
// BYTES on disk. Mirrors the recorder's `getStorageUsage` shape (per-device +
// total) so the admin UI renders both domains the same way.

/** Event-store footprint for one camera. */
const EventStoreDeviceFootprintSchema = z.object({
  deviceId: z.number(),
  /** Persisted event rows (motion + object + audio) for the camera. */
  rows: z.number().int(),
  /** Event-owned media bytes on disk for the camera. */
  bytes: z.number().int(),
})
export type EventStoreDeviceFootprint = z.infer<typeof EventStoreDeviceFootprintSchema>

/** Aggregate event-store footprint: global totals + per-camera breakdown. */
const EventStoreFootprintSchema = z.object({
  totalRows: z.number().int(),
  totalBytes: z.number().int(),
  devices: z.array(EventStoreDeviceFootprintSchema).readonly(),
})
export type EventStoreFootprint = z.infer<typeof EventStoreFootprintSchema>

/** Event-media footprint for one {@link MediaFileKind}. */
const EventMediaKindFootprintSchema = z.object({
  kind: MediaFileKindEnum,
  /** Media rows of this kind. */
  rows: z.number().int(),
  /** Bytes on disk held by those rows. */
  bytes: z.number().int(),
})
export type EventMediaKindFootprint = z.infer<typeof EventMediaKindFootprintSchema>

/**
 * The media footprint broken down by KIND — the axis a deletion decision
 * actually turns on.
 *
 * A byte total says how much there is; it cannot say what is safe to remove.
 * The deletable set (the periodic `snapshot` filmstrip, the surplus per-edge
 * motion stills) and the keep set (`firstFrame`, rolling `lastFrame`,
 * `thumbnail`/`thumbnailSmall`, `keyFrame`/`keyFrameSmall`, the face/plate
 * buffers, gallery media, the CLIP `crop`) are distinguished by `kind` and by
 * nothing else, so sizing a deletion means summing per kind.
 *
 * ## Why `unaccounted*` exists
 *
 * `kinds` is enumerated from {@link MediaFileKindEnum} — the closed set the
 * writers use — and summed one kind at a time. `totalRows` / `totalBytes` come
 * from a SEPARATE unfiltered aggregate over the same rows, never from adding
 * `kinds` up. A row whose stored `kind` is not in the enum (written by a
 * retired code path, or by a version that knew a kind this one does not) would
 * otherwise vanish from the total silently, and an operator would delete
 * against a denominator smaller than the disk.
 *
 * `unaccountedRows` / `unaccountedBytes` are the difference. They are normally
 * zero; a non-zero value is a real finding and must be shown, not rounded away.
 */
const EventMediaKindBreakdownSchema = z.object({
  /** Every media row in scope, from one unfiltered aggregate. */
  totalRows: z.number().int(),
  /** Every media byte in scope, from that same aggregate. */
  totalBytes: z.number().int(),
  /** Per-kind footprint, ordered by bytes descending. */
  kinds: z.array(EventMediaKindFootprintSchema).readonly(),
  /** `totalRows` minus the summed `kinds` rows — see the schema note. */
  unaccountedRows: z.number().int(),
  /** `totalBytes` minus the summed `kinds` bytes — see the schema note. */
  unaccountedBytes: z.number().int(),
})
export type EventMediaKindBreakdown = z.infer<typeof EventMediaKindBreakdownSchema>

/** Per-kind counts returned by the event-prune / device-delete mutations. */
const EventPruneCountsSchema = z.object({
  motion: z.number().int(),
  object: z.number().int(),
  audio: z.number().int(),
})
export type EventPruneCounts = z.infer<typeof EventPruneCountsSchema>

// ── Capability definition ───────────────────────────────────────────

/**
 * Re-embed stored tracks from their key frames.
 *
 * The reason this is an operator-callable method and not a migration script:
 * every knob that decides what a vector MEANS — encoder model, crop margin,
 * squaring — is only changeable if the existing vectors can be regenerated.
 * Mixing feature spaces in one index makes cosine scores incomparable, and the
 * symptom is a quality regression with no visible cause.
 */
const RebuildObjectEmbeddingsInput = z.object({
  /** Restrict to one camera. Omit for the whole fleet. */
  deviceId: z.number().optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  // NO `cropMargin` / `square` here, deliberately. They were a PER-CALL crop
  // convention, which is what let one rebuild disagree with the live path and
  // with the previous rebuild — three feature spaces in one index. The crop
  // convention is now a single cluster-wide `pipeline-orchestrator` setting
  // applied by the runner for BOTH paths; a per-call override would reintroduce
  // the split under a friendlier name. Change the setting, then rebuild.
  /** Stop after this many tracks; the result reports whether more remain. */
  maxTracks: z.number().int().positive().optional(),
  /**
   * Run every embedding on THIS node instead of round-robining the fleet.
   *
   * Named `executeOnNodeId` and not `nodeId` on purpose: an inline `nodeId`
   * field in cap args is read by `parent-unowned-call.ts` as a ROUTING PIN, so
   * calling it that would pin the rebuild REQUEST itself to that node — the
   * rebuild orchestration lives on the hub, and only the per-track step runs
   * remotely. This field is data; the per-track pin is applied inside.
   *
   * Absent ⇒ round-robin over every online node whose runner can serve the
   * pinned model.
   */
  executeOnNodeId: z.string().optional(),
  /**
   * Milliseconds to wait between tracks; omit for the built-in default, `0` to
   * run flat out.
   *
   * A rebuild is bulk maintenance on hub-main's single thread. Measured
   * 2026-08-06, an unpaced pass held that thread busy 82.2 s out of 120 and
   * pushed `nodes.topology` from 0.25 s to 26 s for 43 minutes. The value in
   * force is logged at start and finish so a deliberately slow pass reads
   * differently from a stalled one.
   */
  pacingMs: z.number().int().nonnegative().optional(),
  /**
   * Re-embed ONLY the tracks whose vector is ALREADY in the pinned model's
   * space (D664) — the in-space skip inverted. It exists to redo vectors
   * written from the wrong box, which a normal pass would skip as done
   * forever. Requires `maxTracks`: a forced pass without a bound is refused
   * (`force-requires-max-tracks`).
   */
  force: z.boolean().optional(),
})

/**
 * Result of emptying the CLIP index.
 *
 * The clean slate before a policy change: a new crop margin or encoder model
 * leaves two feature spaces in one index whose cosine scores are not
 * comparable, so wiping and rebuilding is the only way to be sure every vector
 * means the same thing.
 */
const WipeObjectEmbeddingsResultSchema = z.object({
  deleted: z.number(),
  /**
   * CLIP indexes that could NOT be emptied (unreachable, or refused at their
   * dimension) — not a clean slate. Additive and optional (D649).
   */
  failedIndexes: z.array(z.string()).optional(),
})

/**
 * Why a rebuild did not start, BY NAME — ONE vocabulary for both gates in front
 * of a pass (D649 over D651). A bare `started: false` read the same for "the
 * stores are booting" and "the cluster row names a model with no CLIP
 * metadata", which need different fixes.
 *  - `stores-unavailable` — the analytics stores or the API are not up yet.
 *  - the owner's confirmation of the cluster model (D651, `ClusterPinConfirmer`):
 *    a pass that rewrites an index needs two agreeing reads of the OWNER's
 *    answer (`pipelineOrchestrator.getClusterModelChoice`) — a pass that cannot
 *    name its model does not run (D54):
 *    - the owner's own `unreadable` reasons (`owner-not-ready`,
 *      `store-read-failed`, `three-way-read-unavailable`, `invalid-stored`,
 *      `not-cluster-scoped`);
 *    - `method-unavailable` — the orchestrator predates the method;
 *    - `read-failed` — the call failed or answered something unparseable;
 *    - `reads-disagree` — the two reads named different choices.
 *  - `not-a-clip-model` — the CONFIRMED id has no CLIP metadata, so there is no
 *    index to fill and no dimension to check against (D649).
 *  - `force-requires-max-tracks` — `force: true` with no `maxTracks` (D664).
 */
export const RebuildObjectEmbeddingsRefusalSchema = z.enum([
  'stores-unavailable',
  ...CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS,
  'method-unavailable',
  'read-failed',
  'reads-disagree',
  'not-a-clip-model',
  'force-requires-max-tracks',
])

export type RebuildObjectEmbeddingsRefusal = z.infer<typeof RebuildObjectEmbeddingsRefusalSchema>

/**
 * Acknowledgement that a rebuild STARTED.
 *
 * The pass costs ~1s per track — 45 minutes for a 2,600-track fleet — so it
 * runs detached and this returns immediately. Waiting for it made the client
 * time out while the work carried on server-side, which is the worst of both:
 * no result and no way to know it was still going. Poll
 * `getObjectEmbeddingRebuildStatus` for progress.
 */
const RebuildObjectEmbeddingsResultSchema = z.object({
  started: z.boolean(),
  /** True when a pass was already running; the new request is ignored. */
  alreadyRunning: z.boolean(),
  /** Present when the pass refused to start — see `RebuildObjectEmbeddingsRefusalSchema`. */
  refusal: RebuildObjectEmbeddingsRefusalSchema.optional(),
  /** The CLIP model the pass pinned, and the index it fills (when it started). */
  modelId: z.string().optional(),
  index: z.string().optional(),
})

const RebuildStatusSchema = z.object({
  running: z.boolean(),
  scanned: z.number(),
  rebuilt: z.number(),
  /** Tracks whose key frame is gone — nothing to re-embed from. Pixels ONLY:
   *  `missingEvent` is its own field since D664, never summed in. */
  missingKeyFrame: z.number(),
  /** Tracks with no object event at all (D664). */
  missingEvent: z.number(),
  /** Tracks with no box measured on the pixels to cut — see `boxSource.refused`. */
  missingBbox: z.number(),
  /**
   * Which rule placed each judged track's box (D664): the key frame row's own
   * `subjectBox`, `track.positions` at exactly its instant (older key frames),
   * the event box (a key frame recovered from the recording, at the event's
   * instant), or `refused` by name — the reasons are in the tagged log lines.
   */
  boxSource: z.object({
    subjectBox: z.number(),
    positions: z.number(),
    event: z.number(),
    refused: z.number(),
  }),
  /** Tracks skipped because their vector is already in the pinned space. */
  alreadyInSpace: z.number(),
  /** Whether the current / last pass was a `force` pass; `null` before any (D664). */
  force: z.boolean().nullable(),
  /** In-space tracks a `force` pass selected for re-embedding. */
  forcedInSpace: z.number(),
  /**
   * Tracks an executing node REFUSED rather than broke on — an unreadable key
   * frame, a step that threw. Separate from `failed` because the remedy is
   * different, and because a whole camera silently contributing zero vectors
   * is the shape of failure a rebuild must never hide.
   */
  notRunnable: z.number(),
  /**
   * The pass stopped because NO node could serve the pinned model.
   *
   * Distinct from `notRunnable` on purpose: that one says "this track was
   * refused", this one says "the cluster cannot do this work at all" — every
   * candidate node either lacks the `clip-embedding` step, lacks a build of the
   * pinned model for its engine format, or dropped out. The remedy is a model /
   * engine change, not a per-camera one. Non-zero here always comes with
   * `complete: false`.
   */
  noCapableNode: z.number(),
  failed: z.number(),
  /** Set once a pass ends: true only when EVERYTHING was covered. */
  complete: z.boolean().nullable(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  /** Present when the pass ended by throwing. */
  error: z.string().nullable(),
  /** The CLIP model the current / last pass pinned (D54), `null` before any. */
  modelId: z.string().nullable(),
  /** The index that pass fills — `ClipModelMeta.vectorIndex` of `modelId` (D649). */
  index: z.string().nullable(),
})

/**
 * Acknowledgement that a debug-media reclaim STARTED.
 *
 * The pass is paced at ~2 MB/s over a standing 100 GB — tens of minutes — so
 * it runs detached and this returns immediately. Awaiting it is how the
 * `addons.custom` door hit the 60 s UDS deadline while the walk carried on
 * with no status. Poll {@link pipelineAnalyticsCapability.methods.getMediaReclaimStatus}.
 */
const MediaReclaimStartResultSchema = z.object({
  started: z.boolean(),
  /** True when a pass was already running; the new request is ignored. */
  alreadyRunning: z.boolean(),
})

const MediaReclaimInputSchema = z.object({
  mode: z.enum(['report', 'reclaim']).default('report'),
  scopes: z
    .array(z.enum(['motion-still', 'track-filmstrip']))
    .min(1)
    .optional(),
  deviceIds: z.array(z.number().int()).min(1).optional(),
  restart: z.boolean().optional(),
  pageSize: z.number().int().min(50).max(5_000).optional(),
  maxRowsPerDevice: z.number().int().min(1).max(500_000).optional(),
  maxReclaimPerDevice: z.number().int().min(1).max(500_000).optional(),
  maxBytesPerRun: z.number().int().min(1).optional(),
  budgetMinutes: z.number().int().min(1).max(720).optional(),
  throttleBytesPerSec: z
    .number()
    .int()
    .min(64 * 1024)
    .optional(),
  graceMinutes: z.number().int().min(1).max(10_080).optional(),
})

const MediaReclaimStatusSchema = z.object({
  running: z.boolean(),
  mode: z.enum(['report', 'reclaim']).nullable(),
  totalExamined: z.number(),
  totalEligible: z.number(),
  totalReclaimed: z.number(),
  totalBytesReclaimed: z.number(),
  totalRefused: z.number(),
  /** Device+scope windows finished in this pass. */
  devicesDone: z.number(),
  complete: z.boolean().nullable(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  error: z.string().nullable(),
})

/**
 * The long-term series a camera produces. A closed union so a typo cannot
 * invent one, and the ONE declaration of it — the addon's `AnalyticsLtsSeries`
 * is an alias of this, not a second list.
 */
export const AnalyticsLtsSeriesSchema = z.enum(['motion', 'audio-dbfs', 'battery', 'occupancy'])

/**
 * The separator between a scope's PLACE and its CLASS.
 *
 * A zone id is a uuid and never contains it, so the grammar cannot be
 * ambiguous. It lives HERE, in types, because a writer in the addon and a
 * reader in the viewer that each spell the scope their own way are two
 * authorities on one string — and the one that drifts fails silently, as an
 * empty chart.
 */
export const LTS_SCOPE_CLASS_SEPARATOR = '|'

/**
 * Spell one occupancy scope.
 *
 * `occupancyScope()` → `''` (frame, every class)
 * `occupancyScope('z1')` → `'z1'` (zone, every class)
 * `occupancyScope(undefined, 'person')` → `'|person'`
 * `occupancyScope('z1', 'person')` → `'z1|person'`
 *
 * The two aggregate spellings are the ones that existed before the class
 * dimension and they mean exactly what they always did.
 */
export function occupancyScope(zoneId?: string, className?: string): string {
  const place = zoneId ?? ''
  return className === undefined ? place : `${place}${LTS_SCOPE_CLASS_SEPARATOR}${className}`
}

/** Read a scope back. An absent `className` means "aggregates every class". */
export function parseOccupancyScope(scope: string): {
  readonly zoneId: string
  readonly className?: string
} {
  const at = scope.indexOf(LTS_SCOPE_CLASS_SEPARATOR)
  if (at < 0) return { zoneId: scope }
  return { zoneId: scope.slice(0, at), className: scope.slice(at + 1) }
}

/**
 * One closed 5-minute bucket of a long-term series.
 *
 * `samples` is how many readings the bucket folded — it is the ACTIVITY for a
 * series like `motion`, and the confidence for one like `occupancy`. A bucket
 * that exists at all was measured; a bucket that is absent was not, which is a
 * different claim from zero and the reason this is a sparse series.
 */
export const LtsBucketSchema = z.object({
  scope: z.string(),
  bucketStart: z.number().int(),
  samples: z.number().int().nonnegative(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
})
export type LtsBucket = z.infer<typeof LtsBucketSchema>

export const pipelineAnalyticsCapability = {
  name: 'pipeline-analytics',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  exposesDeviceSettings: true,
  methods: {
    // ── Tracks ────────────────────────────────────────────────
    getActiveTracks: method(z.object({ deviceId: z.number() }), z.array(TrackSchema).readonly()),
    getTrack: method(
      z.object({ deviceId: z.number(), trackId: z.string() }),
      TrackSchema.nullable(),
    ),
    /** Historical completed tracks for a device. Queried from the
     *  persisted `pipeline-analytics:tracks` collection; active tracks
     *  still in RAM are not included. */
    listTracks: method(
      z.object({
        deviceId: z.number(),
        since: z.number().optional(),
        until: z.number().optional(),
        limit: z.number().optional(),
        /** Spatial filter — only tracks whose trajectory intersects the zone
         *  (normalized 0..1 rect or polygon). SQL-prefiltered on the persisted
         *  envelope columns, then precisely tested per position. Tracks with
         *  an unknown envelope (no frame dims at persist time) always match. */
        zone: TrackZoneFilterSchema.optional(),
        /** See {@link TrackProjectionSchema}. Default `full` (backward
         *  compatible — omitting the field keeps today's exact behaviour). */
        projection: TrackProjectionSchema.optional(),
        /** Include stationary-promoted rows (parked objects handed to the
         *  stationary registry). Default false: the timeline lists passages,
         *  not parking records (operator decision, 2026-08-15). */
        includeStationary: z.boolean().optional(),
        /**
         * Restrict to these track classes. ABSENT or EMPTY means no filter.
         *
         * Added 2026-09-03: the timeline's class chips filtered in the CLIENT,
         * on a day of rows already downloaded. The zone filter had been moved
         * here for exactly that reason — and it is also what lets the rows come
         * back `slim` — but the class filter was left behind, so a narrow
         * selection was still a wide read followed by a wide discard.
         *
         * Empty is "show all", not "nothing matches": a chip row with nothing
         * selected is an operator who has not narrowed anything, and an empty
         * timeline would read as a camera that saw nothing.
         */
        classes: z.array(z.string()).optional(),
        /** See {@link ExcludeSourcesDoc}. */
        excludeSources: z.array(TrackSourceSchema).optional(),
      }),
      z.array(TrackSchema).readonly(),
    ),
    /**
     * Batched cluster-wide track listing — ONE call for the events page /
     * reel first paint instead of a per-camera `listTracks` fan-out. Merges
     * the persisted completed tracks of every requested device, sorted by
     * `lastSeen` DESC with a stable (lastSeen, trackId) cursor. Per-device
     * indexed pages (`idx_tracks_device_lastSeen`) are k-way merged
     * provider-side; `projection: 'slim'` drops the heavy `positions[]` /
     * `snapshots[]` JSON (returned as empty arrays). Active in-RAM tracks
     * are not included (same contract as `listTracks`).
     */
    listRecentTracks: method(RecentTracksQueryInput, RecentTracksPageSchema),

    clearTracks: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Events (per-kind, parallel-queryable) ─────────────────
    getMotionEvents: method(DeviceEventQueryInput, z.array(MotionEventSchema).readonly()),
    getObjectEvents: method(ObjectEventQueryInput, z.array(ObjectEventSchema).readonly()),
    getAudioEvents: method(DeviceEventQueryInput, z.array(AudioEventSchema).readonly()),

    // ── Extensible per-device event kinds ─────────────────────
    /**
     * Every event kind the device can produce: built-ins (motion + audio),
     * detection classes actually observed for the device (from the track
     * history), and sensor kinds contributed by LINKED devices (resolved via
     * `device-manager.getLinkedDevices`, mapped through `EVENT_KIND_BY_CAP`).
     */
    listEventKinds: method(
      z.object({ deviceId: z.number() }),
      z.array(EventKindDescriptorSchema).readonly(),
    ),

    /**
     * The same answer for many cameras in ONE call.
     *
     * `listEventKinds` is the slowest per-device query on the hub — measured
     * at ~100 ms against 6-11 ms for its neighbours — because composing it
     * costs a `getCameraStatus`, a `getLinkedDevices` and one `getBindings`
     * per linked device. The viewer asks for it once per camera at first
     * paint, so twelve cameras paid twelve of those round-trips on top of the
     * per-camera cost.
     *
     * Batched, the camera statuses come from ONE `getCameraStatuses` instead
     * of N, and the per-device composition runs concurrently.
     *
     * Per-device rather than pre-merged on purpose: a caller that renders one
     * camera's lanes needs to know WHICH camera a kind came from, and merging
     * is three lines the caller can do. `listEventKinds` stays for
     * single-device callers.
     */
    listEventKindsBatch: method(
      z.object({ deviceIds: z.array(z.number()).min(1).max(200) }),
      z.array(EventKindsForDeviceSchema).readonly(),
    ),

    /**
     * Sensor-event history for a camera: state changes of LINKED sensor
     * devices, attributed to the camera at ingest time (one row per linked
     * camera). Mirrors `getAudioEvents` query semantics; `kinds` narrows to
     * a kind subset.
     */
    getSensorEvents: method(
      z.object({
        deviceId: z.number(),
        since: z.number().optional(),
        until: z.number().optional(),
        kinds: z.array(z.string()).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_EVENT_QUERY_LIMIT)
          .default(DEFAULT_EVENT_QUERY_LIMIT),
      }),
      z.array(SensorEventSchema).readonly(),
    ),

    // ── Key events (importance-ranked highlights) ─────────────
    /**
     * Importance-ranked highlights for a device+window. Queries completed
     * tracks by (deviceId, firstSeen ∈ [since,until]), scores each (or reuses
     * the persisted score), filters by minImportance/classFilter, orders by
     * importance desc, and returns up to `limit` compact key events mapped to
     * each track's best event. Legacy tracks lacking a persisted score are
     * scored on-read (no write). Degrades to `[]` on error.
     */
    getKeyEvents: method(KeyEventQueryInput, z.array(KeyEventSchema).readonly()),

    /**
     * The same ranking, for a SET of cameras, in one round trip.
     *
     * The Detection Intelligence events feed asks this of every selected
     * camera and re-asks on a 30s timer. Fanned out client-side that is N
     * round trips — browser → hub → post-analysis — for N independent,
     * already-indexed store queries. Batched, the queries are unchanged and
     * run concurrently INSIDE the owner; only the transport collapses.
     *
     * Deliberately per-device rather than pre-merged: `limit` stays per
     * camera (a total would let a busy camera starve a quiet one), and a
     * caller that renders one camera's lane needs to know which camera a row
     * came from. `getKeyEvents` stays for single-device callers.
     */
    getKeyEventsBatch: method(
      KeyEventBatchQueryInput,
      z.array(KeyEventsForDeviceSchema).readonly(),
    ),

    // ── Density (timeline histogram) ──────────────────────────
    /** Server-side bucketed event counts for the 24-hour timeline.
     *  Returns one entry per non-empty bucket; empty buckets are omitted. */
    /**
     * Read one camera's long-term series — 5-minute buckets, kept for a year.
     *
     * This is the history surface for every chart that used to be served from a
     * RAM ring: the ring dies with the process, cannot answer about last night,
     * and had a 60-minute horizon, while these rows are ~60 bytes and already
     * written. `scope` is the series' own dimension — for `occupancy`, spell it
     * with {@link occupancyScope} rather than by hand, and omit it to get every
     * scope back at once (the caller then groups with
     * {@link parseOccupancyScope}).
     *
     * Bounds are inclusive on the BUCKET START, so a range that ends mid-bucket
     * still returns the bucket it lands in — the alternative is a chart whose
     * last column silently disappears for five minutes out of every five.
     */
    readLongTermSeries: method(
      z.object({
        deviceId: z.number(),
        series: AnalyticsLtsSeriesSchema,
        /** Omit for EVERY scope of this series in the range. */
        scope: z.string().optional(),
        from: z.number(),
        to: z.number(),
        limit: z.number().int().positive().optional(),
      }),
      z.array(LtsBucketSchema).readonly(),
    ),

    getEventDensity: method(
      z.object({
        deviceId: z.number(),
        since: z.number(),
        until: z.number(),
        bucketMs: z.number().int().positive(),
      }),
      z.array(EventDensityBucketSchema).readonly(),
    ),

    /**
     * The same histogram, for a SET of cameras, in one round trip.
     *
     * A multi-camera timeline (the tablet grid) re-asks this of every camera in
     * the grid on every day change — N browser → hub → post-analysis round
     * trips for N independent, already-indexed store queries. The queries are
     * unchanged and still run per camera (`densityByKind`, one per deviceId,
     * concurrently INSIDE the owner); only the transport collapses.
     *
     * Deliberately per-device rather than pre-merged: a timeline lane belongs
     * to a camera, and a caller that merged would have to un-merge.
     * `getEventDensity` stays for single-camera callers.
     *
     * Every requested id gets a row, marked — see
     * {@link EventDensityForDeviceSchema}. `deviceIds` is capped at
     * {@link EVENT_DENSITY_BATCH_MAX}, and an over-cap ask is refused rather
     * than truncated.
     */
    getEventDensityBatch: method(
      z.object({
        deviceIds: z.array(z.number()).min(1).max(EVENT_DENSITY_BATCH_MAX),
        since: z.number(),
        until: z.number(),
        bucketMs: z.number().int().positive(),
      }),
      z.array(EventDensityForDeviceSchema).readonly(),
    ),

    // ── Maintenance ───────────────────────────────────────────
    /**
     * @deprecated Prefer `pruneTracksBefore` — the track is the ROOT of the
     * analytics model and retention must cascade from it (design §5.1). This
     * event-only prune leaves orphaned tracks/faces/plates/embeddings behind.
     * Retained as a compat shim for the Phase-B3 recorder orchestration caller,
     * which prunes events to keep history aligned with available footage and
     * reads the per-kind counts. Delete all events (motion + object + audio)
     * for the given device older than `cutoffMs` (exclusive) + their thumbnails
     * in lockstep; returns per-kind deleted counts.
     */
    pruneEventsBefore: method(
      z.object({ deviceId: z.number(), cutoffMs: z.number() }),
      z.object({ motion: z.number().int(), object: z.number().int(), audio: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Track-centric retention entry point (design §5.1). Selects every
     * persisted track for the device whose `lastSeen < cutoffMs` (paged) and
     * runs the extensible whole-track deletion cascade (design §3): object
     * events + their media, track/face/plate-owned media, unassigned face
     * reads, per-track CLIP embeddings, then the track root LAST. ENROLLED
     * (assigned) faces/plates and `ownerKind:'identity'` media are exempt —
     * the durable matching gallery always persists. Fires the per-track
     * live-state cleanup so a pruned track can't linger in dispatch/overlay
     * state. Returns per-family deleted counts (`tracks` authoritative).
     *
     * Replaces `pruneEventsBefore` as the correct time-based retention prune.
     */
    pruneTracksBefore: method(
      z.object({ deviceId: z.number(), cutoffMs: z.number() }),
      TrackCascadeCountsSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Operator "clean slate" for a device (design §5.3): prune EVERY track for
     * the device via the same cascade as `pruneTracksBefore` with `cutoffMs =
     * now`. One call per device — no client-side track enumeration. Enrolled
     * gallery + identity media are exempt (design §4). Returns per-family
     * deleted counts.
     */
    wipeAllAnalytics: method(z.object({ deviceId: z.number() }), TrackCascadeCountsSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Disk-wins reconcile for one camera. Drops media index rows whose blobs
     * are gone, then cascades tracks (including favourited and staging) that
     * have no remaining files. Enrolled identity/vehicle/scene media is never
     * probed. Trackless motion/audio events with no remaining file are dropped,
     * including snapshot-less rows.
     */
    reconcileFromDisk: method(z.object({ deviceId: z.number() }), DiskReconcileCountsSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Delete whole tracks (object events) by id for the given device,
     * cascading their media in lockstep. Returns the number of tracks
     * actually deleted plus the ids that could not be removed.
     *
     * Operator-driven from the DI Events page (batch delete). Routes through
     * the same widened track-deletion cascade (design §5.2).
     *
     * `sparedMediaIds` (D683 Task 14): media rows the cascade LEFT because a
     * live stationary entry vouches for them (its key frame, owned by a track
     * that moved and was kept). Released when the entry retires. Optional:
     * absent from a provider that predates it.
     */
    deleteTracks: method(
      z.object({ deviceId: z.number(), trackIds: z.array(z.string()).min(1) }),
      z.object({
        deleted: z.number().int(),
        failed: z.array(z.string()).readonly(),
        sparedMediaIds: z.array(z.number().int()).readonly().optional(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Set the per-track operator flags (`markForTrain`, `debug`, `favourited`) on ONE track.
     * The patch is PARTIAL — an omitted key is left untouched — because the
     * three surfaces that write it (admin Events grid, viewer track detail,
     * viewer cluster detail) each own one toggle and must not clobber the other.
     *
     * Writes the track ROW: `markForTrain`/`debug` are per-TRACK state, so they
     * live where `label` and `importance` live, not in any per-device settings
     * store. Updates the in-RAM active track too, so a flag set on a live track
     * survives its expiry-time persist.
     *
     * `auth: 'protected'` (the default), NOT `admin`: the viewer is an
     * authenticated non-admin surface and two of the three call sites are
     * there. The note that used to sit here said to revisit this the day a flag
     * gained an effect that costs storage, and D81 is that day — `markForTrain`
     * now pins. It STAYS protected, and the reason is that the alternative
     * makes the feature pointless: marking a track is something you do while
     * looking at it, on the surface you were already looking at it on, and that
     * surface is the viewer. What the storage cost gets instead is a BOUND — a
     * per-device pin budget enforced in the body, refusing a new pin past the
     * limit while always allowing un-marking. `deleteTracks` next door is still
     * admin, because destroying evidence and preserving it are not symmetric.
     *
     * `markForTrain` writes the retrain LIFECYCLE, not a boolean column: `true`
     * is `none → staging`, `false` is `staging → none`. A track already
     * `trained` refuses BOTH — its frames are copies inside the retrain dataset
     * and re-staging it from a generic toggle is how the same material gets
     * annotated twice under two ground truths. Returning a trained track to
     * staging is a deliberate action of the retrain page, which is also the only
     * thing that produces `trained` in the first place.
     *
     * `debugNote` is the operator's sentence about WHAT to check on this track,
     * and it is bound to `debug`: writing `debug: false` clears it in the same
     * statement, and a note sent for a track whose debug is off (and is not
     * being turned on) is DROPPED with a warning rather than stored where
     * nothing will ever read it. An omitted `debugNote` leaves the stored one
     * alone — which is what lets a surface turn debug on when the operator
     * declined to type anything, without that refusal costing them the flag.
     *
     * Returns the RESOLVED state of all three flags (absent → `false`) plus the
     * note (absent → `''`) and the `retrainStatus` they were derived from, so a
     * caller can drive its toggle — and render a `trained` badge — without a
     * re-fetch. Rejects an unknown track, a new staging mark on a device already
     * holding its full budget, and any `markForTrain` write against a trained
     * track.
     */
    setTrackFlags: method(
      z.object({
        /** Log/audit scope only — the trackId is globally unique on its own. */
        deviceId: z.number(),
        trackId: z.string(),
        flags: TrackFlagsPatchSchema,
      }),
      TrackFlagsSchema,
      { kind: 'mutation' },
    ),

    /**
     * The archived debug notes, newest first — the corpus of what operators
     * have asked to be checked, across tracks that no longer exist (D405).
     *
     * `setTrackFlags` writes it: a patch carrying `debug: false` still clears
     * the note off the track row in the same statement (D353's invariant is
     * untouched), but the note is APPENDED here first. That is the whole point
     * — before D405, finishing a review destroyed every note written during it,
     * and the ones that survived aged out with their tracks. This method is the
     * only way to read what was kept.
     *
     * `auth: 'protected'`, matching `setTrackFlags` next door and for the same
     * reason: the notes are written from the viewer, by an authenticated
     * non-admin session, and a corpus only an admin can read is a corpus the
     * person who wrote it cannot use. It carries operator prose about cameras
     * and nothing else — no media, no paths, no identities beyond a track's
     * own display label.
     *
     * Newest-first, capped by `limit` (default
     * {@link ARCHIVED_DEBUG_NOTES_DEFAULT_LIMIT}), optionally one camera. The
     * table itself is bounded by row count, not by age — see
     * {@link MAX_ARCHIVED_DEBUG_NOTES} for why an age clock would be the wrong
     * bound for exactly this data.
     */
    listArchivedDebugNotes: method(
      ArchivedDebugNoteQueryInputSchema,
      z.array(ArchivedDebugNoteSchema).readonly(),
      { kind: 'query' },
    ),

    /**
     * Tracking-bench ground truth (D681): "this track and that one are the
     * same subject" / "different subjects". One row per unordered pair —
     * re-marking replaces it — and a mark that contradicts an existing chain
     * is REFUSED with the chain named. Writing a mark also sets `debug` on
     * both tracks. `protected`, matching `setTrackFlags`: marking is done from
     * the viewer's track detail by an authenticated non-admin session.
     */
    setTrackRelation: method(SetTrackRelationInputSchema, TrackRelationSchema, {
      kind: 'mutation',
    }),
    /** Remove the mark between two tracks. */
    clearTrackRelation: method(ClearTrackRelationInputSchema, ClearTrackRelationResultSchema, {
      kind: 'mutation',
    }),
    /**
     * A track that is not ONE subject: `mixed` (two subjects, optionally
     * switching at `switchAtMs`) or `not-a-subject`. `pure` clears the mark
     * and answers `{ purity: null }` (D681).
     */
    setTrackPurity: method(SetTrackPurityInputSchema, SetTrackPurityResultSchema, {
      kind: 'mutation',
    }),
    /** A camera's marks, optionally one track's, windowed by track start. */
    listTrackRelations: method(ListTrackRelationsInputSchema, ListTrackRelationsResultSchema, {
      kind: 'query',
    }),

    /**
     * Birth decisions — one row per resolved confirmation-gate verdict (D409).
     *
     * The READ half of a measurement, and only that: it gates nothing and no
     * runtime path consults it. It exists because the two questions the
     * operator's "traccia partita in ritardo" marks raised are both multi-day
     * and `logs.query` holds under an hour of fleet traffic —
     *   • how often is a birth DECIDED on a frame the subject was not observed
     *     in (`decidedOnCoastedFrame`), and did D379's carried pixels make it a
     *     real observation anyway (`decidedByBirthEvidence`);
     *   • how long after the camera's motion onset does a track's `firstSeen`
     *     land (`birthLatencyMs` — read its error bars in
     *     `BirthDecisionRecordSchema` before quoting it).
     *
     * Newest-first, capped by `limit` (default
     * {@link BIRTH_DECISION_DEFAULT_LIMIT}), optionally scoped to one camera,
     * one verdict, or a `since`. The table is bounded by row count, not age —
     * see {@link MAX_BIRTH_DECISION_RECORDS}.
     */
    listBirthDecisions: method(
      BirthDecisionQueryInputSchema,
      z.array(BirthDecisionRecordSchema).readonly(),
      { kind: 'query' },
    ),

    // ── Events management (footprint + prune + ops-log) ───────────
    /**
     * Durable event-store footprint for the management UI: event rows
     * (motion + object + audio) counted per camera + total, plus the
     * event-owned media bytes on disk per camera + total. Stat/count-based,
     * computed on demand.
     */
    getEventStoreFootprint: method(z.object({}), EventStoreFootprintSchema, {
      kind: 'query',
      auth: 'admin',
    }),

    /**
     * The same media footprint, broken down by {@link MediaFileKind} instead of
     * by camera — fleet-wide, or for one camera with `deviceId`.
     *
     * Separate from {@link getEventStoreFootprint} rather than a field on it:
     * the two answer different questions on different axes, the per-camera one
     * is what the management table renders on every open, and nothing should
     * pay for a per-kind pass to draw it. See
     * {@link EventMediaKindBreakdownSchema} for why `unaccounted*` exists —
     * `kinds` is enumerated, `totalBytes` is not, and the gap must be visible
     * to anyone sizing a deletion against it.
     */
    getEventMediaFootprintByKind: method(
      z.object({ deviceId: z.number().int().optional() }),
      EventMediaKindBreakdownSchema,
      { kind: 'query', auth: 'admin' },
    ),

    /**
     * Cluster-wide prune of events older than `olderThanMs` (exclusive) across
     * every camera, deleting each event's media in lockstep. Logged to the
     * events ops-log with `reason` (default `'retention'`). Returns the summed
     * per-kind deleted counts.
     */
    pruneEvents: method(
      z.object({ olderThanMs: z.number(), reason: OpsLogReasonSchema.optional() }),
      EventPruneCountsSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Manually delete EVERY event (motion + object + audio) for one camera and
     * its event-owned media in lockstep. Logged to the events ops-log as
     * `op:'manual-delete', reason:'manual'`. Destructive — the admin UI guards
     * it behind a confirm.
     */
    deleteDeviceEvents: method(z.object({ deviceId: z.number() }), EventPruneCountsSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** The events ops-log rows (newest-first), optionally scoped to one camera.
     *  Backed by a declared pipeline-analytics SQLite collection. */
    /** Internal migration-participant lease. It drains active MediaStore
     * writes and refuses new ones without changing analytics bindings. */
    pauseForStorageMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ paused: z.literal(true) }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    resumeForStorageMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ resumed: z.literal(true) }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    /** Drops cached location roots after the storage coordinator repoints a
     * default so future event-media writes use the new root. */
    refreshStorageLocationsForMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ refreshed: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    startStorageMigrationMove: method(
      StorageMigrationMediaMoveInputSchema,
      z.object({ jobId: z.string() }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    getStorageMigrationMoveStatus: method(
      z.object({ jobId: z.string() }),
      RelocateJobSchema.nullable(),
      { auth: 'admin' },
    ),
    cancelStorageMigrationMove: method(
      z.object({ jobId: z.string() }),
      z.object({ cancelled: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Moves event media between locations — the OPERATOR's mover, without the
     * coordinator's lease. Twin of `recording.relocateFootage`: the same
     * engine the lease-gated coordinated migration uses
     * (`startStorageMigrationMove`), armable in the background and WITHOUT
     * pausing anything. Exists because `eventMedia` was the only storage
     * class whose only move path went through the recorder's global pause.
     */
    relocateMedia: method(RelocateMediaInputSchema, z.object({ jobId: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * How many media / retrain rows still carry NO `locationId`.
     *
     * A NULL row means "wherever `eventMedia` points NOW", so the instant a
     * repoint moves that pointer every such row reads from the new disk while
     * its bytes are on the old one — the archive goes dark until a drain
     * happens to stamp it. This count is what the migration planner's
     * non-blocking gate reads; `relocateMedia({ mode: 'seal' })` is what drives
     * it to zero.
     *
     * TWO indexed statements per collection, not a walk. It used to page the
     * whole collection at 200 rows per RPC ordered by an unindexed column, so
     * on the live hub — 1 254 576 rows — it hit the 60 s RPC deadline every
     * time it was called, and the migration it gates could never start. The
     * cheap question (`present`: is there at least one) is asked first and
     * separately from the expensive one (`rows`), because only the first has
     * to be answerable for the gate to do its job.
     *
     * **`null` is "not measurable", never zero** — at either level. An
     * unreadable collection must not read as a sealed one.
     */
    countUnstampedEventMedia: method(z.object({}), UnstampedEventMediaCountSchema, {
      auth: 'admin',
    }),
    /**
     * How many rows a pass would STILL act on against `toLocationId`.
     *
     * One derivation, two consumers: it is the media lane's denominator (the
     * **M** the footage lane gets from the ledger census — D295) and it is the
     * residue behind "drain remaining". Deriving them separately is how "N of M"
     * ends up comparing two different populations.
     *
     * `null` means the count could not be taken; it is never zero-filled,
     * because a zero here reads as "nothing left to move".
     */
    countRelocatableMedia: method(RelocatableMediaCountInputSchema, RelocatableMediaCountSchema, {
      kind: 'query',
      auth: 'admin',
    }),
    /** Every relocate job this addon knows about, newest first (in RAM: the
     *  move is resumable, so a lost list costs nothing but the display). */
    listRelocateMediaJobs: method(z.object({}), z.array(RelocateJobSchema).readonly(), {
      kind: 'query',
      auth: 'admin',
    }),
    /** Cancel a running or queued relocate job. */
    cancelRelocateMedia: method(
      z.object({ jobId: z.string() }),
      z.object({ cancelled: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    listOpsLog: method(OpsLogQueryInputSchema, z.array(OpsLogEntrySchema).readonly(), {
      kind: 'query',
      auth: 'admin',
    }),
    /**
     * Reclaim the standing debug-media backlog (motion-visit stills + track
     * filmstrips). DETACHED: returns `{ started }` immediately. The pass is
     * tens of minutes; awaiting it is a timeout, not a verdict. Dry-run unless
     * `mode: 'reclaim'`. Poll `getMediaReclaimStatus`.
     */
    reclaimDebugMedia: method(MediaReclaimInputSchema, MediaReclaimStartResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    getMediaReclaimStatus: method(z.object({}), MediaReclaimStatusSchema, {
      kind: 'query',
      auth: 'admin',
    }),

    // ── Training export ───────────────────────────────────────
    /**
     * The CHEAP QUESTION, asked before any media moves: how big is the dataset
     * the marked (`markForTrain`) tracks would produce?
     *
     * Answered from media INDEX rows only — key, kind, size, timestamp — so it
     * costs ~2 KB of reads per track and no blob reads at all. The measured harm
     * behind D56 was a bulk pass that read and base64'd every blob a track owned
     * before deciding anything, taking hub-main to 82 s busy out of 120; an
     * export is that same I/O shape, so it inherits the same discipline: know
     * the size, then decide.
     *
     * `truncated` reports that more marked tracks exist than one pass carries.
     * Empty `deviceIds` ⇒ every device that has marked tracks.
     */
    getTrainingExportSummary: method(
      z.object({ deviceIds: z.array(z.number()).optional() }),
      TrainingExportSummarySchema,
      { kind: 'query', auth: 'admin' },
    ),

    /**
     * Where to download the dataset archive.
     *
     * The BYTES do not come back through this cap — they come from the returned
     * data-plane URL, which streams a tar built entry by entry. A multi-gigabyte
     * archive base64'd through a unary RPC envelope would be held whole in
     * memory twice on a hub this repo has already OOM'd once (D9/D18 are the
     * same lesson about frames). `getDownloadUrl` on `recordingExport` is the
     * precedent, and this follows it deliberately.
     *
     * The archive contains a `manifest.json` FIRST, then the stored media
     * VERBATIM under `tracks/<deviceId>/<trackId>/…`. No crop is derived and no
     * model is run: a training set's pixels must be the pixels the pipeline saw.
     */
    getTrainingExportUrl: method(
      z.object({ deviceIds: z.array(z.number()).optional() }),
      z.object({ url: z.string() }),
      { kind: 'query', auth: 'admin' },
    ),

    // ── Retrain curation (the retrain page) ───────────────────────
    /**
     * The staging worklist for one camera, or for every camera that has one.
     *
     * Fetched ON DEMAND, over the staging set only — the page never scans
     * history, because making the working set small is the entire purpose of
     * the mark. Each row carries how many frames the dataset already holds from
     * the track and how many subjects were annotated on them, so
     * `frameCount: 0` reads as "still to work" without a second call per track.
     *
     * `auth: 'admin'`, unlike the viewer-level mark itself: marking a track is
     * curation you do while looking at it, but building the training set the
     * fleet's models are fine-tuned on is not.
     */
    listRetrainStaging: method(
      z.object({
        /** Empty ⇒ every camera that has staging tracks. A LIST, not a single
         *  `deviceId`, deliberately: `deviceId` would make this device-bound and
         *  route it at one camera's owner, and "every camera" would stop being
         *  expressible at all. */
        deviceIds: z.array(z.number()).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      z.array(RetrainTrackSchema).readonly(),
      { role: { feature: 'retrain' }, kind: 'query', auth: 'admin' },
    ),

    /**
     * Paginated corpus copies for the Frames grid — index reads only.
     *
     * Filters AND (`workState`, cameras, one collection, annotated classes).
     * An answered empty match is `{ frames: [], total: 0, … }` (D315), never a
     * pending masquerade. Classification uses `workStateOf` (annotation count
     * wins over a stray `complete` flag).
     */
    listRetrainCorpusPage: method(RetrainCorpusFilterSchema, RetrainCorpusPageSchema, {
      role: { feature: 'retrain' },
      kind: 'query',
      auth: 'admin',
    }),

    /**
     * Global + per-camera corpus KPI. Unfiltered totals; `%` on a camera row is
     * `complete(camera) / corpus total`, or `null` when the corpus is empty.
     */
    getRetrainCorpusKpi: method(z.object({}), RetrainCorpusKpiSchema, {
      role: { feature: 'retrain' },
      kind: 'query',
      auth: 'admin',
    }),

    /**
     * What a track can contribute, and what it already has.
     *
     * `candidates` are the track's whole, unannotated frames — index rows only,
     * so this is cheap. `copies` are the frames already inside the dataset, and
     * a candidate whose copy exists is marked `copied: true`: selecting it again
     * is free and CANNOT fail, whatever became of the original.
     *
     * A crop, a thumbnail and `fullFrameBoxed` are never candidates. The last
     * one matters most: it has the model's own rectangle burned into the pixels,
     * and a detector trained on it learns to find a green line.
     */
    listRetrainFrames: method(z.object({ trackId: z.string() }), RetrainFrameListSchema, {
      role: { feature: 'retrain' },
      kind: 'query',
      auth: 'admin',
    }),

    /**
     * COPY-ON-SELECT — the write that makes `trained` safe to evict.
     *
     * Selecting a frame copies its bytes into retrain storage immediately: not
     * a reference, not a lease. Once the copy exists the dataset no longer
     * depends on the track's media, which is exactly what lets D81 hand a
     * `trained` track back to retention.
     *
     * The order inside is load-bearing and is pinned by a test: an EXISTING
     * copy is returned without touching the source, so an original that
     * evaporated blocks the selection of THAT ORIGINAL and never the copy
     * already taken. Every refusal comes back named — a dropped selection is
     * never silent, on the wire or in the log.
     */
    selectRetrainFrames: method(
      z.object({
        deviceId: z.number(),
        trackId: z.string(),
        mediaIds: z.array(z.number().int()).min(1),
      }),
      RetrainFrameSelectionSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /** Un-select a frame: its annotations go first, then the copy and its blob.
     *  Deliberately destructive and deliberately explicit — it is the only way
     *  a frame leaves the dataset before export. */
    deselectRetrainFrame: method(
      z.object({ deviceId: z.number(), trackId: z.string().optional(), frameId: z.string() }),
      z.object({ removed: z.boolean(), removedAnnotations: z.number().int() }),
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * The pixels of ONE copied frame, base64.
     *
     * @deprecated Use `RetrainFrame.imageUrl` / `thumbnailUrl` (the admin
     * `retrain-frame` data plane, D613). A base64 envelope holds the frame
     * whole in the producer AND the caller, and a grid of tiles paid that for
     * every tile. Kept for one release for callers that cannot fetch a URL.
     *
     * Through the cap rather than a data plane because it is genuinely one
     * frame at a time, on demand, at human speed — the shape D9/D18 permit
     * (what they forbid is frames crossing a boundary at frame RATE). The
     * annotation canvas needs the image and its exact dimensions in the same
     * answer: a canvas that places a normalised box against a size it guessed
     * draws every box in the wrong place.
     */
    getRetrainFrameImage: method(
      z.object({ frameId: z.string() }),
      z.object({ base64: z.string(), width: z.number().int(), height: z.number().int() }),
      { role: { feature: 'retrain' }, kind: 'query', auth: 'admin' },
    ),

    /**
     * Ask the pipeline what it sees, as a PROPOSAL.
     *
     * Runs through `pipelineRunner.runStatelessStep` on the COPIED frame, and
     * every box comes back as a draft with `source: 'assist'` plus the model and
     * score that produced it. The operator confirms, edits, adds and deletes;
     * nothing is stored until `saveRetrainAnnotations`.
     *
     * For packages the request is `rfdetr-package` on the ZONE CROP at 0.35 —
     * never the whole frame, where a package detector at that threshold proposes
     * furniture. A package request with no zone is REFUSED rather than widened,
     * because the silent widening would look like a bad model for as long as
     * nobody checked which rectangle it ran on.
     */
    proposeRetrainAnnotations: method(
      z.object({
        deviceId: z.number(),
        /** The frame's track, when it has one — checked against the frame. */
        trackId: z.string().optional(),
        frameId: z.string(),
        subject: RetrainAssistSubjectSchema,
        /** Which node runs it. Absent ⇒ wherever an unowned call lands. */
        nodeId: z.string().optional(),
      }),
      RetrainAssistResultSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /** Every annotation on a track, or on named frames (a recording still has
     *  no track), oldest first. One of the two is required. */
    listRetrainAnnotations: method(
      z.object({
        trackId: z.string().optional(),
        frameIds: z.array(z.string()).max(2000).optional(),
      }),
      z.array(RetrainAnnotationSchema).readonly(),
      { role: { feature: 'retrain' }, kind: 'query', auth: 'admin' },
    ),

    /**
     * Replace EVERY annotation on one frame with the supplied set.
     *
     * Whole-frame replacement, not per-box upsert: the unit of ground truth is
     * the frame, and "the operator deleted a box" must be the same durable
     * outcome as "the operator never drew it". A per-box patch would let a frame
     * keep a box the operator removed on a surface that only knew about the
     * boxes it sent.
     *
     * Refuses a macro class typed into `label` or `subLabel` — the tiers are
     * separate and the guard is at the WRITE, because a mixed taxonomy cannot
     * be un-mixed by reading it.
     *
     * ATOMIC and REVISIONED: the replaced rows, the frame's `dismissed` set and
     * its `revision` move in one transaction, guarded by the revision the
     * caller saw. A stale `expectedRevision` writes nothing and throws
     * `retrain-revision-conflict` (parse it with `parseRetrainRevisionConflict`);
     * the UI and an MCP agent no longer overwrite each other silently.
     */
    saveRetrainAnnotations: method(
      z.object({
        deviceId: z.number(),
        /** The frame's track, when it has one — checked against the frame. */
        trackId: z.string().optional(),
        frameId: z.string(),
        annotations: z.array(RetrainAnnotationDraftSchema),
        /** The frame's `revision` the caller saw. A different current revision
         *  refuses the save with a `retrain-revision-conflict` error
         *  (`parseRetrainRevisionConflict`). Absent ⇒ last write wins. */
        expectedRevision: z.number().int().optional(),
        /** The proposals the operator deleted. Absent ⇒ keep the frame's
         *  current set; present ⇒ replace it (an empty array un-dismisses). */
        dismissed: z.array(RetrainDismissedSchema).optional(),
      }),
      z.array(RetrainAnnotationSchema).readonly(),
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Give annotations saved BEFORE origins existed the origin a caller
     * reconstructed for them (the MCP `track_review_backfill_origin` tool
     * matches each row to the pipeline box it equals).
     *
     * Writes `origin` and nothing else: ids, creation time and the export stamp
     * are untouched (a re-save through `saveRetrainAnnotations` would reset all
     * three). A row that already has an origin is SKIPPED — a snapshot taken at
     * accept time is evidence, a reconstruction is a guess. Atomic and
     * revision-guarded like the save; bumps the frame's `revision`.
     */
    backfillRetrainOrigins: method(
      z.object({
        deviceId: z.number(),
        trackId: z.string().optional(),
        frameId: z.string(),
        expectedRevision: z.number().int().optional(),
        origins: z
          .array(z.object({ annotationId: z.string(), origin: RetrainOriginSchema }))
          .min(1)
          .max(500),
      }),
      z.object({
        updated: z.number().int(),
        skipped: z.number().int(),
        revision: z.number().int(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Finish with a track: `staging → trained`. **The only writer of that
     * state** — D81 shipped the column with it deliberately unreachable.
     *
     * Refuses a track the dataset holds no copies from. `trained` un-pins the
     * track's media, so completing without a copy is a delete order for material
     * nothing ever extracted anything from; that refusal IS the safety argument
     * of D81, expressed as a precondition.
     */
    completeRetrainTrack: method(
      z.object({ deviceId: z.number(), trackId: z.string() }),
      RetrainTransitionResultSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * The deliberate return: `trained → staging`, for the rare case.
     *
     * The generic `setTrackFlags` toggle refuses this in both directions by
     * design (D81) — re-staging from a checkbox is how the same material gets
     * annotated twice under two ground truths. Doing it here means the operator
     * is looking at the annotations that already exist while they decide, and
     * those annotations are LEFT ALONE: "put this back" must not be a
     * destructive act wearing a navigational name.
     */
    restageRetrainTrack: method(
      z.object({ deviceId: z.number(), trackId: z.string() }),
      RetrainTransitionResultSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Where to download the ANNOTATED dataset.
     *
     * The sibling of `getTrainingExportUrl` and deliberately not the same
     * archive: that one streams a marked track's stored media verbatim, this one
     * streams the retrain COPIES plus an `annotations.json` carrying, for every
     * subject, the canonical full-frame box AND the geometry derived for each
     * model shape (letterboxed root / zone-cropped package / subject-cropped
     * classifier). Derived at export, never stored — one box in, three shapes
     * out, so two crops of the same subject can never end up in one feature
     * space (D52).
     */
    getRetrainExportUrl: method(
      RetrainExportFilterSchema.extend({ layout: RetrainExportLayoutSchema.optional() }),
      z.object({ url: z.string() }),
      { kind: 'query', auth: 'admin' },
    ),

    /**
     * The operator's "every subject in this frame is boxed" — set and cleared
     * by hand, never derived: a frame with no box may be a complete hard
     * negative, and a frame with three boxes may still miss a fourth person.
     */
    setRetrainFrameComplete: method(
      z.object({
        deviceId: z.number(),
        trackId: z.string().optional(),
        frameId: z.string(),
        complete: z.boolean(),
      }),
      RetrainFrameSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Stream the annotated archive to a TARGET instead of a browser — the
     * same tar `getRetrainExportUrl` serves (manifest first, one JPEG in
     * memory at a time, paced), written chunk by chunk into one HTTP request.
     * The bytes never cross this cap and never land on the hub's disk; the
     * answer is what was sent, with its sha256.
     */
    writeRetrainArchive: method(
      z.object({
        filter: RetrainExportFilterSchema,
        layout: RetrainExportLayoutSchema,
        target: RetrainArchiveTargetSchema,
      }),
      RetrainArchiveResultSchema,
      { kind: 'mutation', auth: 'admin', timeoutMs: 60 * 60_000 },
    ),

    /**
     * OFFER the annotated archive instead of pushing it (D805): the same tar
     * `writeRetrainArchive` streams, behind a one-shot `ctx.peerBytes` ticket
     * the caller dials at once (same host). For a consumer that cannot expose
     * an upload URL — a training provider streaming straight into its cloud.
     * The answer is the plan; the bytes and their sha256 are the consumer's
     * to measure as they arrive.
     */
    offerRetrainArchive: method(
      z.object({ filter: RetrainExportFilterSchema, layout: RetrainExportLayoutSchema }),
      z.object({
        ticket: PeerBytesTicketSchema,
        frames: z.number().int(),
        annotations: z.number().int(),
      }),
      { kind: 'mutation', auth: 'admin', timeoutMs: 120_000 },
    ),

    // ── AI-vision pre-annotation ───────────────────────────────────
    /** The enabled, vision-capable LLM profiles, each saying whether a frame
     *  sent to it leaves the house. */
    listRetrainAssistProfiles: method(
      z.object({}),
      z.array(RetrainAssistProfileSchema).readonly(),
      { role: { feature: 'retrain' }, kind: 'query', auth: 'admin' },
    ),

    /**
     * Ask a vision LLM (the `llm` capability) about ONE copied frame: list the
     * objects of `classes` with boxes, and review the boxes already on the
     * canvas (sent by `ref`). Answers drafts (`source: 'llm'`) and reviews —
     * nothing is stored, nothing is accepted. A profile that sends the frame
     * outside the house is refused unless `allowCloud` says the operator
     * confirmed this run.
     */
    proposeRetrainAnnotationsWithLlm: method(
      z.object({
        deviceId: z.number(),
        trackId: z.string().optional(),
        frameId: z.string(),
        profileId: z.string(),
        classes: z.array(RetrainMacroClassSchema).min(1),
        boxes: z
          .array(
            z.object({
              ref: z.string(),
              bbox: RetrainBboxSchema,
              macroClass: RetrainMacroClassSchema,
              label: z.string().optional(),
            }),
          )
          .max(50),
        allowCloud: z.boolean(),
      }),
      RetrainLlmAssistResultSchema,
      { kind: 'mutation', auth: 'admin', timeoutMs: 180_000 },
    ),

    // ── Named training collections ─────────────────────────────────
    /**
     * Create a named collection — a set over the retrain corpus ("packages
     * porch night"). Names are unique case-insensitively and never empty;
     * both refusals are named.
     */
    createRetrainCollection: method(
      z.object({ name: z.string().max(120) }),
      RetrainCollectionCreateResultSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /** Every collection, newest first, with its frame count. */
    listRetrainCollections: method(z.object({}), z.array(RetrainCollectionSchema).readonly(), {
      role: { feature: 'retrain' },
      kind: 'query',
      auth: 'admin',
    }),

    /**
     * Resolve a live training corpus selection to frame ids + stats (index
     * reads only). Same plan the annotated export builds — training plan/start
     * calls this instead of a frozen dataset version.
     */
    resolveRetrainTrainingCorpus: method(
      RetrainTrainingCorpusSelectionSchema,
      RetrainTrainingCorpusResolveResultSchema,
      { kind: 'query', auth: 'admin', timeoutMs: 60_000 },
    ),

    renameRetrainCollection: method(
      z.object({ id: z.string(), name: z.string().max(120) }),
      RetrainCollectionRenameResultSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Delete a collection. Its recording stills that no other collection
     * holds are deleted with their annotations (nothing else reaches them);
     * frames copied from tracks always stay in the dataset.
     */
    deleteRetrainCollection: method(
      z.object({ id: z.string() }),
      z.object({ deleted: z.boolean(), removedFrames: z.number().int() }),
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Add the frame at a recording instant to a collection — the frame the
     * model may have seen NOTHING in. The recorder re-decodes the native
     * frame at `epochMs`; the dataset copies it (trackless, durable). The same
     * moment twice is one copy. Every refusal is named.
     */
    addRetrainFrameFromRecording: method(
      z.object({ collectionId: z.string(), deviceId: z.number(), epochMs: z.number() }),
      AddRetrainFrameFromRecordingResultSchema,
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin', timeoutMs: 60_000 },
    ),

    /** Add frames already in the dataset to a collection. */
    addRetrainFramesToCollection: method(
      z.object({ collectionId: z.string(), frameIds: z.array(z.string()).min(1).max(500) }),
      z.object({
        added: z.number().int(),
        alreadyMember: z.number().int(),
        unknownFrameIds: z.array(z.string()).readonly(),
      }),
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /** Remove a frame from a collection. A recording still left in no
     *  collection is deleted with its annotations (`deletedFrame`). */
    removeRetrainFrameFromCollection: method(
      z.object({ collectionId: z.string(), frameId: z.string() }),
      z.object({ removed: z.boolean(), deletedFrame: z.boolean() }),
      { role: { feature: 'retrain' }, kind: 'mutation', auth: 'admin' },
    ),

    /** The frames of a collection, with their pipeline boxes. */
    listRetrainCollectionFrames: method(
      z.object({ collectionId: z.string() }),
      z.array(RetrainFrameSchema).readonly(),
      { role: { feature: 'retrain' }, kind: 'query', auth: 'admin' },
    ),

    // ── Media ─────────────────────────────────────────────────
    //
    // `deviceId` on these three is the AUTHORIZATION subject, not a filter:
    // the scope matcher can only gate what it can see, and a bare trackId /
    // eventId names no device — so without it a device-scoped principal
    // failed closed on every thumbnail (2026-08-15, the "bob sees no
    // track media" report). Optional for back-compat with older clients
    // (their admins bypass the matcher anyway); the provider CROSS-CHECKS it
    // against the track/event's true device and answers empty on a mismatch,
    // so declaring a camera you own never launders another camera's media.
    /**
     * The media an EVENT owns.
     *
     * `ownerType` is REQUIRED, and that is the whole correction (D482). An
     * event is a row in ONE of three tables, and since D474 each numbers from
     * 1 independently: `motion:101314` and `object:101314` both exist. This
     * method took a bare `eventId` and the provider probed motion → object →
     * audio, stopping at the first hit — so on the live hub, where object
     * events own no media of their own and 299 883 of 300 559 media rows are
     * motion-owned, EVERY object event resolved to its motion namesake. A
     * track from 17:34 on camera 101 was served a snapshot from 22:35 eleven
     * days earlier, silently.
     *
     * D476 had already disambiguated the KEY (`motion:` vs `object:`); this is
     * the API catching up to it. Naming the table is not a "qualification" of
     * the ambiguity — a listing BY OWNER has no address to make surrogate: the
     * owner IS (table, id), and half of it is not a question.
     */
    getEventMedia: method(
      z.object({
        /** Which of the three event tables owns the row. */
        ownerType: EventOwnerTypeSchema,
        /** The event's rowid in that table (D474: an event id is a number). */
        eventId: z.number().int(),
        kind: MediaFileKindEnum.optional(),
        // REQUIRED: it is the authorization subject the scope matcher gates
        // on — an id-only media endpoint would be ungateable, and an optional
        // one would keep an unscoped fast lane open.
        deviceId: z.number(),
      }),
      z.array(MediaFileSchema).readonly(),
    ),
    /** All media rows owned by a track. `kinds` narrows to a kind subset so a
     *  client can fetch the SMALL display variants on open and pull the
     *  multi-MB native variants only on demand (mirrors `getEventMedia.kind`).
     *  Absent ⇒ every kind (back-compat). */
    getTrackMedia: method(
      z.object({
        trackId: z.string(),
        kinds: z.array(MediaFileKindEnum).optional(),
        deviceId: z.number(),
      }),
      z.array(MediaFileSchema).readonly(),
    ),
    /**
     * What media a track HAS, without any of it.
     *
     * The detail view needs the shape of a track's media to build its strip —
     * which kinds exist, in what order, at what size — and then wants each tile
     * fetched as an image, not as base64 inside this response. Measured: the
     * full `getTrackMedia` is 5.3-7.7 MB and blocks the view; this manifest is
     * ~2 KB.
     *
     * It also restores a fact a `kinds` filter destroys: filtering
     * `getTrackMedia` drops whole ROWS, taking `kind` and `sizeBytes` with
     * them, so a client that fetched only the small variants could no longer
     * tell a full-resolution variant existed — and the affordance that opens it
     * would silently disappear.
     */
    listTrackMedia: method(
      z.object({ trackId: z.string(), deviceId: z.number() }),
      z.array(MediaFileInfoSchema).readonly(),
    ),
    /**
     * What media an EVENT has, without any of it — the twin `getEventMedia`
     * never had.
     *
     * `listTrackMedia` above got this treatment because a track's media is
     * 5-8 MB. An event's is worse per row, not better: an old-style event owns
     * a `crop` AND a native-resolution `fullFrameBoxed`, and the track DETAIL
     * modal — the one surface that legitimately shows the big kinds — unions
     * both listings to build its filmstrip. It then renders every tile from
     * the `event-media` plane by key and throws the bytes away. Measured on
     * the live hub: one event's `fullFrameBoxed` is 2 824 077 B, base64'd to
     * ~3.8 MB, allocated whole in hub-main's heap, for a list of keys.
     *
     * Same `deviceId` authorization subject as `getEventMedia`, the same
     * REQUIRED `ownerType` (read that method's docblock for the night-time
     * thumbnail this closes — D482), and the same rows: this is a projection
     * of that method, never a different question.
     */
    listEventMedia: method(
      z.object({
        ownerType: EventOwnerTypeSchema,
        eventId: z.number().int(),
        deviceId: z.number(),
      }),
      z.array(MediaFileInfoSchema).readonly(),
    ),

    /**
     * Which of `ownerIds` hold at least ONE media row — an INDEX read, never a
     * blob read, and the LICENCE `videoclips` needs to publish a `thumbnail`.
     *
     * The event-media URL is stamped from a template for every event in the
     * system, so "the plane is up" was being served as "there are bytes": 64 of
     * one camera's 179 clips pointed at a 404 (device 3836, 2026-08-17). This
     * is the question that turns the stamp into a claim.
     *
     * It is on the WIRE because the clip source is registered by the addon that
     * owns the FOOTAGE, not by this one (D560) — the probe used to be an
     * in-process `MediaStore` read. One call per OWNER KIND, never one per
     * owner: that N+1 is what `MediaStore.ownersWithMedia` was written to
     * prevent, and crossing a process boundary makes it worse, not better.
     * `ownerIds` is bounded at the same 5 000 the annotation fetch is bounded
     * at, so one pathological camera-day cannot mint an unbounded request.
     *
     * THROWS rather than answering partially. A probe that quietly
     * under-reports reads as "these owners have nothing" and the caller drops
     * thumbnails that exist — the opposite failure to the one above, and
     * equally invisible.
     *
     * `deviceId` is the authorization subject, exactly as on `getEventMedia`.
     */
    ownersWithMedia: method(
      z.object({
        deviceId: z.number(),
        ownerKind: MediaPresenceOwnerKindSchema,
        ownerIds: z.array(z.string()).max(5_000),
      }),
      z.array(z.string()).readonly(),
    ),

    // ── CLIP semantic text search ─────────────────────────────────
    /**
     * Search object events by text query using CLIP cosine similarity.
     * Encodes `text` via the `embedding-encoder` cap, queries the
     * `ObjectEmbeddingStore` with optional prefilters, ranks all matching
     * embeddings by cosine similarity, and joins winners to their
     * ObjectEvents by trackId. Returns up to `limit` events scored ≥
     * `minScore`, sorted descending by score.
     */
    // `caller: 'required'` (D649): a `modelId` that differs from the cluster
    // row is an ADMIN override (the cutover comparison). A share link or a
    // viewer session naming another model is refused by name
    // (`model-override-requires-admin`), never silently re-pointed.
    searchObjectEvents: method(
      SearchObjectEventsInput,
      z.array(ScoredObjectEventSchema).readonly(),
      { caller: 'required' },
    ),
    // `z.object({})`, not `z.void()`: these two are also reachable through the
    // `addons.custom` bridge, whose envelope always carries an `input` field.
    // A void input makes them resolve and then reject every call with
    // "expected void, received object" — verified on the live hub.
    wipeObjectEmbeddings: method(z.object({}), WipeObjectEmbeddingsResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    rebuildObjectEmbeddings: method(
      RebuildObjectEmbeddingsInput,
      RebuildObjectEmbeddingsResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    getObjectEmbeddingRebuildStatus: method(z.object({}), RebuildStatusSchema),
  },
  events: {
    /**
     * Enriched frame emitted after refinement — the live-overlay source of
     * truth (two-plane re-injection). Carries the frame's detections in the
     * `ObjectDetection` wire shape: first-level roots (with track info +
     * enrichment labels) plus synthesized `kind:'detail'` face/plate entries
     * re-projected from per-track detail state, so stream overlays render
     * boxes + recognized names without querying full Track state.
     */
    onFrameTracked: {
      data: z.object({
        deviceId: z.number(),
        timestamp: z.number(),
        frameWidth: z.number(),
        frameHeight: z.number(),
        detections: z.array(OverlayDetectionSchema).readonly(),
      }),
    },
    /** Track entered active state (first-seen). */
    onTrackStarted: {
      data: z.object({
        deviceId: z.number(),
        trackId: z.string(),
        className: z.string(),
      }),
    },
    /** Track expired (TTL reached after last detection). */
    onTrackEnded: {
      data: z.object({
        deviceId: z.number(),
        trackId: z.string(),
        className: z.string(),
        durationMs: z.number(),
      }),
    },
    /** Canonical "something happened at device X" event, per-kind. */
    onDetectionEvent: {
      data: z.object({
        deviceId: z.number(),
        kind: EventKindSchema,
        eventId: z.string(),
        timestamp: z.number(),
      }),
    },
  },
} as const satisfies CapabilityDefinition

export type IPipelineAnalyticsProvider = InferProvider<typeof pipelineAnalyticsCapability>

export {
  AudioEventSchema,
  EventKindDescriptorSchema,
  EventKindSchema,
  EventKindsForDeviceSchema,
  KeyEventSchema,
  MediaFileInfoSchema,
  MediaFileKindEnum,
  MediaFileRefSchema,
  MediaFileSchema,
  MotionEventSchema,
  ObjectEventSchema,
  RecentTracksPageSchema,
  RecentTracksQueryInput,
  SensorEventSchema,
  TrackAudioLabelSchema,
  TrackCascadeCountsSchema,
  TrackEnvelopeSchema,
  /** No longer carried on onFrameTracked (two-plane re-injection) — kept for compat. */
  TrackedDetectionSchema,
  TrackProjectionSchema,
  TrackSchema,
  TrackStateSchema,
  TrackZoneFilterSchema,
}
