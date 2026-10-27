import type { BulkUpdateState } from '../capabilities/addons.cap.js'
import type { AlertEpisodePayload } from '../notification/alert-episode.js'
import type { MotionRegion } from '../capabilities/motion-detection.cap.js'
import type { DetectionSource } from '../capabilities/pipeline-analytics.cap.js'
import type { CamProfile } from '../capabilities/schemas/streaming-shared.js'
import type { WrapperKind } from '../capabilities/server-management.cap.js'
import type { CameraPipelineConfig } from '../types/camera-pipeline.js'
import type { AudioResult, FrameResult, ObjectDetection } from '../types/detection.js'
import type { PipelineEngineChoice } from '../types/pipeline.js'
import type { PipelineExecutionTrace, StepCadence } from '../types/pipeline-step.js'
import type { CameraMetrics } from './api-shared.js'
import type { FrameHandle } from './frame-handle.js'
import type {
  ContainerMemorySnapshot,
  NodeProcess,
  SystemResourceSnapshot,
} from './metrics-provider.js'
import type { RunnerLocalLoad } from './pipeline-runner-capability.js'
import type { BrokerStats } from './stream-broker.js'

// ---------------------------------------------------------------------------
// Event source
// ---------------------------------------------------------------------------

export interface EventSource {
  /** Primary source type: 'core', 'addon', 'device', 'pipeline', etc. */
  type: string
  /** Primary identifier — addonId when type='addon', deviceId when type='device', etc. */
  id: string | number
  /** Agent/node that originated the event (e.g. 'hub', 'agent-a1b2c3'). */
  nodeId?: string
  /** Addon that originated the event (populated even when type='device'). */
  addonId?: string
  /** Device the event relates to (populated even when type='addon'). */
  deviceId?: number
}

// ---------------------------------------------------------------------------
// Detection event payloads
// ---------------------------------------------------------------------------

// MotionAnalysisRegion removed (2026-04-14) — consumers now use
// `MotionRegion` from the motion-detection capability directly. The two
// interfaces had identical shapes; keeping both was a duplication leak.

/**
 * One detection entry emitted by a camera's firmware (not by the local
 * AI pipeline). Carried inside `detection.camera-native` events —
 * native providers fan out to this category for each ring/motion/AI
 * alarm push they receive from the camera.
 */
export interface CameraNativeDetection {
  /**
   * Firmware-reported class. Loose string to accommodate heterogeneous
   * firmwares (Reolink uses 'people'/'vehicle'/'animal'/…; ONVIF uses
   * 'PeopleDetect'; etc.). Common values: 'motion', 'person', 'vehicle',
   * 'animal', 'face', 'package', 'other', 'doorbell'.
   */
  readonly class: string
  /** Ms epoch when the server observed the push from the camera. */
  readonly timestamp: number
  /** Optional firmware-provided confidence [0..1]. Most firmwares don't expose it. */
  readonly confidence?: number
  /** Optional bbox [x, y, w, h] normalised [0..1]. Rare on native events. */
  readonly bbox?: readonly [number, number, number, number]
}

/** Payload of a `detection.camera-native` event — one camera-firmware
 *  detection push (one or more class entries at an instant). A `type`
 *  (not `interface`) so it stays assignable to the bus's
 *  `data: Record<string, unknown>` — interfaces lack an implicit index
 *  signature and break `isEvent`'s type predicate. */
export type CameraNativeDetectionPayload = {
  readonly cameraId: number
  readonly detections: readonly CameraNativeDetection[]
  readonly source: 'onboard' | 'camera-native'
  /** Source frame dimensions, when the camera reports them — lets the
   *  analyzer denormalize the `[0,1]` bboxes to real pixels (else a
   *  nominal frame is used; geometry is scale-invariant either way). */
  readonly frameWidth?: number
  readonly frameHeight?: number
}

export interface MotionAnalysisPayload {
  detected: boolean
  regionCount: number
  regions: readonly MotionRegion[]
  frameWidth: number
  frameHeight: number
  analysisMs: number
  [key: string]: unknown
}

/**
 * Motion phase transition payload. Single source of truth lives in
 * `motion.cap.ts` as `MotionOnMotionChangedDataSchema` — this alias
 * just re-exports the inferred type with the `[key: string]: unknown`
 * loose-index pattern the bus uses for forward-compat. Don't add
 * fields here; extend the schema in motion.cap.ts.
 */
export type MotionOnMotionChangedPayload =
  import('../capabilities/motion.cap.js').MotionOnMotionChangedData & { [key: string]: unknown }

/** A camera's RAW onboard push (D673) — see `pipeline/provider-motion.ts`. */
export type ProviderMotionPayload = import('../pipeline/provider-motion.js').ProviderMotionData & {
  [key: string]: unknown
}

/** Raw motion zone from CCL (before minArea filter). */
export interface MotionRawZone {
  readonly bbox: readonly [number, number, number, number] // [x1, y1, x2, y2]
  readonly pixelCount: number
  readonly changeScore: number // 0-1 intensity
}

/** All raw motion zones — emitted for UI debug overlay. */
export interface MotionZonesRawPayload {
  readonly deviceId: number
  readonly zones: readonly MotionRawZone[]
  readonly frameSize: { readonly width: number; readonly height: number }
  readonly timestamp: number
  [key: string]: unknown
}

export interface DetectionResultPayload {
  /**
   * The post-processed frame result the frontend consumes. Already
   * contains `width`/`height` + `detections[]` + optional debug. No
   * pipeline-raw wrapper — the new `FrameResult` shape IS the payload.
   */
  frame: FrameResult
  /** Events emitted by the analysis pipeline (tracking, scene state, face rec). */
  analysisResults: readonly unknown[]
  /**
   * Handle to the decoded frame this result came from — undefined when
   * unavailable. Forwarded straight from the upstream
   * `PipelineInferenceResultPayload.frameHandle` so post-analysis
   * consumers can resolve the original pixels via the shm frame plane.
   */
  readonly frameHandle?: FrameHandle
  /**
   * Wall-clock (ms) when the source frame was committed to the shm ring
   * (`FrameMeta.capturedAt`). Lets a consumer measure true end-to-end
   * latency (`Date.now() - capturedAt`) from frame capture to delivery.
   * Distinct from `frame.timestamp`, which is the inference-complete time.
   * Undefined when the upstream frame carried no capture stamp.
   */
  readonly capturedAt?: number
  [key: string]: unknown
}

/**
 * Enriched frame emitted on `pipeline-analytics.frame-tracked` after
 * post-analysis detail synthesis. Carries overlay-ready detections:
 * first-level roots pass through from the inference frame; `kind:'detail'`
 * entries (face/plate) are SYNTHESIZED per frame from per-track detail
 * state (two-plane re-injection).
 */
export interface PipelineAnalyticsFrameTrackedPayload {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly detections: readonly ObjectDetection[]
  /**
   * True when ≥1 object is still TRACKED on this frame — a subject is
   * PRESENT, whatever it is doing. Deliberately **not** "a subject is
   * MOVING".
   *
   * This is the orchestrator's on-motion session-hold signal, and the
   * distinction is the whole point of the field. The predecessor
   * (`hasMovingTrack`) was true only for track states `moving`/`entered`/
   * `left`, so it flapped on every detector jitter and could not hold a
   * session open for a subject that had merely paused (D261).
   *
   * What ENDS the hold is a STILLNESS test on the producer side: a track
   * whose centroid has not moved across the recent window is subtracted
   * from this flag, so a parked car stops holding its session open even
   * though it is still being tracked on every frame. It does not become a
   * stationary entry at that moment — that needs repeated evidence across
   * many sightings, which takes minutes — and the two decisions are
   * deliberately separated: ending a hold destroys nothing (the next motion
   * re-opens the session), while creating an entry SUPPRESSES the object
   * and needs much more proof. Once an entry does exist, the registry also
   * suppresses the object's detections before the tracker, so it stops
   * reaching `result.tracked` at all. `maxSessionHoldMs` is the
   * unconditional cap behind both.
   *
   * Absent ⇒ treat as `false` (no hold), which degrades to the pre-fix
   * behaviour rather than to something worse — the version-skew answer for
   * a new orchestrator reading an old post-analysis. Telemetry-lossy (D8):
   * a dropped frame just lets the session close slightly earlier.
   */
  readonly hasLiveTrack?: boolean
  /**
   * How many objects the TRACKER holds on this frame — moving OR still,
   * i.e. `result.tracked.length` (D652). Diagnostics only: it decides nothing.
   * {@link hasLiveTrack} deliberately subtracts a still subject, so a session
   * that closed on a parked car and one that closed on an empty street both
   * saw `false` last; this count is what tells them apart on the orchestrator's
   * close line (`liveTracks`). Absent ⇒ unknown (an older post-analysis),
   * which the consumer reports as `null`, never as 0.
   */
  readonly liveTrackCount?: number
  [key: string]: unknown
}

/** Lifecycle phase of a tracked object: it appears (`start`), its best
 *  observation materially improves (`update`), then it ends (`end`). */
export type TrackLifecyclePhase = 'start' | 'update' | 'end'

/**
 * Emitted on `pipeline-analytics.stationary-changed` when a parked object
 * appears (a track was promoted to a stationary-registry entry) or departs.
 * Telemetry (D8): a dropped event delays nothing durable — the registry is the
 * authority and the automation `stationary-present` condition reads it.
 */
export interface PipelineAnalyticsStationaryChangedPayload {
  readonly deviceId: number
  readonly entryId: string
  readonly className: string
  readonly phase: 'appeared' | 'departed'
  /** When the registry CONCLUDED the change. */
  readonly timestamp: number
  /** When the change was actually OBSERVED (a departure is confirmed later). */
  readonly observedAt: number
  /** Ids of the camera's zones the parked object's box is in (the same
   *  membership rule as occupancy); empty when the camera has none or none match. */
  readonly zones: readonly string[]
  readonly [key: string]: unknown
}

/**
 * Emitted on `pipeline-analytics.track-lifecycle` at three moments of a
 * tracked object's life — `phase:'start'` when it first appears,
 * `phase:'update'` when its best observation MATERIALLY improves (a
 * clearer/larger frame, a newly-recognized identity or plate), and
 * `phase:'end'` exactly once when it expires (TTL-gated). One typed
 * payload shape across phases so a consumer subscribes once and branches
 * on `phase`. Supersedes the thin `TrackStarted` / `TrackEnded` pair.
 *
 * Fields carry the BEST-so-far observation (final at `end`). `media`
 * addresses the current representative image over HTTP. Telemetry
 * semantics (D8): a lost event only misses a moment, never a correctness
 * issue — the durable summary lives in the track store + events.
 */
export interface PipelineAnalyticsTrackLifecyclePayload {
  readonly deviceId: number
  readonly trackId: string
  readonly phase: TrackLifecyclePhase
  // best-so-far (or final at end)
  /** Per-track observed-class set (deduplicated accumulator). */
  readonly classes: readonly string[]
  readonly bestClassName: string
  readonly bestConfidence: number
  /** Identity name / plate text, when resolved. */
  readonly label?: string
  readonly identityId?: string
  readonly plateText?: string
  // lifecycle
  readonly firstSeen: number
  readonly lastSeen: number
  /** `lastSeen - firstSeen`; ~0 at start, grows over the track's life. */
  readonly durationMs: number
  // spatial (present when known)
  readonly zonesVisited?: readonly string[]
  readonly totalDistance?: number
  readonly positionsCount?: number
  readonly importance?: number
  readonly importanceReason?: string
  /** Audio-classification labels heard on the camera during the track's
   *  life (score ≥ device `classificationMinScore`), aggregated per label —
   *  best-so-far at `update`, final at `end`. Mirrors `Track.audioLabels`. */
  readonly audioLabels?: ReadonlyArray<{
    readonly label: string
    readonly peakScore: number
    readonly count: number
    readonly firstAt: number
    readonly lastAt: number
  }>
  /** The current best image, addressable over HTTP. */
  readonly media?: {
    readonly keyFrameMediaId?: number
    readonly bestCropMediaId?: number
    readonly bestEventId?: string
  }
  // to unlock CLIP / semantic consumers
  readonly embeddingId?: string
  readonly embeddingModelId?: string
  /** D683: present on the `end` of a piece L2 fused into another track — the
   *  subject continues under this id; consumers merge rather than count two. */
  readonly fusedIntoTrackId?: string
  readonly [key: string]: unknown
}

/**
 * Emitted on `pipeline-analytics.face-gallery-changed` whenever a gallery
 * face row changes. `kind:'buffered'` — a new face row was persisted
 * (`FaceRecognizer.onTrackEnd`); `'assigned'` / `'unassigned'` — the face's
 * identity link changed (`FaceGalleryProvider.assignFace`/`unassignFace`);
 * `'deleted'` — the row was removed (`FaceGalleryProvider.deleteFace`).
 * Telemetry semantics (D8): a lost event only delays a UI refresh, never a
 * correctness issue. Consumer: `useFaceGalleryLiveRefresh` (admin-ui).
 */
export interface PipelineAnalyticsFaceGalleryChangedPayload {
  readonly deviceId: number
  readonly faceId: string
  readonly kind: 'buffered' | 'assigned' | 'unassigned' | 'deleted' | 'identity-renamed'
  readonly [key: string]: unknown
}

/**
 * Emitted when a plate-gallery row changes: `'buffered'` — a new read was
 * persisted (`PlateRecognizer.onTrackEnd`); `'assigned'`/`'unassigned'` — the
 * vehicle link changed (`PlateGalleryProvider`); `'deleted'` — the row was
 * removed. Telemetry (D8): a lost event only delays a UI refresh. Consumer:
 * `usePlateGalleryLiveRefresh` (admin-ui).
 */
export interface PipelineAnalyticsPlateGalleryChangedPayload {
  readonly deviceId: number
  readonly plateId: string
  readonly kind: 'buffered' | 'assigned' | 'unassigned' | 'corrected' | 'deleted'
  readonly [key: string]: unknown
}

/**
 * Emitted by `addon-post-analysis` when a package-drop is confirmed — a
 * newly-appeared stationary object of a package class that cleared the
 * class / zone / dwell / size gates inside a package zone. Telemetry (D8):
 * the durable record is the `package-events` store row.
 *
 * It drives NOTHING today — swept 2026-09-08, this payload and its
 * `…PackedUp` sibling have no subscriber anywhere in `packages/`, `server/`,
 * `camstack/` or `scripts/`. The notification path is the persist hook
 * (`pipeline-analytics/index.ts` → `notificationCenter.onPackageEventPersisted`),
 * not this event. The previous sentence here claimed it drove notifier rules
 * and the live UI, which read as verification of a wiring that does not
 * exist. See
 * docs/superpowers/specs/2026-07-17-package-zones-design.md §5.1.
 */
export interface PipelineAnalyticsPackageDeliveredPayload {
  readonly deviceId: number
  /** Stationary-registry entry id the delivery is paired to. */
  readonly entryId: string
  /** Persisted `package-events` row id for this delivery. */
  readonly eventId: string
  readonly className: string
  /** Package-zone ids the entry's centroid fell inside. */
  readonly zoneIds: readonly string[]
  /** Native-res key-frame media row id (resolve via the event-media plane, D482). */
  readonly keyFrameMediaId?: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly timestamp: number
  readonly [key: string]: unknown
}

/**
 * Emitted by `addon-post-analysis` when a previously-delivered package
 * leaves its zone (its stationary entry departed — moved or TTL-swept).
 * Telemetry (D8). See package-zones-design §5.2.
 */
export interface PipelineAnalyticsPackagePickedUpPayload {
  readonly deviceId: number
  readonly entryId: string
  /** The `package-events` delivery row this pick-up pairs to. */
  readonly deliveredEventId: string
  readonly className: string
  /**
   * The track of the PERSON who collected the parcel, when one was resolved
   * (D404). It is also the pick-up row's media owner, which is what puts a
   * frame of the collector — rather than of the empty doormat — on the
   * notification. Absent means nobody qualified near the parcel's last
   * sighting; the pick-up still fires, carrying the parcel's own owner.
   */
  readonly collectorTrackId?: string
  readonly timestamp: number
  readonly [key: string]: unknown
}

/**
 * Child steps enabled for a camera + their scheduling policy, as read
 * from the pipeline catalog. Announced on `PipelineInferenceResultPayload`
 * so a track-level consumer knows which detail-subtree steps it can
 * dispatch via `pipelineRunner.runDetailSubtree` and on what cadence,
 * without a separate round-trip to the executor's schema/config caps.
 */
/**
 * Why a detection frame was inferred — the one vocabulary for it, shared by the
 * runner that produces the frame and the stationary ledger that folds it.
 */
export type InferenceOccasion = 'session' | 'burst'

export interface DetailStepAnnounce {
  readonly stepId: string
  readonly inputClasses: readonly string[]
  readonly cadence: StepCadence
  /**
   * The root model that SUPPLIES this step for this camera (D730): the root
   * declares it and the step's `useRootModel` flag is on — `resolveRootSupply`
   * says effective. Absent ⇒ the step runs as before.
   */
  readonly filledBy?: string
  /**
   * How the root supplies it, present with `filledBy`.
   * - `label`: the root's linked label IS the answer — never dispatched.
   * - `crop`: the root drew the step's box; the dispatcher sends the box to
   *   the step's served children (`rootSupplyServes`) and never infers the
   *   step itself. A step none of whose children are served is not dispatched.
   * A consumer that predates the field reads `filledBy` alone.
   */
  readonly filledAs?: 'label' | 'crop'
}

/**
 * Raw inference output emitted by `addon-pipeline-runner` per detection
 * frame. Carries the FrameResult produced by the runner — the hub-side
 * wiring service subscribes, applies the analysis pipeline +
 * notifications, and re-emits as `detection.result`.
 */
export interface PipelineInferenceResultPayload {
  readonly deviceId: number
  readonly frame: FrameResult
  /** The Moleculer node id of the runner that produced this result. */
  readonly nodeId: string
  /**
   * Handle to the decoded frame this result came from — undefined when
   * unavailable. Carries the shm-ring coordinates the runner read the
   * pixels from so post-analysis consumers can resolve the same frame
   * zero-copy.
   */
  readonly frameHandle?: FrameHandle
  /**
   * Wall-clock (ms) when the source frame was committed to the shm ring
   * (`DecodedFrame.capturedAt`). Forwarded downstream onto
   * `DetectionResultPayload` so consumers can measure true frame-capture
   * → delivery latency. Undefined when the frame carried no capture stamp.
   */
  readonly capturedAt?: number
  /**
   * Wall-clock (ms) read on the RUNNER's node at the instant this payload was
   * handed to the bus. A consumer's `now - emittedAt` is the delivery lag —
   * the one number that tells a late DELIVERY apart from a slow CONSUMER when
   * both produce the same signature (a silence, then a burst-drain). See
   * `addon-post-analysis/src/pipeline-analytics/frame-lag-observer.ts` for how
   * it is read and why the absolute value is not a latency.
   *
   * Optional, and undefined is UNKNOWN, never 0 (D8): the bus is telemetry,
   * and during a rolling deploy a runner older than this field emits payloads
   * without it as the normal case. A consumer that folds an absent stamp in as
   * 0 reports "delivered instantly" and fabricates exactly the verdict the
   * field exists to establish.
   */
  readonly emittedAt?: number
  /** Child steps enabled for this camera + their scheduling policy (from the catalog). */
  readonly detailSteps?: readonly DetailStepAnnounce[]
  /**
   * WHICH root detector produced `frame.detections`.
   *
   * `'pipeline'` (the default when absent — a runner older than this field
   * emits nothing else) is this runner's own root step on decoded pixels.
   * `'onboard'` is the CAMERA's detector, admitted by the runner because the
   * camera's `detectionSources` names it, and carried on this payload rather
   * than through a door of its own.
   *
   * One door on purpose. A camera-native detection used to reach post-analysis
   * on a separate event, and everything the pipeline plane gets for free was
   * lost on the way: the per-camera `detailSteps` announce above rides THIS
   * payload, so an onboard-born track had no face, no plate and no embedding
   * — invisible while the two planes ran side by side, and the whole feature
   * the moment one replaces the other.
   */
  readonly source?: DetectionSource
  /**
   * WHY this frame was inferred.
   *
   * `'session'` — a motion session is running and the pipeline was decoding
   * anyway, so the inference was free at the margin. `'burst'` — the periodic
   * occupancy recheck (`occupancyRecheckSec`), which re-dials or taps a camera
   * that nothing is watching purely to look at a STILL scene.
   *
   * Absent means `'session'`: a runner older than this field only ever emitted
   * session frames as far as any consumer could tell, which is precisely the
   * defect. The stationary ledger keeps per-occasion tallies so "is the recheck
   * earning its keep on this camera?" has an answer — and it counted every
   * burst as a session for the whole time the field did not exist, so the
   * answer was structurally zero.
   */
  readonly occasion?: InferenceOccasion
  readonly [key: string]: unknown
}

/**
 * Live per-audio-chunk output emitted by the pipeline-orchestrator for
 * each camera with audio analysis enabled. Mirrors `PipelineInferenceResultPayload`
 * but for audio: carries the canonical `AudioResult` produced by running
 * the audio-analyzer + audio-classifier inline on the hub.
 *
 * Replaces the legacy split `detection.audio.level` /
 * `detection.audio.classification` events — consumers should read
 * `frame.level` for dBFS/RMS and `frame.detections` for classifier
 * matches (both on the same single event).
 */
export interface PipelineAudioInferenceResultPayload {
  readonly deviceId: number
  readonly frame: AudioResult
  /**
   * Node id of the host that ran the analyzer, and since D461 it MEANS that:
   * `audio-analyzer` pulls its own audio and emits this event itself, from
   * whichever node the orchestrator dispatched the camera to. It was
   * hard-coded `'hub'` while `pipeline-orchestrator` relayed the PCM and
   * emitted on the analyzer's behalf.
   */
  readonly nodeId: string
  readonly [key: string]: unknown
}

/** Why the storage location set changed. */
export type StorageLocationsChangedReason = 'upsert' | 'delete'

/**
 * One change to the SET of storage locations (`EventCategory.StorageLocationsChanged`).
 *
 * Deliberately thin: it names WHICH location moved and WHAT kind of change it
 * was, and nothing about the row itself. A consumer re-reads
 * `storage.listLocations` — the event is a doorbell, and a payload carrying the
 * row would be a second, staler authority for it.
 *
 * A bulk edit rings this once per row, so every consumer coalesces.
 */
export interface StorageLocationsChangedPayload {
  readonly locationId: string
  readonly locationType: string
  readonly reason: StorageLocationsChangedReason
  readonly [key: string]: unknown
}

/**
 * Camera assignment lifecycle payload emitted by `addon-pipeline-orchestrator`
 * when a camera is assigned to or unassigned from an agent runner. Used by
 * the UI / metrics dashboard. No frame data.
 */
export type PipelinePackageLlmSilenceReason = 'timeout' | 'error'

/** The open edge: the confirm is not answering. `latencyMs` is the last call. */
export type PipelinePackageLlmSilencePayload = {
  readonly deviceId: number
  readonly reason: PipelinePackageLlmSilenceReason
  readonly latencyMs: number
}

/** The recovery edge. The camera is the subject; the answer itself is the package row. */
export type PipelinePackageLlmAnsweredPayload = {
  readonly deviceId: number
}

export type PipelineMotionNoisePayload = {
  readonly deviceId: number
  /** The rolling window the figures are over, in ms. */
  readonly windowMs: number
  /** Share of the window with a detection session open, whole percent. */
  readonly dutyPct: number
  /** Sessions opened in the window. */
  readonly sessions: number
}

export interface PipelineCameraAssignmentPayload {
  readonly deviceId: number
  readonly agentNodeId: string
  /** True when the assignment was set manually (preferredAgent setting), false when chosen by the load balancer. */
  readonly pinned: boolean
  readonly reason:
    | 'manual'
    | 'capacity'
    | 'hardware-affinity'
    | 'failover'
    | 'rebalance'
    | 'unassigned'
  readonly [key: string]: unknown
}

/**
 * Capability binding change payload emitted whenever an operator picks
 * a different addon to implement a capability on a node. Each kernel
 * process subscribes to this event and updates its local
 * `preferredProviderRegistry` so subsequent capability lookups return
 * the newly chosen provider.
 *
 * The event lives under `capability.binding-changed` because binding
 * is a kernel-level concept used by any cap provider (not just the
 * pipeline flow). It was renamed from `pipeline.binding-changed` to
 * reflect that broader scope.
 */
export interface CapabilityBindingChangedPayload {
  readonly nodeId: string
  readonly capName: string
  /** New preferred addon id, or null when the binding was cleared. */
  readonly addonId: string | null
  readonly [key: string]: unknown
}

export interface PhaseTransitionPayload {
  deviceId: number
  from: 'watching' | 'active'
  to: 'watching' | 'active'
  reason: 'motion_detected' | 'cooldown_expired'
  /** Motion source that armed the cooldown — present on both ON and OFF.
   *  The enum itself, never a hand-copied union: this was a second list of
   *  the sources and it silently excluded every variant added after it. */
  source?: import('../capabilities/pipeline-runner.cap.js').MotionSource
  /** Cooldown window in ms that was/is active for this transition. */
  cooldownMs?: number
  /** Ms epoch of the transition. */
  timestamp?: number
  /**
   * Why the phase changed. `motion`: the runner's motion gate (an `on-motion`
   * registration) — `source` and `cooldownMs` are set. `attach` / `detach`:
   * the camera was attached `always-on` (every on-motion detection SESSION
   * is) or detached while active. An attach names the motion that opened the
   * session (`source` + `triggeredBy`) when the orchestrator sent it; a
   * detach names none. `cooldownMs` is absent on both. Absent on a runner older than 2026-10-06,
   * whose attach claimed `source: 'analyzer'` and whose detach emitted
   * nothing.
   */
  cause?: PhaseTransitionCause
  /**
   * On a `cause: 'attach'` of an on-motion SESSION: what raised the motion
   * that opened it (D672) — the camera itself, or an attached sensor with its
   * deviceId. `source` is then the motion source that passed the camera's
   * gate. Absent on an attach with no motion behind it (occupancy burst,
   * standing always-on camera, re-dispatch) and from an orchestrator that does
   * not send `sessionTrigger`.
   */
  triggeredBy?: import('../pipeline/camera-sensors.js').MotionTriggeredBy
  /** The attached sensor's device name when `triggeredBy.kind === 'sensor'` and it is known. */
  sensorName?: string
  [key: string]: unknown
}

export type PhaseTransitionCause = 'motion' | 'attach' | 'detach'

// Legacy `AudioLevelPayload` / `AudioClassificationPayload` were removed
// when the live audio path was migrated to the canonical `AudioResult`
// shape — consumers now subscribe to `pipeline.audio-inference-result`
// and read level + detections from the single payload.

// ---------------------------------------------------------------------------
// System readiness protocol — see docs/superpowers/specs/2026-04-19-system-readiness-design.md
// ---------------------------------------------------------------------------

/**
 * Scope of a readiness transition — the "who does this ready/down apply to".
 *
 * Two shapes today:
 *  - `global` for singletons that are cluster-wide (there is only one hub).
 *  - `node` for per-process providers (one readiness per broker nodeID).
 *
 * `device` scope covers per-device native caps registered via
 * `DeviceContext.registerNativeCap(cap, provider)`. Consumers of cross-
 * process per-device caps (stream-broker, orchestrator, snapshot, webrtc)
 * `awaitReady(capName, {type:'device', deviceId})` before calling the
 * native-cap bridge so they don't race the service-advertise window.
 * On worker disconnect the hub-side registry's `agent.offline` demux
 * synthesises `down` for every device-scoped cap whose `sourceNodeId`
 * matches the offline node — same pattern as node-scoped synthesis.
 */
export type ReadinessScope =
  | { readonly type: 'global' }
  | { readonly type: 'node'; readonly nodeId: string }
  | { readonly type: 'device'; readonly deviceId: number }

/** States a capability provider transitions through. */
export type ReadinessState = 'starting' | 'ready' | 'down'

/**
 * Payload for `system.ready-state` events.
 *
 * `generation` is a per-process random identifier that stays constant
 * for the producer's lifetime and changes whenever the producer process
 * is restarted. The kernel's local `ReadinessRegistry` derives a
 * monotonic `epoch` per `(capName, scope)` by counting generation
 * transitions — emitters never stamp epoch themselves. Consumers that
 * hold long-lived state compare `transition.epoch > lastSeenEpoch` to
 * decide whether to rebuild.
 *
 * Same-generation repeated `ready` events are idempotent keepalives
 * (e.g. re-emitted on every `$node.connected`) — the registry keeps
 * epoch stable.
 */
export interface SystemReadyStatePayload {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly state: ReadinessState
  /** Per-process random id; changes on producer restart. */
  readonly generation: string
  readonly sourceNodeId: string
  readonly ts: number
  readonly [key: string]: unknown
}

/**
 * Payload carried on `system.restarting` (when the restart is being
 * scheduled) and `system.restart-completed` (after the new process
 * boots). Mirrors the on-disk `.restart-pending` marker schema in
 * `@camstack/system` so consumers don't need a separate type.
 *
 * Optional fields stay optional because not every restart is a
 * framework update — operator-triggered "restart hub" flows can fire
 * with just `kind: 'manual'` and `requestedAt`.
 *
 * kind values:
 *   `framework-update`      — framework/system-package update (via applyServerUpdate)
 *   `manual`                — operator-triggered restart (restartServer)
 *   `system`                — internal / supervisor-initiated restart
 *   `framework-bulk-update` — multi-package bulk update run as one lifecycle engine job
 */
export interface PendingRestartMarkerPayload {
  readonly kind: 'framework-update' | 'manual' | 'system' | 'framework-bulk-update'
  readonly packageName?: string
  readonly fromVersion?: string
  readonly toVersion?: string
  readonly requestedBy?: string
  readonly requestedAt: number
  /** Node that completed the restart, when known. */
  readonly nodeId?: string
  readonly [key: string]: unknown
}

/**
 * The hub reissued its own TLS certificate (`ensureTlsCert`, D227).
 *
 * Emitted once per boot, only when the certificate actually changed. An
 * operator who installed the previous certificate as trusted by hand has
 * to install `caCertPath` — this event is how they find out, instead of
 * from a browser error.
 */
export interface TlsCertChangedPayload {
  /** Machine-readable trigger — see `CertRegenerationReason`. */
  readonly reason: string
  /** SHA-256 fingerprint of the new leaf. */
  readonly fingerprintSha256: string
  /** SHA-256 fingerprint of the local root — the file to trust. */
  readonly caFingerprintSha256: string
  /** True when the ROOT rotated too, i.e. previously granted trust is void. */
  readonly caRotated: boolean
  /** Absolute path of the root certificate the operator should install. */
  readonly caCertPath: string
  /** ISO timestamp at which the new leaf stops being valid. */
  readonly validTo: string
  readonly sans: readonly string[]
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Cluster topology snapshot shape — matches `nodes.topology` cap output
// ---------------------------------------------------------------------------

/** One service entry inside a topology process — addon + capabilities. */
export interface TopologyService {
  readonly addonId: string
  readonly capabilities: readonly string[]
  readonly status: string
}

/** One process under a topology node (main process + isolated workers). */
export interface TopologyProcess {
  readonly pid: number
  readonly name: string
  readonly state: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
  readonly services: readonly TopologyService[]
  readonly groupId?: string
}

/** Per-node addon roll-up by category (Diagrams redesign 2026-05-20). */
export interface TopologyCategoryAddon {
  readonly id: string
  readonly status: string
  readonly cpuPercent: number
  readonly memoryRss: number
}

export interface TopologyCategory {
  readonly category: string
  readonly total: number
  readonly healthy: number
  readonly addons: readonly TopologyCategoryAddon[]
}

/** Top-level cluster node — hub or remote agent. */
export interface TopologyNode {
  readonly id: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string | null
  readonly cpuCores: number
  readonly memoryMB: number
  readonly engines: readonly string[]
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly cpuPercent: number
  readonly memoryPercent: number
  readonly uptime: number
  readonly lastSeen: string
  /** Local IP addresses visible on the network (non-internal, IPv4/IPv6). */
  readonly localIps: readonly string[]
  readonly addons: ReadonlyArray<{
    readonly id: string
    readonly capabilities: readonly string[]
    readonly status: string
  }>
  readonly processes: readonly TopologyProcess[]
  readonly categories: readonly TopologyCategory[]
  /**
   * The node's runtime-updatable ROOT package (`@camstack/server` — the
   * single root package for every node role) from its `registerNode`
   * manifest — version visibility for the Server management surface. Null for
   * offline rows and nodes that never reported one. Mirrors
   * `TopologyRootPackageSchema` in `nodes.cap.ts`.
   */
  readonly rootPackage: { readonly name: string; readonly version: string } | null
  /**
   * How an online agent reaches the hub (mesh mTLS Release A). Absent for the
   * hub, offline rows, and when the hub cannot tell. Mirrors `TopologyNodeSchema`.
   */
  readonly meshTransport?: 'tls' | 'clear'
  /**
   * Whether the hub holds this online agent's capability registration.
   * `false` = online but not ready. Absent for the hub and offline rows.
   * Mirrors `TopologyNodeSchema`.
   */
  readonly capabilitiesRegistered?: boolean
}

/**
 * Why a broker's stream health flipped — the discriminator that separates an
 * OUTAGE from an intentional state change.
 *
 * A `stream.offline` on its own says nothing about whether anything is wrong:
 * the same event is fired when a camera stops sending video AND when the last
 * consumer left and the broker suspended its dial on purpose. A consumer that
 * reads only the category cannot tell them apart, and the Notification Center
 * shipped exactly that bug — an operator notified that a stream went down
 * every time nobody was watching it.
 *
 *  - `stale-timeout`    — no video packet for the broker's stale window
 *    (120 s). The ONLY outage. This is what a notification may act on.
 *  - `recovered`        — packets resumed after a `stale-timeout`. The
 *    matching end of an outage.
 *  - `first-packet`     — a broker's first ever packet. A stream coming up, not
 *    a recovery: there was no outage before it.
 *  - `suspended`        — the lazy-dial idle suspend (no demand). Deliberate.
 *  - `resumed`          — demand returned and the dial came back. The matching
 *    end of a `suspended`, and equally deliberate.
 *  - `broker-destroyed` — the stream was unpublished/released. Deliberate.
 *
 * A BATTERY camera sleeping is none of these: a sleep or a plain wake emits no
 * `stream.offline` / `stream.online` at all (D883). It reaches an outage only
 * through the three battery reasons below, each naming a real failure:
 *
 *  - `wake-timeout`       — a wake was DEMANDED (live viewer, recording,
 *    explicit force) and no stream arrived inside its bound.
 *  - `connection-error`   — the camera is reported awake and its stream is
 *    gone.
 *  - `battery-unreachable` — nothing heard from the camera past its battery
 *    refresh window (`BATTERY_UNREACHABLE_AFTER_MS`, D847).
 *
 * Their `stream.online` is `recovered`, exactly as for `stale-timeout`.
 */
export type StreamHealthReason =
  | 'stale-timeout'
  | 'wake-timeout'
  | 'connection-error'
  | 'battery-unreachable'
  | 'recovered'
  | 'first-packet'
  | 'suspended'
  | 'resumed'
  | 'broker-destroyed'

// ---------------------------------------------------------------------------
// Known event catalog — typed category → payload mapping
// ---------------------------------------------------------------------------

/** All known event categories with their typed payloads */
/**
 * `keychain.changed` — a value was put or deleted. Never carries the value.
 */
export type KeychainChangedPayload = {
  readonly ref: string
  readonly owner: string
  /** The version now stored; `null` after a delete. */
  readonly version: number | null
  readonly change: 'put' | 'delete'
}

export interface EventCatalog {
  // ── System ──────────────────────────────────────────────────────────────
  'system.boot': { mode: string }
  'system.addons-ready': { activeAddons: readonly string[] }
  'system.restarting': PendingRestartMarkerPayload
  'system.restart-completed': PendingRestartMarkerPayload
  'system.tls-cert-changed': TlsCertChangedPayload
  'keychain.changed': KeychainChangedPayload
  'update.available': {
    /**
     * `addon` and `server` are npm packages a node can install for itself.
     * `wrapper` is the SHELL the node runs inside — the Docker image, the
     * Electron bundle — which no node can replace from within, so that one is
     * purely an announcement and mints no action (D437).
     */
    readonly target: 'addon' | 'server' | 'wrapper'
    readonly packageName: string
    readonly currentVersion: string
    readonly latestVersion: string
    /**
     * The node this announcement is ABOUT — `hub` for the hub itself. One event
     * covers exactly one node (2026-08-19): a union across nodes produced three
     * pushes that looked identical and named nobody.
     */
    readonly nodeId?: string
    /**
     * The FULL currently-available set OF THAT NODE. Present when the emitter
     * batches on a `latestVersion` change so one notification can list every
     * package instead of one event per row.
     */
    readonly packages?: readonly {
      readonly packageName: string
      readonly currentVersion: string
      readonly latestVersion: string
      readonly nodeId?: string
    }[]
    /** The announcing node, as a list — one entry, mirroring `nodeId`. */
    readonly nodeIds?: readonly string[]
    /**
     * `target: 'wrapper'` only — WHICH shell, so the notification body can
     * carry the one sentence that is actionable for it (the exact `docker`
     * command; "the app installs it on its next restart" for `electron`).
     * The kind is the whole message: there is no apply button and no
     * `canSelfUpdate` boolean, because nothing would read one.
     */
    readonly wrapperKind?: WrapperKind
  }
  'system.ready-state': SystemReadyStatePayload
  /**
   * A liveness invariant of this node is false. `findingId` is stable across
   * ticks, so AlertCenter keys one persistent alert on it rather than raising
   * a new one every check. See the `liveness-monitor` builtin.
   */
  'system.liveness-failed': {
    findingId: string
    severity: 'error' | 'warning'
    title: string
    message: string
    deviceId?: number
  }
  /** The invariant behind `findingId` holds again; the alert is dismissed. */
  'system.liveness-recovered': { findingId: string }

  // ── Addon lifecycle ─────────────────────────────────────────────────────
  'addon.started': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
  }
  'addon.stopped': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
  }
  'addon.restarted': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
  }
  'addon.updated': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
    fromVersion?: string
    toVersion?: string
  }
  'addon.installed': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
  }
  'addon.uninstalled': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
  }
  'addon.crashed': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
    error?: string
  }
  /**
   * A runner the crash circuit-breaker will not respawn again. One event per
   * TRIP (not per hosted addon): a group runner that dies takes every addon in
   * it down at once, and that is one outage, not N.
   */
  'addon.runner-failed': {
    runnerId: string
    /** The node the runner was spawned on — what an operator's rule filters by. */
    nodeId: string
    /** Every addon the runner hosted (size 1 in the normal one-addon-one-process case). */
    addonIds: string[]
    crashesInWindow: number
    windowMs: number
    /** The last exit's code / signal, when the OS reported one. */
    exitCode?: number
    signal?: string
  }
  /**
   * A runner whose addon REFUSED to start (D877): a typed, deterministic
   * Init refusal, not a crash. The runner waits in `refused` until an operator
   * acts; one event per refusal.
   */
  'addon.runner-refused': {
    runnerId: string
    nodeId: string
    addonIds: string[]
    /** Stable cause, e.g. `unmigrated-settings`. */
    code: string
    reason: string
    /** What the operator does about it. */
    remedy: string
  }
  'process.state-changed': {
    runnerId: string
    nodeId: string
    addonIds: string[]
    state: string
  }
  'system.runner-check': {
    nodeId: string
    degraded: boolean
    /** One sentence naming the findings. */
    summary: string
    expected: number
    running: number
    failed: string[]
    refused: { runnerId: string; reason: string }[]
    missing: string[]
  }
  'addon.error': {
    addonId: string
    packageName?: string
    packageVersion?: string
    agent?: string
    error?: string
    action?: string
    phase?: string
  }

  // ── Device ──────────────────────────────────────────────────────────────
  'device.registered': { deviceId: number; providerId: string; name?: string }
  'device.unregistered': { deviceId: number; providerId: string }
  'device.streams-registered': { deviceId: number; providerId: string }
  'device.streams-unregistered': { deviceId: number }
  'device.enabled': { deviceId: number; integrationId: string }
  'device.disabled': { deviceId: number; integrationId: string }
  'device.settings-updated': { deviceId: number; integrationId: string; keys: string[] }
  /**
   * Device online/offline aggregate. Emitted by the device's owning
   * provider (rtsp / reolink / onvif) when the union of its
   * stream-broker profile health flips. `online` fires when at least
   * one profile becomes healthy after all were offline; `offline` fires
   * when the last healthy profile goes stale (no packets for
   * STREAM_STALE_TIMEOUT_MS).
   */
  'device.online': { deviceId: number; providerId: string; profileCount?: number; reason?: string }
  'device.offline': { deviceId: number; providerId: string; reason?: string }
  'device.awake': { deviceId: number; providerId: string; reason?: string }
  'device.sleeping': { deviceId: number; providerId: string; reason?: string }
  /**
   * Emitted whenever the set of (device, capability) native providers or
   * wrapper activations changes. Hub subscribers use this to keep a
   * cross-process view of which addon/node currently serves each cap for
   * each device. `nodeId` is the broker nodeID where the provider lives;
   * 'hub' for hub-local. `addonId` is the provider (native or wrapper).
   */
  'device.bindings-changed': {
    deviceId: number
    capName: string
    reason:
      | 'native-registered'
      | 'native-unregistered'
      | 'wrapper-activated'
      | 'wrapper-deactivated'
    addonId: string
    nodeId: string
  }
  'device.meta-changed': {
    deviceId: number
    field: 'name' | 'location' | 'disabled'
    value: string | null | boolean
  }
  'device.source-info-changed': {
    deviceId: number
    sourceInfo: import('../device/source-info.js').SourceInfo
  }

  // ── Integration ────────────────────────────────────────────────────────
  'integration.enabled': { integrationId: string; addonId: string }
  'integration.disabled': { integrationId: string; addonId: string }

  // ── Broker (unified pub/sub registry) ──────────────────────────────────
  'broker.status-changed': {
    brokerId: string
    status: 'connected' | 'disconnected' | 'connecting' | 'auth-failed' | 'unreachable' | 'error'
    error?: string
  }
  'broker.message': {
    brokerId: string
    subscriptionId: string
    /** Provider-defined routing key — MQTT topic, HA entity_id, etc. */
    key: string
    /** Provider-defined payload — MQTT message bytes (base64'd in transit
     *  if binary), HA entity state object, etc. */
    payload: unknown
  }

  // ── Provider ────────────────────────────────────────────────────────────
  'provider.started': { providerId: string; type?: string }
  'provider.stopped': { providerId: string; reason?: string }

  // ── Process ─────────────────────────────────────────────────────────────
  'process.crashed': { processId: string; exitCode?: number; signal?: string }
  'process.restart_scheduled': { processId: string; delayMs: number }
  'process.restarted': { processId: string }

  // ── Storage ─────────────────────────────────────────────────────────────
  'storage.locations-changed': StorageLocationsChangedPayload

  // ── Recording ───────────────────────────────────────────────────────────
  'recording.started': { deviceId: number; streamId?: string }
  'recording.stopped': { deviceId: number; reason?: string }
  'recording.error': { deviceId: number; error: string }
  'recording.health.degraded': { deviceId: number; message: string }
  'recording.health.stalled': {
    deviceId: number
    idleMs: number
    thresholdMs: number
  }
  'recording.health.ok': { deviceId: number }
  'recording.storage.critical': { deviceId: number; usagePercent?: number }
  'storage.location.low': {
    locationId: string
    nodeId?: string
    locationName?: string
    freePercent: number | null
    reason: string
  }
  'storage.location.critical': {
    locationId: string
    nodeId?: string
    locationName?: string
    freePercent: number | null
    reason: string
  }
  'storage.location.ok': {
    locationId: string
    nodeId?: string
    locationName?: string
  }
  'notification.rule-broken': {
    ruleId: string
    /** `null` when the row was too broken to say. */
    ruleName: string | null
    /** The first reason; `reasons` carries them all. */
    reason: 'unparseable' | 'device-deleted' | 'target-deleted'
    reasons: readonly {
      code: 'unparseable' | 'device-deleted' | 'target-deleted'
      /** Device ids (decimal) or target ids; empty for `unparseable`. */
      ids: readonly string[]
      /** The first schema issue, for `unparseable`. */
      detail?: string
    }[]
    offendingIds: readonly string[]
  }
  'notification.rule-repaired': { ruleId: string; ruleName: string | null }
  'recording.segment.written': {
    deviceId: number
    path?: string
    durationSec?: number
    sizeMB?: number
  }
  'recording.policy.fallback': { deviceId: number; reason: string }
  'recording.retention.completed': { deletedCount?: number; freedMB?: number }
  'recording.export.progress': { exportId: string; progressPct: number }
  'recording.export.completed': {
    exportId: string
    fileBytes: number
    deviceId?: number
    title?: string
    notifyTargetIds?: readonly string[]
  }
  'recording.export.failed': { exportId: string; error: string }

  // ── Detection & analysis ────────────────────────────────────────────────
  'detection.event': { deviceId: number; detections?: unknown[]; [key: string]: unknown }
  'detection.result': DetectionResultPayload
  'detection.motion-analysis': MotionAnalysisPayload
  'detection.motion-zones-raw': MotionZonesRawPayload
  'motion.on-motion-changed': MotionOnMotionChangedPayload
  'pipeline-analytics.frame-tracked': PipelineAnalyticsFrameTrackedPayload
  'pipeline-analytics.track-lifecycle': PipelineAnalyticsTrackLifecyclePayload
  'pipeline-analytics.stationary-changed': PipelineAnalyticsStationaryChangedPayload
  'pipeline-analytics.face-gallery-changed': PipelineAnalyticsFaceGalleryChangedPayload
  'pipeline-analytics.plate-gallery-changed': PipelineAnalyticsPlateGalleryChangedPayload
  'pipeline-analytics.package-delivered': PipelineAnalyticsPackageDeliveredPayload
  'pipeline-analytics.package-picked-up': PipelineAnalyticsPackagePickedUpPayload
  /**
   * On-board detection coming straight from the camera firmware (Reolink
   * AI alarms, ONVIF analytics, etc.) — as opposed to `detection.result`
   * which is produced by the pipeline running locally.
   *
   * `source` discriminates the origin when multiple pipelines coexist for
   * the same camera: `'onboard'` for native firmware events, `'camera-native'`
   * kept as an alias for backwards compatibility with pre-Reolink emitters.
   *
   * `detections` is tightened from `unknown[]` to a structured shape. Each
   * entry describes one firmware-reported class ('motion', 'person',
   * 'vehicle', 'animal', 'face', 'package', 'other', …) at a point in time.
   */
  'detection.camera-native': CameraNativeDetectionPayload
  'pipeline.audio-inference-result': PipelineAudioInferenceResultPayload
  'detection.phase-transition': PhaseTransitionPayload
  /**
   * Emitted whenever a per-device override is written or cleared for any
   * pipeline-participating addon (pipeline-orchestrator, motion-wasm,
   * detection-pipeline, audio-analyzer, audio-classifier). The wiring
   * service subscribes to this event and restarts detection for the
   * affected camera so the new values take effect without a full reboot.
   * `addonId` is informational — most consumers only care about
   * `deviceId` and will rebuild the full RunnerCameraConfig anyway.
   */
  'orchestration.settings-updated': { deviceId: number; addonId?: string }
  'provider.motion': ProviderMotionPayload
  'provider.detection': { detections: unknown }

  // ── Session tracking ────────────────────────────────────────────────────
  'session.track.new': { deviceId: number; trackId: string; label?: string }
  'session.track.expired': { deviceId: number; trackId: string; durationMs?: number }

  // ── Benchmark ───────────────────────────────────────────────────────────
  /**
   * Progress from a running benchmark (pipeline image test, decoder perf test,
   * …). The payload is intentionally open (`kind` discriminator + free-form
   * additional fields) so different benchmark shapes share the same bus
   * category and a single UI subscriber can filter by `kind` + `sessionId`.
   */
  'benchmark.progress': {
    kind: string
    sessionId: string
    phase?: string
    tSec?: number
    sample?: Record<string, unknown>
    message?: string
  }

  // ── Pipeline & inference ────────────────────────────────────────────────
  'pipeline.progress': {
    /** Node that executed the pipeline step. Same value is also set on `event.source.nodeId`
     * but carried in the payload so admin-ui filters don't need to peek at the source shape. */
    nodeId: string
    /** Stable identifier per `runPipeline()` invocation — every progress event from the same
     * run shares this id so the UI can correlate a burst of messages into a single run card. */
    sessionId: string
    step: string
    addonId?: string
    modelId?: string
    ms?: number
    message?: string
  }
  /** Per-frame execution trace emitted by the pipeline executor for live observability. */
  'pipeline.trace': PipelineExecutionTrace
  /** Raw inference output emitted by addon-pipeline-runner (no frame buffer). */
  'pipeline.inference-result': PipelineInferenceResultPayload
  /** Camera assigned to an agent runner by addon-pipeline-orchestrator. */
  'pipeline.camera-assigned': PipelineCameraAssignmentPayload
  /** Camera released from an agent runner. */
  'pipeline.camera-unassigned': PipelineCameraAssignmentPayload
  /** A node whose every ENABLED inference device is unavailable — dropped from
   *  the placement candidate set until one comes back. */
  'pipeline.node-inference-unavailable': {
    readonly nodeId: string
    /** The enabled device keys the live probe did not report. */
    readonly unavailableDeviceKeys: readonly string[]
  }
  /** A camera that MOVED (enough session time over enough sessions), was
   *  analysed, and whose detector produced no raw output at all (D907). */
  'pipeline.detection-blind': {
    readonly deviceId: number
    /** Wall time since its last detection, in ms — context, not the gate. */
    readonly blindForMs: number
    /** The motion bar that was crossed, in ms. */
    readonly thresholdMs: number
    /** Session-open time since the detector last produced anything, in ms. */
    readonly motionMs: number
    /** Sessions opened in that time. */
    readonly sessions: number
    /** Frames since the last detection where candidates fell under the floor. */
    readonly belowFloor: number
  }
  /** A camera whose motion has been constant with no detection (D907). */
  'pipeline.motion-noisy': PipelineMotionNoisePayload
  /** The camera's motion fell back, or a detection arrived (D907). */
  'pipeline.motion-calm': PipelineMotionNoisePayload
  /** Package LLM confirm failed closed for the streak, one camera (D931). */
  'pipeline.package-llm-silent': PipelinePackageLlmSilencePayload
  /** A package LLM confirm returned yes or no after a silence edge (D931). */
  'pipeline.package-llm-answered': PipelinePackageLlmAnsweredPayload
  /** Per-camera pipeline config changed — orchestrator hot-reloads the assigned runner. */
  'pipeline.camera-updated': {
    readonly deviceId: number
    readonly config: CameraPipelineConfig
  }
  /**
   * Cluster camera-source owner (`clusterRoles.ingestNode`) resolved/changed.
   * Pushed by addon-pipeline-orchestrator on every node-capability refresh so
   * the stream-broker gates physical-broker creation on the current owner
   * without a per-`ensureBroker` `getIngestOwner` query.
   */
  'pipeline.ingest-owner-changed': {
    readonly ownerNodeId: string
  }
  /**
   * Periodic per-runner load snapshot (~1 Hz). Replaces UI polling on
   * `pipelineRunner.getLocalLoad`. UI subscribes per agent node.
   */
  'pipeline.runner-load-snapshot': {
    readonly nodeId: string
    readonly load: RunnerLocalLoad
    /** Wall-clock ms when the snapshot was sampled. */
    readonly timestamp: number
  }
  /**
   * Periodic per-camera metrics snapshot (~1 Hz). Replaces UI polling
   * on `pipelineOrchestrator.getCameraMetrics` /
   * `pipelineRunner.getCameraMetrics`. One event per attached camera
   * per tick. UI consumers filter by `deviceId`.
   */
  'pipeline.camera-metrics-snapshot': {
    readonly deviceId: number
    readonly nodeId: string
    readonly metrics: CameraMetrics
    readonly timestamp: number
  }
  /**
   * Periodic per-broker stats snapshot (~1 Hz). Replaces polling on
   * `streamBroker.getBrokerStats` and `streamBroker.listAllProfileSlots`.
   * Carries the full `BrokerStats` payload so UI consumers can render
   * the panel directly from the event without round-tripping the cap.
   */
  'stream-broker.metrics-snapshot': {
    readonly brokerId: string
    readonly deviceId: number
    readonly profile: string
    readonly nodeId: string
    readonly stats: BrokerStats
    readonly timestamp: number
  }
  /**
   * Cap event: stream-broker signals that a profile slot now has at
   * least one consumer. Camera-provider addons (Reolink Baichuan push,
   * etc.) start their underlying transport on receipt — see
   * `EventCategory.StreamBrokerOnCamStreamDemand`.
   */
  'stream-broker.onCamStreamDemand': {
    readonly deviceId: number
    readonly camStreamId: string
    readonly profile: CamProfile
  }
  /**
   * Cap event: stream-broker signals the last consumer left. Providers
   * tear down their transport — see `EventCategory.StreamBrokerOnCamStreamIdle`.
   */
  'stream-broker.onCamStreamIdle': {
    readonly deviceId: number
    readonly camStreamId: string
  }
  /**
   * Low-latency nudge: a provider changed a device's stream parameters.
   * Carries NO authoritative data — the stream-broker re-pulls that device's
   * `stream-catalog` on receipt. See `EventCategory.StreamParamsChanged`.
   */
  'stream-params.changed': {
    readonly deviceId: number
  }
  /**
   * Cap event: device's battery status changed (firmware push or
   * provider-side observation). Mirrors `batteryCapability.onStatusChanged`.
   * Payload shape duplicated inline (rather than importing from
   * `capabilities/battery.cap`) to avoid a cycle between the cap
   * definitions and the event bus typing — they're kept in lock-step
   * by hand (see also `BatteryStatus` in `capabilities/battery.cap.ts`).
   *
   * "By hand" failed exactly as the repo's no-duplicate-shapes rule predicts:
   * `level` became nullable in the cap and stayed `number` here, so this
   * copy refused the very value the cap now defines. Kept in lock-step is a
   * hope; the compiler noticing is the only reason it was caught.
   */
  'battery.onStatusChanged': {
    readonly deviceId: number
    readonly status: {
      /** `null` = NOT YET KNOWN. See `BatteryStatusSchema.level`. */
      readonly level: number | null
      /** `'unknown'` = the power source was never read. See `BatteryStatusSchema.charging`. */
      readonly charging: 'dc' | 'solar' | 'none' | 'unknown'
      readonly sleeping: boolean
      readonly lastUpdated: number
    }
  }
  /**
   * Emitted by the battery cap provider when `wakeForStream` enters the
   * wake-in-progress window. Subscribers (stream-broker manager) flip
   * the broker's placeholder reason to `'waking'` so encoded-path
   * viewers see a labelled tile instead of the generic reconnecting
   * frame. Reset is implicit — the subsequent
   * `battery.onStatusChanged { sleeping: false }` event flips the
   * reason back to `'reconnecting'`, and the first real RTP packet
   * stops the placeholder timer.
   */
  'battery.onWakeStarted': {
    readonly deviceId: number
  }
  /**
   * Doorbell button press — emitted by every device that registers the
   * `doorbell` capability. Mirrors `doorbellCapability.events.onPressed`.
   * Subscribers (UI toast, advanced-notifier) react to physical rings
   * without holding a cap reference.
   */
  'doorbell.onPressed': {
    readonly deviceId: number
    readonly timestamp: number
  }
  /**
   * Generic event fired — emitted by every device that registers the
   * `event-emitter` capability. Mirrors `eventEmitterCapability.events.onEvent`.
   * Carries the device's EXACT declared event verbatim (NO normalization);
   * `seq` is monotonic so identical events stay distinct. Subscribers
   * (UI event stream, advanced-notifier) react without holding a cap reference.
   */
  'event-emitter.event': {
    readonly deviceId: number
    readonly eventType: string
    readonly data: Record<string, unknown> | null
    readonly timestamp: number
    readonly seq: number
  }
  /**
   * Periodic per-node engine inventory snapshot (~0.2 Hz). Replaces
   * polling on `pipelineExecutor.listLoadedEngines`. One event per
   * detection-pipeline process per tick, carrying every loaded engine
   * with the same shape the cap returns.
   */
  'pipeline.engine-metrics-snapshot': {
    readonly nodeId: string
    readonly engines: ReadonlyArray<{
      readonly engineKey: string
      readonly engine: PipelineEngineChoice
      readonly modelsLoaded: readonly string[]
      readonly inUseByCameras: readonly number[]
      readonly kind: 'runtime' | 'device-pool'
      readonly poolPid: number | null
      readonly idleMs: number | null
      readonly idleTtlMs: number | null
    }>
    readonly timestamp: number
  }
  /**
   * Per-node detection-engine runtime-provisioning transition. Carries
   * the `EngineProvisioningState` snapshot (runtimeId / device / phase +
   * optional progress / error / nextRetryAt). `nodeId` rides on
   * `event.source.nodeId`. Emitted by the detection-pipeline provider on
   * every state change. Phase 2.
   */
  'pipeline.engine-provisioning': {
    readonly runtimeId: 'onnx' | 'openvino' | 'coreml' | 'edgetpu' | null
    readonly device: string | null
    readonly state: 'idle' | 'installing' | 'verifying' | 'ready' | 'failed'
    readonly progress?: number
    readonly error?: string
    readonly nextRetryAt?: number
  }
  /**
   * Cluster topology snapshot — same payload shape that
   * `nodes.topology` returns. Emitted by the hub on any agent /
   * addon lifecycle change (debounced ~200ms) plus a periodic safety
   * net. UI dashboards subscribe to drive their cluster view
   * directly from the event payload — zero round-trip.
   */
  'cluster.topology-snapshot': {
    readonly nodes: ReadonlyArray<TopologyNode>
    readonly timestamp: number
  }
  /**
   * Periodic per-node system metrics snapshot. Carries the full
   * `SystemResourceSnapshot` returned by
   * `metricsProvider.getCached()` so dashboards render CPU /
   * memory / GPU / disk / network without polling.
   */
  'metrics.node-resources-snapshot': {
    readonly nodeId: string
    readonly snapshot: SystemResourceSnapshot
    readonly timestamp: number
  }
  /**
   * Periodic per-node process-tree snapshot (`NodeProcess[]` —
   * camstack-related pids with root / managed / system classification).
   * One event per node per tick. Replaces polling on
   * `metricsProvider.listNodeProcesses`.
   */
  'metrics.node-processes-snapshot': {
    readonly nodeId: string
    readonly processes: ReadonlyArray<NodeProcess>
    readonly timestamp: number
    /**
     * The CONTAINER's memory at the SAME instant as `processes`, or `null`
     * when this node has no cgroup.
     *
     * It rides this event rather than one of its own for a single reason: the
     * question is a subtraction. The processes above sum to one number and
     * this is another, and two events would carry two timestamps that never
     * quite line up. `null` is ABSENT — never a zeroed reading.
     */
    readonly containerMemory: ContainerMemorySnapshot | null
  }
  /** Capability binding changed for a node — kernels update their preferred-provider registry. */
  'capability.binding-changed': CapabilityBindingChangedPayload
  'model.download.progress': { modelId: string; progress: number; totalMB?: number }

  // ── Agent ───────────────────────────────────────────────────────────────
  'agent.online': { agentId: string; nodeName?: string }
  /**
   * `reason`: Moleculer's verdict — `connection-lost` (heartbeat / socket gone,
   * `$node.disconnected` with `unexpected: true`) or `shutdown` (the agent said
   * goodbye). `nodeName` is the durable history's display name when known.
   */
  'agent.offline': {
    agentId: string
    nodeName?: string
    reason?: 'connection-lost' | 'shutdown'
  }
  'worker.online': { workerId: string }
  'worker.offline': { workerId: string }
  'agent.task.assigned': { agentId: string; taskId: string; taskType: string; payload?: unknown }

  // ── Enrichment ──────────────────────────────────────────────────────────
  'enrichment.embedding.stored': {
    readonly deviceId: number
    readonly trackId: string
    readonly class: string
    readonly embeddingId: string
    readonly modelId: string
    readonly embeddingDim: number
    readonly inferenceMs: number
    readonly timestamp: number
  }
  'enrichment.scene.state-changed': {
    readonly deviceId: number
    readonly monitorId: string
    readonly monitorLabel: string
    readonly previousState: string
    readonly currentState: string
    readonly confidence: number
    readonly timestamp: number
  }
  'enrichment.activity.summary': {
    readonly deviceId: number
    readonly periodStart: number
    readonly periodEnd: number
    readonly objectCounts: Readonly<Record<string, number>>
    readonly zoneActivity: readonly {
      readonly zoneId: string
      readonly entries: number
      readonly exits: number
      readonly avgDwellMs: number
    }[]
    readonly stateChanges: readonly {
      readonly monitorId: string
      readonly from: string
      readonly to: string
      readonly timestamp: number
    }[]
    readonly activityLevel: 'none' | 'low' | 'medium' | 'high'
  }

  // ── Alerts ──────────────────────────────────────────────────────────────
  'alert.created': { id: string; category: string; severity: string; title: string; status: string }
  'alert.updated': { alertId: string; patch: Record<string, unknown> }
  'alert.episode': AlertEpisodePayload

  // ── Stream broker health ────────────────────────────────────────────────
  /**
   * Per-broker stream health transition. Fired by the stream-broker
   * watchdog. `camStreamId` is the canonical identity of the source
   * (every broker is keyed by its cam stream now); `profile` is the
   * profile slot currently bound to it (or `null` if the broker is
   * only kept alive by a manual activation).
   *
   * `reason` is the discriminator a consumer MUST read before treating a flip
   * as an outage — see {@link StreamHealthReason}.
   */
  'stream.online': {
    readonly deviceId: number
    /** Absent when a failed wake names no published stream (a sleeping camera after a restart). */
    readonly camStreamId?: string
    readonly profile: CamProfile | null
    readonly brokerId: string
    readonly sourceType: string
    readonly lastPacketAt: number
    readonly reason?: StreamHealthReason
    /**
     * Every stream of the device this one transition covers. An outage and its
     * recovery are DEVICE transitions (D883): main and sub dropping together is
     * ONE event whose `camStreamId` / `profile` name the first and this list
     * names them all. Absent on per-broker lazy-dial telemetry.
     */
    readonly camStreamIds?: readonly string[]
  }
  'stream.offline': {
    readonly deviceId: number
    /** Absent when a failed wake names no published stream (a sleeping camera after a restart). */
    readonly camStreamId?: string
    readonly profile: CamProfile | null
    readonly brokerId: string
    readonly sourceType: string
    readonly lastPacketAt: number
    readonly reason?: StreamHealthReason
    /**
     * Every stream of the device this one transition covers. An outage and its
     * recovery are DEVICE transitions (D883): main and sub dropping together is
     * ONE event whose `camStreamId` / `profile` name the first and this list
     * names them all. Absent on per-broker lazy-dial telemetry.
     */
    readonly camStreamIds?: readonly string[]
  }

  // ── Retention ───────────────────────────────────────────────────────────
  'retention.cleanup': {
    readonly deletedEvents?: number
    readonly deletedAudioRecords?: number
    readonly deletedSnapshots?: number
    readonly deletedCount?: number
    readonly freedMB?: number
  }

  // ── Bulk update ──────────────────────────────────────────────────────────
  /**
   * Legacy bulk-update progress snapshot (payload `BulkUpdateState`). No longer
   * emitted — F3 removed the coordinator that produced it; "Update all" now runs
   * as one lifecycle engine job. Retained only to keep the event maps stable;
   * removed in F4 once live bulk progress moves to the engine events.
   */
  'addons.bulk-update-progress': BulkUpdateState

  // ── Mesh network ──────────────────────────────────────────────────────────
  /**
   * Emitted by a `mesh-network` provider when its mesh-reachable host
   * changes (Tailscale join / leave / MagicDNS or 100.x IP change).
   * `local-network` tails this to fold the mesh endpoint into its
   * connection-endpoint list. `host: ''` means the host is no longer
   * mesh-reachable (consumer clears its cached endpoint).
   */
  'network.mesh.changed': {
    /** Preferred mesh host — MagicDNS name when available, else the
     *  raw mesh IP. Empty when no longer reachable. */
    readonly host: string
    /** Hub HTTPS port the mesh endpoint should target. */
    readonly port: number
    /** Always `https` — the hub terminates TLS. */
    readonly protocol: 'https'
  }

  // ── Model conversion (P3) ────────────────────────────────────────────────
  /**
   * Progress update from a running model conversion job.
   * Emitted by `addon-model-studio` on the converting node.
   * The `kind` discriminator is always `'model-convert'`; UI subscribers
   * can filter by `kind` + `sessionId` to correlate events from one job.
   */
  'model-convert.progress': {
    kind: 'model-convert'
    phase: string
    sessionId?: string
    pct?: number
    detail?: string
  }
}

/** All known event category strings (derived from EventCatalog keys) */
export type KnownEventCategory = keyof EventCatalog

// ---------------------------------------------------------------------------
// SystemEvent — backward-compatible base type
// ---------------------------------------------------------------------------

/**
 * System event — `data` is `Record<string, unknown>` for backward compatibility.
 * Use `TypedSystemEvent<C>` or `narrowEvent()` for typed access to data.
 */
export interface SystemEvent {
  id: string
  timestamp: Date
  source: EventSource
  category: string
  data: Record<string, unknown>
  /**
   * Propagation chain when the event was re-emitted by the
   * `DeviceEventPropagator`. `via[0]` is the originating source (the
   * child that produced the event); subsequent entries walk up the
   * parent chain. Absent on the original emission and on events that
   * don't belong to a device-rooted source.
   *
   * Consumers that want ONLY direct events filter `ev.via === undefined`.
   * Consumers that want everything reaching a device (incl. children)
   * filter by `source.id === parentId` and accept any `via`.
   */
  via?: readonly EventSource[]
}

/**
 * A system event with a known category — `data` is typed.
 * Use this when you know the exact category at compile time.
 */
export type TypedSystemEvent<C extends KnownEventCategory> = {
  id: string
  timestamp: Date
  source: EventSource
  category: C
  data: EventCatalog[C]
  via?: readonly EventSource[]
}

// ---------------------------------------------------------------------------
// Event filter
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Event filter — accepts known categories (strict) or strings (globs/custom)
// ---------------------------------------------------------------------------

/** A category filter value: a known category, a glob string, or an array of either */
export type EventCategoryFilter =
  | KnownEventCategory
  | (string & {})
  | readonly (KnownEventCategory | (string & {}))[]

export interface EventFilter {
  source?: EventSource
  /** Filter by top-level agent (e.g. 'hub', 'agent-a1b2c3'). Matches source.nodeId with prefix match so 'hub' includes 'hub/pipeline'. Same semantics as logs tags.agentId. */
  agentId?: string
  /** Filter by addon that originated the event. Matches source.addonId or source.id when type='addon'. */
  addonId?: string
  /** Filter by device the event relates to. Matches source.deviceId or source.id when type='device'. */
  deviceId?: number
  /** Category — known category (typed), glob (e.g. 'device.*'), or array */
  category?: EventCategoryFilter
  since?: Date
}

// ---------------------------------------------------------------------------
// Typed event filter — for subscribe overloads
// ---------------------------------------------------------------------------

export interface TypedEventFilter<C extends KnownEventCategory> {
  source?: EventSource
  category: C | readonly C[]
  since?: Date
}

// ---------------------------------------------------------------------------
// IEventBus — emit and subscribe are typed when using known categories
// ---------------------------------------------------------------------------

export interface IEventBus {
  /** Emit a known-category event with typed payload */
  emit<C extends KnownEventCategory>(event: TypedSystemEvent<C>): void
  /** Emit an arbitrary event (custom/unknown category) */
  emit(event: SystemEvent): void

  /** Subscribe to a known category — handler receives typed event */
  subscribe<C extends KnownEventCategory>(
    filter: TypedEventFilter<C>,
    handler: (event: TypedSystemEvent<C>) => void,
  ): () => void
  /** Subscribe with a generic filter — handler receives base SystemEvent */
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void

  /** Get recent events */
  getRecent(filter?: EventFilter, limit?: number): readonly SystemEvent[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrow a SystemEvent to a typed event by checking its category.
 * Returns `true` (and narrows the type) if the category matches.
 *
 * @example
 * ```typescript
 * eventBus.subscribe({ category: 'addon.started' }, (event) => {
 *   if (isEvent(event, 'addon.started')) {
 *     event.data.addonId  // ✓ typed as string
 *   }
 * })
 * ```
 */
export function isEvent<C extends KnownEventCategory>(
  event: SystemEvent,
  category: C,
): event is TypedSystemEvent<C> {
  return event.category === category
}

/**
 * Create a typed event with less boilerplate.
 *
 * @example
 * ```typescript
 * eventBus.emit(createEvent('addon.started', { type: 'addon', id: 'pipeline' }, {
 *   addonId: 'pipeline',
 *   packageVersion: '0.1.8',
 * }))
 * ```
 */
export function createEvent<C extends KnownEventCategory>(
  category: C,
  source: EventSource,
  data: EventCatalog[C],
): TypedSystemEvent<C> {
  return {
    id:
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    timestamp: new Date(),
    source,
    category,
    data,
  }
}

// ---------------------------------------------------------------------------
// System readiness protocol — low-level producer emission helper.
// Consumers (kernel `ReadinessRegistry`) and their `awaitReady` /
// `onReadyState` APIs live in `@camstack/system/src/readiness/`.
// ---------------------------------------------------------------------------

/**
 * Emit a `system.ready-state` event for a capability. Caller supplies a
 * per-process `generation` string — stable across a single process
 * lifetime, changes on restart — which consumer-side registries use to
 * derive a monotonic `epoch` without requiring the emitter to
 * coordinate.
 */
export function emitReadiness(
  bus: IEventBus,
  params: {
    readonly capName: string
    readonly scope: ReadinessScope
    readonly state: ReadinessState
    readonly generation: string
    readonly sourceNodeId: string
    readonly ts?: number
  },
): void {
  const ts = params.ts ?? Date.now()
  bus.emit(
    createEvent(
      'system.ready-state',
      { type: 'capability', id: params.capName, nodeId: params.sourceNodeId },
      {
        capName: params.capName,
        scope: params.scope,
        state: params.state,
        generation: params.generation,
        sourceNodeId: params.sourceNodeId,
        ts,
      },
    ),
  )
}
