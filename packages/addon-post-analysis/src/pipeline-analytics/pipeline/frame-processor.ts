/**
 * FrameProcessor — per-device pipeline stage runner.
 *
 * Consumes a raw `PipelineInferenceResult` payload and runs:
 *   1. Flatten first-level detections
 *   2. Zone filter (ZoneEngine)
 *   3. Tracking (TrackerV2, D683: L1 tracklets + the deferred L2 linker)
 *   4. State analysis (StateAnalyzer)
 *   5. Event emission (DetectionEventEmitter)
 *
 * Returns a structured result the addon uses to:
 *   - upsert TrackStore
 *   - insert ObjectEvent rows into the declared collection
 *   - emit onFrameTracked / onDetectionEvent on the bus
 *
 * One FrameProcessor per device — lifecycle managed by DeviceRegistry.
 */

import type {
  BirthEvidence,
  BoundingBox,
  DetectionSource,
  FrameResult,
  LabelTier,
  NativeRecoveryEvidence,
  ObjectEventDraft,
  ScoredLabel,
  SpatialDetection,
  TrackedDetection,
  TrackState,
  Zone,
  ZoneCrossing,
  ZoneCrossingDirection,
  ZoneEvent,
  ZoneRule,
} from '@camstack/types'
import { DetectionEventEmitter } from './events/event-emitter.js'
import type { EventEmitterConfig } from './events/event-filter.js'
import { TripwireTracker } from './events/tripwire-tracker.js'
import { faceIsInsideParent } from './face-parent-containment.js'
import { ZoneTransitionTracker } from './events/zone-transition-tracker.js'
import {
  knownTrackLabelPatch,
  type LabelWriteRefusal,
  resolveTieredLabelWrite,
  type TieredLabelDecision,
  type TieredLabelPatch,
  type TieredLabelState,
} from './label-tier.js'
import { resolveDetectionLabelCandidate } from './label-utils.js'
import { pairRiders, riderSubjectBox } from './rider-pairing.js'
import type { StationaryConfirmation, StationaryWake } from './stationary/stationary-match.js'
import {
  LOW_SCORE_CONTINUATION_FLOOR_DEFAULT,
  selectLowScoreContinuations,
} from './tracker/low-score-continuation.js'
import {
  SPAWN_REFUSAL_LOG_SAMPLE_EVERY,
  type SpawnRefusalObserver,
  type SpawnRefusalReason,
  type SpawnRefusalFacts,
  SpawnRefusalSampler,
} from './tracker/spawn-refusal.js'
import type { StateAnalyzerConfig } from './tracker/state-analyzer.js'
import { StateAnalyzer } from './tracker/state-analyzer.js'
import type { BboxRect } from './zones/geometry.js'
import { bboxCentroid, type LineSegment } from './zones/geometry.js'
import { type DetectionZoneMembership, ZoneEngine } from './zones/zone-engine.js'
import { newTrackId, type TrackIdMinter } from './track-id.js'
import { type FrameObservation, observeFrame } from './frame-observation.js'
import { renameKey, renameMember } from './tracker-v2/rename.js'
import {
  DEFAULT_TRACKER_V2_CONFIG,
  type TrackDropReason,
  TrackerV2,
  type TrackerV2Config,
  type TrackerV2Emission,
  type TrackerV2Observers,
  type TrackFusion,
  type TrackletEndReason,
} from './tracker-v2/index.js'

/** What the addon (or the bench) injects into a processor. */
export interface FrameProcessorDeps {
  /** Track-id source; production's random minter when absent (D681). */
  readonly mintTrackId?: TrackIdMinter
  /** D683: the wall clock the silence sweep compares against; production
   *  `Date.now`, tests inject one. Replay passes a constant — it never reads
   *  `frameNow` (`ProcessorTracker.finish` advances in frame time directly). */
  readonly wallClock?: () => number
}

/** Tracklets ended in a window, by why they ended. */
export type TrackletEndCounts = Readonly<Record<TrackletEndReason, number>>

/** Ends split by the tracklet's own birth gate (review M2). */
export interface TrackletEndStats {
  readonly confirmed: TrackletEndCounts
  readonly unconfirmed: TrackletEndCounts
}

/** What tracker v2 did since the last drain — the per-minute summary line. */
export interface TrackerV2Stats {
  /** An unconfirmed piece was never a track: its ends are a different question. */
  readonly tracklets: TrackletEndStats
  readonly splits: number
  readonly linksCommitted: number
  readonly linksRefused: number
  /** Pieces L2 decided had no predecessor (`new`), whatever the reason — the
   *  count behind the sampled `new` line (review M1). */
  readonly linksNew: number
  /** Committed chains a later verdict named twice (each also logged WARN). */
  readonly linksDisagreed: number
  /** Emissions a sub-floor box held this window (D665's tier, review L5). */
  readonly lowScoreHolds: number
  /** Frames stamped before the latest one, dropped by the tracker unassociated
   *  (follow-up 102, F1) — the exact count behind the sampled log line. */
  readonly outOfOrderFrames: number
  /** Frame-clock steps back past the stale bound: every tracklet ended, the clock
   *  rebased (follow-up 102, fix round 2). Each is also an unsampled WARN. */
  readonly clockSteps: number
}

type MutableTrackerV2Stats = { -readonly [K in keyof TrackerV2Stats]: TrackerV2Stats[K] }

const NO_ENDS: TrackletEndCounts = {
  missed: 0,
  ambiguous: 0,
  dropped: 0,
  stationary: 0,
  'clock-step': 0,
}

function emptyStats(): MutableTrackerV2Stats {
  return {
    tracklets: { confirmed: NO_ENDS, unconfirmed: NO_ENDS },
    splits: 0,
    linksCommitted: 0,
    linksRefused: 0,
    linksNew: 0,
    linksDisagreed: 0,
    lowScoreHolds: 0,
    outOfOrderFrames: 0,
    clockSteps: 0,
  }
}

/** Nothing happened in the window: no tracklet ended, no split, no L2
 *  decision, no low-score hold (review LOW-N1 — what the sweep stays quiet about). */
export function isIdleTrackerStats(stats: TrackerV2Stats): boolean {
  const ends = [stats.tracklets.confirmed, stats.tracklets.unconfirmed].flatMap((c) =>
    Object.values(c),
  )
  return (
    ends.every((n) => n === 0) &&
    stats.splits === 0 &&
    stats.linksCommitted === 0 &&
    stats.linksRefused === 0 &&
    stats.linksNew === 0 &&
    stats.linksDisagreed === 0 &&
    stats.lowScoreHolds === 0 &&
    stats.outOfOrderFrames === 0 &&
    stats.clockSteps === 0
  )
}

/** What the processor hands the stationary gate on every frame. */
export interface StationaryGateInput {
  readonly detections: readonly SpatialDetection[]
  readonly frameWidth: number
  readonly frameHeight: number
  /**
   * This frame's observed time. The gate's departure decisions are decisions
   * about time SEPARATION (D279), so a gate that could not see the clock
   * could not make them — and the registry may not read one of its own,
   * because expiry here counts observed frames, never wall clock.
   */
  readonly timestamp: number
  /**
   * The frame's detection id for each entry of `detections`, aligned by
   * index (D681). The production gate does not read it; the bench's
   * recorded gate does, because a replayed box has no object identity to
   * join on.
   *
   * Built on EVERY frame, observed or not — a gate input that depended on
   * `observe` would hand an observing and a plain run different inputs.
   * Measured cost (Node, the same `map` + `Map.get` shape): ~26 ns/frame at
   * 3 detections, ~63 ns at 10, ~180 ns at 30 — under 1 µs/s per camera at
   * 8 fps. The same array is what `observeFrame` reads.
   */
  readonly detectionIds?: readonly (string | undefined)[]
}

/** The gate's answer for one frame. */
export interface StationaryGateOutcome {
  /** Detections that may not OPEN a track. */
  readonly suppressedIndices: ReadonlySet<number>
  /** The weak subset of `suppressedIndices` the tracker may still use to
   *  CONTINUE a confirmed track (D410); the rest never reach it. */
  readonly continuableIndices: ReadonlySet<number>
  readonly confirmed: readonly StationaryConfirmation[]
  /** Entries whose departure was INDEPENDENTLY confirmed → the registry
   *  retires them and the detection tracks normally. Strike bookkeeping is
   *  the gate's own; nothing about it travels on this result. */
  readonly woken: readonly StationaryWake[]
}

/**
 * Per-frame stationary-object gate injected by the addon. Called just before
 * the tracker to drop detections that keep confirming a parked object (so no
 * track spawns), while reporting which registry entries were confirmed (kept in
 * frame occupancy) and which woke (their object departed → a track may spawn).
 */
export interface StationaryFrameGate {
  filter(input: StationaryGateInput): StationaryGateOutcome
}

/**
 * A rider folded into its machine on the current frame, RESOLVED to the track
 * that survived the fold.
 *
 * D34 and the fold's own comment both said "the person is not lost — it is
 * reported so both entities stay on the record". It was not. The pairs went
 * into a per-processor RAM field (`lastRiderPairs`) behind an accessor NO
 * CALLER EVER READ, carrying scores rather than entities, and nothing about the
 * person reached the track row, the event row, the notification or the
 * timeline. The record said `vehicle`, full stop — a record that describes the
 * right design and does not do it, which is the failure mode CLAUDE.md names
 * first.
 *
 * So the fold now names the SURVIVING TRACK, and the addon stamps
 * `Track.hasRider` on it. `trackId` is absent when the tracker did not emit the
 * vehicle this frame (below `minHits`, or the stationary gate suppressed it) —
 * that is a real outcome and it is LOGGED rather than silently dropped, because
 * a fold with nowhere to land is exactly the case that produced this defect.
 */
export interface RiderFold {
  /** The surviving vehicle's track, when the tracker emitted it this frame. */
  readonly trackId?: string
  readonly overlap: number
  readonly personScore: number
  readonly vehicleScore: number
  /** The two-wheeler's fine class (`bicycle` / `motorcycle`). */
  readonly vehicleClass: string
}

/**
 * A label candidate the write rule REFUSED on the current frame. One entry per
 * track per rejected token, not per frame: see
 * {@link FrameProcessor.getLastLabelWriteRefusals}.
 *
 * The `macro-class` case is the 2026-08-07 tier collapse — the raw-class
 * fallback offering a macro class for a slot whose whole purpose is information
 * FINER than the class. Since 4g it is one outcome of the single write rule
 * rather than its own branch, and it shares the reporting path with the other
 * refusals (an undeclared tier, a lower-scoring same-tier candidate).
 */
export interface LabelWriteRefusalInfo {
  readonly trackId: string
  readonly reason: LabelWriteRefusal
}

/** Shared empty — a fold is rare and every other frame would allocate. */
const EMPTY_RIDER_FOLDS: readonly RiderFold[] = []

interface FlatDetection extends BboxRect {
  readonly detection: SpatialDetection
  readonly sourceId: string
}

/**
 * A box the ROOT model drew inside a tracked subject (D730) — a plus catalog
 * `license_plate` in a vehicle, a `face` in a person — standing in for the
 * named crop step. Frame-space, the same space as the track's `bbox`.
 */
export interface RootChildBox {
  readonly stepId: string
  readonly modelId: string
  readonly score: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

export interface TrackedDetectionOut {
  readonly trackId: string
  /** Id of the frame's first-level ObjectDetection this track matched this
   *  frame — lets the overlay synthesis re-attach track state to the original
   *  root entry (bbox-object reference trick, like labelsByBbox). Absent when
   *  the tracker carried the track without a matched detection this frame. */
  readonly sourceDetectionId?: string
  readonly className: string
  readonly confidence: number
  readonly bbox: { x: number; y: number; w: number; h: number }
  readonly zones: readonly string[]
  readonly state: TrackState
  /** True when this track matched a REAL detection this frame; false when it is
   *  COASTING (frozen/extrapolated bbox, subject not observed). Media-target
   *  selection (`buildSnapshotTargets`) MUST exclude a coasted entry from best-
   *  thumbnail / keyFrame / snapshot capture — a coasted box crops the empty
   *  scene, not the subject (media-bugs RC-3). Mirrors `TrackedDetection.
   *  matchedThisFrame` straight off the tracker output. */
  readonly matchedThisFrame: boolean
  /**
   * The boxes the ROOT model drew inside this subject on THIS frame (D730),
   * for a crop step whose root supply is effective (the runner removes the
   * rest). The detail dispatcher hands them to the step's served children
   * instead of inferring the step. Absent on a coasted frame (nothing was
   * observed) and when the root drew none.
   */
  readonly rootChildBoxes?: readonly RootChildBox[]
  /**
   * The analyzer's settled test passed on this frame but the per-device
   * `stationaryThresholdSec` has not elapsed: `state` is still `moving`, in
   * name only. The stationary evidence ledger reads this as UNDECIDED —
   * neither an agreement nor a dilution (D547). `false` on every decided
   * frame, and on a frame that is travelling.
   */
  readonly settling: boolean
  /**
   * D683/D681: past the tracker's OWN birth gate, per tracklet —
   * `ProcessorTracker` reports it as `TapeTrackOutput.confirmed`.
   */
  readonly confirmed: boolean
  /** The tiered label columns this detection's candidate resolved to, when it
   *  resolved to any (roadmap 4g). Exactly one tier's three fields, or nothing
   *  when the candidate was refused. Spread onto the track / ObjectEvent
   *  verbatim — the decision was already made, once, by the write rule. */
  readonly labelPatch?: TieredLabelPatch
  /** Inherited arcface face embedding (Phase 0) for this tracked person, when
   *  present. Surfaced for the FaceRecognizer; mirrors `label` via the bbox map. */
  readonly embedding?: readonly number[]
  readonly embeddingModelId?: string
  /** Tight bbox of the `face` detail detection whose embedding was inherited
   *  onto this person track (pixel-space, same frame). Lets the FaceRecognizer
   *  crop the actual FACE, not the whole person box. Present iff a `face` detail
   *  with this person as `parentId` existed in the frame. */
  readonly faceBbox?: { x: number; y: number; w: number; h: number }
  /** Face short side (px) measured at NATIVE scale by the runner, when
   *  available. `faceBbox` is detection-frame px (≈6× smaller on a 4K cam) —
   *  min-face-size gates prefer this measure (2026-07-22 native-gate fix). */
  readonly nativeFaceShortSidePx?: number
  /** The EXACT landmark-aligned crop (base64 JPEG) the face-embedding step fed to
   *  ArcFace for the `face` detail whose embedding was inherited onto this track —
   *  i.e. the literal model input the `embedding` was computed from. Present iff
   *  that face detail carried one (aligned path, ≥5 landmarks). Lets the
   *  FaceRecognizer persist the true embedded crop (1:1 with the vector) as the
   *  gallery image instead of a separately captured natural crop. */
  readonly faceAlignedCrop?: string
  /** The five landmarks of that face detail, in FRAME space, when the runner
   *  sent them (D644). Carried to the source frame the face row keeps. */
  readonly faceLandmarks?: readonly { readonly x: number; readonly y: number }[]
  /** Recognized plate OCR text on a `plate` detail whose parent is THIS track
   *  (vehicle). The PlateRecognizer holds the best read per track. Present iff a
   *  `plate` detail with a non-empty OCR label existed for this parent. */
  readonly plateText?: string
  /** OCR confidence of `plateText`. */
  readonly plateScore?: number
  /** Tight bbox of the `plate` detail (pixel-space, same frame) — lets the
   *  PlateRecognizer crop the actual PLATE, not the whole vehicle box. */
  readonly plateBbox?: { x: number; y: number; w: number; h: number }
  /**
   * What a NATIVE-resolution second pass measured about the box this track
   * matched THIS frame (D377). Carried straight off the detection through the
   * bbox-object reference, like `embedding` and `plateText`; absent on a
   * coasting frame and on every box the full-frame pass produced.
   *
   * The confirmation gate reads it: a birth whose box was already re-measured
   * at native resolution, above the gate's own bar, has been confirmed by the
   * measurement that saw it — cutting a third, tighter crop can only lose the
   * subject.
   */
  readonly nativeRecovery?: NativeRecoveryEvidence
  /**
   * The pixels this box was measured on, cut by the runner at the instant of
   * detection and carried here with the detection (D379).
   *
   * Same rule as `nativeRecovery` above: mirrored only when the track MATCHED a
   * real detection this frame, because a coasting box carries a rectangle from
   * a frame that is over and no crop of it exists.
   */
  readonly birthEvidence?: BirthEvidence
}

/** One frame handed to {@link FrameProcessor.process}. */
export interface FrameProcessInput {
  readonly timestamp: number
  readonly frame: FrameResult
  readonly observe?: boolean
}

export interface FrameProcessorResult {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly tracked: readonly TrackedDetectionOut[]
  /**
   * DRAFTS, not events (D474): an event id is the rowid the insert assigns, so
   * the frame path — which runs before any write — has no id to give. The addon
   * inserts each draft and composes the `ObjectEvent` from what came back.
   */
  readonly objectEvents: readonly ObjectEventDraft[]
  /**
   * Synthetic APPEARANCE events (Requirement 1) — one per track, emitted the
   * first time it passes the age gate without a crop-bearing transition, so
   * every subject's passage is valued with a real current-frame crop +
   * bestEventId. Kept SEPARATE from `objectEvents` because the addon persists
   * them + captures their media but does NOT surface them on the notification
   * bus (they must never change notification volume).
   */
  readonly appearanceEvents: readonly ObjectEventDraft[]
  /** Raw TrackedDetection array — consumed by TrackStore for position
   *  history updates. Kept separate from `tracked` which is the
   *  lightweight shape consumed by the bus emit. */
  readonly rawTrackedDetections: readonly TrackedDetection[]
  /** Stationary-registry entries a detection confirmed present this frame
   *  (their spawn was suppressed). The addon counts them toward frame
   *  occupancy and advances their `lastConfirmedAt`. */
  readonly stationaryConfirmed: readonly StationaryConfirmation[]
  /** Stationary-registry entries whose object really LEFT this frame → the
   *  addon retires them (object departed) and lets the detection track
   *  normally. Each carries the cause and the separation the confirmation
   *  rested on (D279). */
  readonly stationaryWoken: readonly StationaryWake[]
  /** Weak stationary holds a CONFIRMED track consumed this frame (D410) — the
   *  moving car passing a parked one keeping its id. The addon folds it into
   *  the registry's sweep line beside the count of holds handed on. */
  readonly stationaryContinued: number
  /**
   * Riders folded into their machine this frame — see {@link RiderFold}. The
   * addon stamps `Track.hasRider` on each resolved `trackId` and logs the rest.
   * Empty on the overwhelming majority of frames.
   */
  readonly riderFolds: readonly RiderFold[]
  /** Present only when `process` was called with `observe: true` (D681). */
  readonly observation?: FrameObservation
  /**
   * D683: L2 decisions committed on this frame, already applied to this
   * processor's own per-track state; the addon hands them to its fusion step
   * (`applyTrackFusions`, D683 Task 18) for everything else. Empty on almost
   * every frame.
   */
  readonly fusions: readonly TrackFusion[]
  /**
   * The tracker dropped this frame as out of order (follow-up 102, F1 fix round
   * 3): it was decided before anything else read it, and nothing did — no
   * stationary gate, zones, events or tracked detections. The addon stops at
   * the tape record for it; `timestamp` is the frame's own, stale, time.
   */
  readonly droppedOutOfOrder?: true
}

/** The tape observation of a dropped frame: no gate verdict, nothing bound. */
const DROPPED_FRAME_OBSERVATION: FrameObservation = {
  gate: { strong: [], weak: [], confirmed: [], woken: [] },
  live: [],
}

/** Mapping from StateAnalyzer's `ObjectState.state` values to the
 *  canonical TrackState enum used on tracks + events. */
function mapObjectStateToTrackState(s: string | undefined): TrackState {
  switch (s) {
    case 'entering':
      return 'entered'
    case 'leaving':
      return 'left'
    case 'stationary':
    case 'loitering':
      return 'idle'
    case 'moving':
      return 'moving'
    default:
      return 'new'
  }
}

/**
 * How long an identical refusal stays collapsed. A stationary subject is
 * refused on every analysed frame; at ~2 fps of analysis, 60 s turns a parked
 * car's 120 lines into one and still reports a subject that comes back later.
 */
const ZONE_REFUSAL_THROTTLE_MS = 60_000
/** Box quantisation for the collapse key: a subject that moves less than this
 *  is the same sighting for diagnostic purposes. */
const ZONE_REFUSAL_BOX_CELL_PX = 64
/** Bound on the collapse map; stale keys are swept when it is exceeded. */
const ZONE_REFUSAL_KEY_LIMIT = 512

/** One zone a refused detection fell inside, and how far in. */
export interface ZoneRefusalZone {
  readonly zoneId: string
  readonly zoneName?: string
  readonly overlapPct: number
}

/**
 * A detection the tracker refused that fell inside a watched zone. This is
 * DIAGNOSTIC evidence — it never becomes an `ObjectEvent`, so no rule can
 * alert on it (D426).
 */
export interface ZoneRefusalObservation {
  readonly deviceId: number
  readonly timestamp: number
  readonly className: string
  readonly confidence: number
  readonly bbox: BoundingBox
  readonly reason: SpawnRefusalReason
  readonly zones: readonly ZoneRefusalZone[]
  /** Total refusals-in-zone seen on this processor, BEFORE throttling. */
  readonly seenSoFar: number
}

export type ZoneRefusalObserver = (observation: ZoneRefusalObservation) => void

/**
 * A track that was born already carrying a zone its pre-confirmation
 * measurements crossed. `zonesAtBirth` is what the birth FRAME alone saw;
 * `inheritedZones` is what the withheld measurements added (D430).
 */
export interface BirthZoneTrail {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  readonly measurementsBeforeBirth: number
  readonly zonesAtBirth: readonly string[]
  readonly inheritedZones: readonly string[]
}

export type BirthZoneTrailObserver = (trail: BirthZoneTrail) => void

export class FrameProcessor {
  readonly deviceId: number
  /** Detection source this processor handles (`pipeline` | `onboard`).
   *  Stamped onto every emitted ObjectEvent so downstream consumers can
   *  select by source. One FrameProcessor instance per (deviceId, source)
   *  keeps tracking/state fully isolated between sources. */
  readonly source: DetectionSource
  /** D683 review N5: this processor's own configured coast bound — the
   *  TrackStore's force-close bound must never be shorter than the length
   *  of silence L2 itself is willing to carry a chain through. */
  readonly maxMissedMs: number
  private readonly tracker: TrackerV2
  /** Where the addon's split / link / ended streams go (see {@link setTrackerObservers}). */
  private trackerObservers: TrackerV2Observers = {}
  private stats = emptyStats()
  /** Samples the tracker's refusals for the LOG; the frame path takes them all. */
  private readonly trackerRefusalSampler = new SpawnRefusalSampler()
  /** The processor's own clock (review M2): the last frame's capture time and
   *  the wall time it arrived. */
  private lastFrameT: number | null = null
  private lastFrameWallAt = 0
  private readonly wallClock: () => number
  private readonly stateAnalyzer: StateAnalyzer
  private readonly eventEmitter: DetectionEventEmitter
  private zones: readonly Zone[]
  /**
   * Detection-stage rules — applied as a safety-net post-pipeline
   * filter. When motion-wasm + pipeline-executor land their own
   * runtime gating (Phase 2b) the upstream pipeline already drops
   * filtered detections; keeping the analytics-side filter as well
   * ensures the same semantics for legacy paths and forked-worker
   * runners that haven't picked up the new gating yet.
   */
  private detectionRules: readonly ZoneRule[]
  /** See {@link setZoneMembershipMinOverlap}. 0 = any positive overlap. */
  private zoneMembershipMinOverlap: number
  /** See {@link setLowScoreContinuationFloor}. `null` = tier off. */
  private lowScoreFloor: number | null = LOW_SCORE_CONTINUATION_FLOOR_DEFAULT
  /** See {@link getLastZoneOverlaps}. */
  private lastZoneOverlaps: ReadonlyMap<string, readonly DetectionZoneMembership[]>
  /** See {@link getLastZoneRejections}. */
  private lastZoneRejections: ReadonlyMap<string, readonly DetectionZoneMembership[]>
  /** Zone crossings per track — the producer of `zone.enter` / `zone.exit`. */
  private readonly zoneTransitions = new ZoneTransitionTracker()
  /**
   * Tripwire crossings. Separate from `zoneTransitions` because a tripwire is
   * a DIRECTED line, not an area: membership is meaningless and the question is
   * which way the subject went over it.
   */
  private readonly tripwires = new TripwireTracker()

  /**
   * Last detection seen per track. An edge exit fires for a track that is
   * ABSENT from the frame, so there is no current detection to attach — this is
   * the one the subject had when it was last seen. Cleared with the rest of the
   * per-track caches when the track leaves.
   */
  private readonly lastDetectionByTrack = new Map<string, TrackedDetection>()
  /**
   * Last zone membership seen per track, so an event for a track that is GONE
   * this frame still carries the zones it was in. See the use site.
   */
  private readonly lastZonesByTrack = new Map<string, readonly string[]>()
  /** See {@link getLastLabelWriteRefusals}. */
  private lastLabelWriteRefusals: readonly LabelWriteRefusalInfo[] = []
  /**
   * Coarse token already reported per track. A track that keeps matching an
   * animal detection refuses the same candidate on every frame; reporting each
   * one would bury the signal under its own repetition. Cleared with the rest
   * of the per-track caches when the track leaves.
   */
  private readonly reportedRefusalByTrack = new Map<string, string>()
  private readonly zoneEngine = new ZoneEngine()
  /** Sink + sampler for the drops this stage owns (the detection-stage zone
   *  filter). Shares the tracker's vocabulary — see {@link SpawnRefusalReason}. */
  private spawnRefusalObserver: SpawnRefusalObserver | null = null
  /** Where a collected refusal is forwarded for LOGGING, when anyone asked. */
  /**
   * The spawn refusals of the frame being processed.
   *
   * Filled by the same sink that feeds the diagnostic log, and drained at the
   * end of `process`. It exists because a refused detection inside a watched
   * zone still has to become an EVENT: an immediate zone rule asks "is there an
   * animal in the flowerbed now?", which does not need "is it the same animal
   * as before?" answered first. See `zone-detection-emits-without-a-track`.
   */
  private refusalsThisFrame: SpawnRefusalFacts[] = []
  /** Running count of refusals-in-zone SEEN — never the throttled number. */
  private zoneRefusalEventCount = 0
  /** Faces refused because their centre was not in the body they were found
   *  for — the padding reaching into a neighbour. See
   *  `face-parent-containment.ts`. */
  private faceOutsideParentCount = 0
  private zoneRefusalObserver: ZoneRefusalObserver | null = null
  /** Track ids whose BIRTH zone history has already been folded in — the fold
   *  happens once, on the frame a track first becomes visible. */
  private readonly birthZonesSeeded = new Set<string>()
  private birthZoneTrailObserver: BirthZoneTrailObserver | null = null
  /** Last report time per collapsed key, for {@link ZONE_REFUSAL_THROTTLE_MS}. */
  private readonly zoneRefusalLastReport = new Map<string, number>()
  private readonly zoneRefusalSampler = new SpawnRefusalSampler()
  /** Optional stationary-object gate (parked-object suppression). Null until
   *  the addon wires it via {@link setStationaryGate}. */
  private stationaryGate: StationaryFrameGate | null = null
  /**
   * The label the TRACK currently carries, read (never mirrored) from the
   * active-track cache. See {@link setTrackLabelState} — and the use site in
   * `toObjectEvent`, which is the reason it exists.
   */
  private trackLabelState: ((trackId: string) => TieredLabelState | undefined) | null = null

  constructor(
    deviceId: number,
    trackerConfig: Partial<TrackerV2Config> = {},
    stateConfig: Partial<StateAnalyzerConfig> = {},
    emitterConfig: Partial<EventEmitterConfig> = {},
    source: DetectionSource = 'pipeline',
    deps: FrameProcessorDeps = {},
  ) {
    this.deviceId = deviceId
    this.source = source
    this.wallClock = deps.wallClock ?? ((): number => Date.now())
    const resolvedTrackerConfig = { ...DEFAULT_TRACKER_V2_CONFIG, ...trackerConfig }
    this.maxMissedMs = resolvedTrackerConfig.maxMissedMs
    this.tracker = new TrackerV2(resolvedTrackerConfig, {
      mintTrackId: deps.mintTrackId ?? newTrackId,
      // Installed ONCE: the refusals feed the frame path unsampled (zone
      // refusal events) and the log sampled; the other streams go to
      // whatever the addon wired, and to the per-minute stats.
      observers: {
        refusal: (f) => {
          this.refusalsThisFrame.push(f)
          const n = this.trackerRefusalSampler.next(f.reason)
          if (n !== undefined) {
            this.spawnRefusalObserver?.({
              ...f,
              refusalCount: n,
              sampledEvery: SPAWN_REFUSAL_LOG_SAMPLE_EVERY,
            })
          }
        },
        ended: (f) => {
          const counts = f.confirmed
            ? this.stats.tracklets.confirmed
            : this.stats.tracklets.unconfirmed
          const next = { ...counts, [f.reason]: counts[f.reason] + 1 }
          this.stats.tracklets = f.confirmed
            ? { ...this.stats.tracklets, confirmed: next }
            : { ...this.stats.tracklets, unconfirmed: next }
          this.trackerObservers.ended?.(f)
        },
        split: (f) => {
          this.stats.splits += 1
          this.trackerObservers.split?.(f)
        },
        link: (f) => {
          if (f.kind === 'committed') this.stats.linksCommitted += 1
          else if (f.kind === 'refused') this.stats.linksRefused += 1
          else if (f.kind === 'new') this.stats.linksNew += 1
          else if (f.kind === 'disagreed') this.stats.linksDisagreed += 1
          this.trackerObservers.link?.(f)
        },
        outOfOrder: (f) => {
          this.stats.outOfOrderFrames += 1
          this.trackerObservers.outOfOrder?.(f)
        },
        clockStep: (f) => {
          this.stats.clockSteps += 1
          this.trackerObservers.clockStep?.(f)
        },
      },
    })
    this.stateAnalyzer = new StateAnalyzer(stateConfig)
    this.eventEmitter = new DetectionEventEmitter(emitterConfig)
    this.zones = []
    this.detectionRules = []
    this.zoneMembershipMinOverlap = 0
    this.lastZoneOverlaps = new Map()
    this.lastZoneRejections = new Map()
  }

  setZones(zones: readonly Zone[]): void {
    this.zones = zones
  }

  /**
   * Wire the reader that answers "what does this track already say it is".
   *
   * A READ, not a mirror the late-label path has to remember to feed: the
   * active-track cache is in-RAM and already the authority every other surface
   * resolves against, and a mirror that can be forgotten is how a stamped row
   * and an unstamped one end up in the same track. Absent (tests, and any
   * caller that has not wired it) ⇒ the emitter behaves exactly as it did
   * before, stamping only what the current frame decided.
   */
  setTrackLabelState(read: (trackId: string) => TieredLabelState | undefined): void {
    this.trackLabelState = read
  }

  /**
   * How much of a detection's box must lie inside a zone for the zone to be
   * stamped onto it (0–1 fraction of the box's own area).
   *
   * DEFAULT 0 — byte-identical to the behaviour before 2026-07-31, where any
   * positive overlap counted. Raising it is an operator decision and needs
   * evidence: a bar set blind removes notifications silently, which is the
   * failure mode this whole area keeps producing. {@link lastZoneOverlaps}
   * exists so the distribution can be read before a number is picked.
   */
  /**
   * The score at or above which a box the operator's class floor dropped is
   * handed to the tracker as low-score continuation evidence (D665); `null`
   * turns the tier off for this camera. Pushed per frame, like the zones.
   */
  setLowScoreContinuationFloor(floor: number | null): void {
    this.lowScoreFloor =
      floor !== null && Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : null
  }

  setZoneMembershipMinOverlap(minOverlap: number): void {
    this.zoneMembershipMinOverlap =
      Number.isFinite(minOverlap) && minOverlap >= 0 && minOverlap <= 1 ? minOverlap : 0
  }

  /**
   * Label candidates the write rule refused on the most recent frame (see
   * `resolveTieredLabelWrite` in `label-tier.ts`).
   *
   * Reported for the same reason a {@link RiderFold} is: the branch DROPS
   * a value, and a drop nobody logs reads as "it never happened". The five live
   * rows that produced the macro-class rule were found by reading the rows, a
   * week after the fact. Deduped per (track, token) so a track that keeps
   * re-offering the same wrong candidate is one line, not one per frame.
   */
  getLastLabelWriteRefusals(): readonly LabelWriteRefusalInfo[] {
    return this.lastLabelWriteRefusals
  }

  /** Per-track zone memberships WITH their overlap fractions, from the most
   *  recent frame. The engine computes these and the pipeline previously
   *  discarded everything but the ids — which is why no amount of production
   *  data could say how far inside the zone a notifying subject actually was. */
  getLastZoneOverlaps(): ReadonlyMap<string, readonly DetectionZoneMembership[]> {
    return this.lastZoneOverlaps
  }

  /** Per-track zones the membership bar REJECTED (0 < overlap ≤ the bar), from
   *  the most recent frame. Raising the bar otherwise makes the stamping log go
   *  quiet for exactly the cases it was armed to measure — see
   *  `ZoneMembershipSplit` in `zones/zone-engine.ts`. */
  getLastZoneRejections(): ReadonlyMap<string, readonly DetectionZoneMembership[]> {
    return this.lastZoneRejections
  }

  setDetectionRules(rules: readonly ZoneRule[]): void {
    this.detectionRules = rules
  }

  /** Wire (or clear) the stationary-object gate. Called by the addon per
   *  device so parked-object suppression applies from the next frame. */
  setStationaryGate(gate: StationaryFrameGate | null): void {
    this.stationaryGate = gate
  }

  /**
   * Wire (or clear) the tracker's spawn-refusal diagnostics sink (D391) — a
   * detection that reached the tracker and produced no track at all. The
   * tracker itself knows no `deviceId`; the addon that owns this processor
   * stamps `tags: { deviceId }` on the line — see the wiring in
   * `pipeline-analytics`. Reports sampled: the tracker runs per track per
   * frame at frame-rate.
   */
  setSpawnRefusalObserver(observer: SpawnRefusalObserver | null): void {
    // The LOG's sampled channel, for the tracker's refusals (sampled in the
    // constructor's observer) and this stage's own. The event path has its
    // own, unsampled collection, installed in the constructor — because a
    // product path that works only while someone is watching the logs is the
    // shape of defect this repo keeps paying for.
    //
    // The zone filter runs HERE, before the tracker, and it is the earliest
    // branch on the path that can end a detection's life. It shares the sink
    // and the vocabulary so an operator asks one question, not two (D391).
    this.spawnRefusalObserver = observer
  }

  /**
   * Where a refused-inside-a-zone detection goes. Diagnostics only: this is
   * deliberately NOT the event stream, so nothing downstream can alert on a
   * box the confirmation gate threw away (D426).
   */
  setZoneRefusalObserver(observer: ZoneRefusalObserver | null): void {
    this.zoneRefusalObserver = observer
  }

  /** Where "this track was born already carrying a zone" is reported. */
  setBirthZoneTrailObserver(observer: BirthZoneTrailObserver | null): void {
    this.birthZoneTrailObserver = observer
  }

  /**
   * Where tracker v2's split / link / ended facts go (D683). The tracker knows
   * no `deviceId`; the addon that owns this processor stamps `tags: { deviceId }`
   * on every line. The refusal stream is NOT here: it is the spawn-refusal
   * observer's, sampled, like before.
   */
  setTrackerObservers(observers: TrackerV2Observers): void {
    this.trackerObservers = observers
  }

  /** What the tracker did since the last drain — the per-minute summary line. */
  drainTrackerStats(): TrackerV2Stats {
    const out = this.stats
    this.stats = emptyStats()
    return out
  }

  /**
   * Frame time "now", for a camera whose frames may have stopped: the last
   * frame's capture time plus the wall time since it ARRIVED. L2 state is in
   * capture time (stamped by the runner, possibly on an agent, and processed
   * after pipeline latency), so the hub's `Date.now()` would judge "every
   * competitor has started" ahead of frames still queued (review M2).
   * `null` before the first frame.
   */
  frameNow(wallNow: number): number | null {
    return this.lastFrameT === null
      ? null
      : this.lastFrameT + Math.max(0, wallNow - this.lastFrameWallAt)
  }

  /** The close sweep's entry (review C2): silence ends tracklets and commits fusions. */
  advanceBySilence(wallNow: number): readonly TrackFusion[] {
    const now = this.frameNow(wallNow)
    return now === null ? [] : this.advanceTo(now)
  }

  /** Replay's entry (`ProcessorTracker.finish`): advance to a frame time. Fusions
   *  returned here have already been applied to this processor's per-track state. */
  advanceTo(frameT: number): readonly TrackFusion[] {
    this.tracker.advance(frameT)
    const fusions = this.tracker.drainFusions()
    this.applyFusions(fusions)
    return fusions
  }

  /** A chain is live while any of its pieces is a live tracklet (§4.5). */
  isLive(trackId: string): boolean {
    return this.tracker.isLive(trackId)
  }

  /** `frameT` is FRAME time — use `frameNow(wallNow)` from a wall-clock caller. */
  isTailFinal(trackId: string, frameT: number): boolean {
    return this.tracker.isTailFinal(trackId, frameT)
  }

  /** The FaceRecognizer settled this track's identity, or retracted it (`null`)
   *  — review C3. Replay feeds D681's per-track identity record here. */
  noteTrackIdentity(trackId: string, identity: string | null): void {
    this.tracker.noteIdentity(trackId, identity)
  }

  /** The confirmation gate refused this birth (review H3): it never becomes a link end. */
  markSuppressed(trackId: string): void {
    this.tracker.markSuppressed(trackId)
  }

  /**
   * End a track's chain in the tracker. `dropped` (default): the processor's
   * own drop, never linked. `stationary`: the registry promoted a subject that
   * moved — a later piece may still be linked to it (D683 round 4, Task 14).
   */
  dropTrack(trackId: string, reason: TrackDropReason = 'dropped'): void {
    this.tracker.dropTrack(trackId, reason)
  }

  /** The L2 chain root of a track id — two ids with one root are one subject. */
  rootOf(trackId: string): string {
    return this.tracker.rootOf(trackId)
  }

  /** Move every per-track cache from each absorbed member to its survivor. */
  private applyFusions(fusions: readonly TrackFusion[]): void {
    for (const f of fusions) {
      for (const m of f.members) {
        if (m === f.survivorId) continue
        this.stateAnalyzer.rename(m, f.survivorId)
        this.eventEmitter.rename(m, f.survivorId)
        this.zoneTransitions.rename(m, f.survivorId)
        this.tripwires.rename(m, f.survivorId)
        renameKey(this.lastDetectionByTrack, m, f.survivorId)
        renameKey(this.lastZonesByTrack, m, f.survivorId)
        renameKey(this.reportedRefusalByTrack, m, f.survivorId)
        renameMember(this.birthZonesSeeded, m, f.survivorId)
      }
    }
  }

  /**
   * Say which detections a detection-stage zone rule excluded (D391).
   *
   * `filterDetections` has always ANSWERED this — it returns `excluded` — and
   * this stage dropped the answer on the floor, so a camera whose subject the
   * rules exclude was indistinguishable in the log from a camera whose tracker
   * ate it. Sampled like every other refusal: an excluded box is excluded on
   * every frame of a passage.
   */
  /**
   * Turn this frame's refused spawns into events, but only those inside a zone.
   *
   * Drains {@link refusalsThisFrame}. Each surviving record becomes an
   * `object.detected` event with NO track — carrying the zones it fell in, the
   * percentage of the box inside each, and the refusal reason so a consumer can
   * tell it apart from a track whose media went missing.
   *
   * `zone-filtered` refusals are excluded on purpose: that reason means the
   * operator's own detection rules already said the box does not count on this
   * camera, and re-admitting it here would overrule a decision they made.
   */
  /**
   * Report every detection the tracker refused that fell INSIDE a watched
   * zone. Diagnostics only — see the spec
   * `zone-refusal-is-observed-never-notified` for the ten hours of production
   * that decided this: 1473 of 1511 such refusals were one stationary parcel
   * re-offered every frame, and both notifications this path ever produced
   * were phantoms the confirmation gate had correctly rejected.
   *
   * Drains {@link refusalsThisFrame}. `zone-filtered` is skipped: a box the
   * zone filter already removed was never in a zone.
   */
  private reportRefusedDetectionsInZones(
    timestamp: number,
    frameWidth: number,
    frameHeight: number,
  ): void {
    const refusals = this.refusalsThisFrame
    this.refusalsThisFrame = []
    if (refusals.length === 0 || this.zones.length === 0) return
    const observer = this.zoneRefusalObserver
    if (observer === null) return

    for (const r of refusals) {
      if (r.reason === 'zone-filtered') continue
      const { memberships } = this.zoneEngine.splitDetectionZones(
        r.bbox,
        this.zones,
        frameWidth,
        frameHeight,
        undefined,
        undefined,
        undefined,
        this.zoneMembershipMinOverlap,
      )
      if (memberships.length === 0) continue
      // Counted BEFORE the throttle: the volume measure must describe what
      // happened, not what survived the collapse.
      this.zoneRefusalEventCount += 1
      if (!this.shouldReportZoneRefusal(r, memberships, timestamp)) continue
      observer({
        deviceId: this.deviceId,
        timestamp,
        className: r.detClass,
        confidence: r.detScore,
        bbox: r.bbox,
        reason: r.reason,
        zones: memberships.map((m) => ({
          zoneId: m.zoneId,
          ...(m.zoneName === undefined ? {} : { zoneName: m.zoneName }),
          overlapPct: Math.round(m.overlap * 1000) / 10,
        })),
        seenSoFar: this.zoneRefusalEventCount,
      })
    }
  }

  /**
   * Collapse identical refusals. A refused box is refused on EVERY analysed
   * frame, so a subject that does not leave — the parcel at the door, the
   * parked car — is an unbounded emitter. The key includes a coarse box, so a
   * subject that actually moves keeps reporting while a stationary one does
   * not.
   */
  private shouldReportZoneRefusal(
    r: SpawnRefusalFacts,
    memberships: readonly DetectionZoneMembership[],
    timestamp: number,
  ): boolean {
    const cell = (v: number): number => Math.round(v / ZONE_REFUSAL_BOX_CELL_PX)
    const key = [
      r.detClass,
      r.reason,
      memberships.map((m) => m.zoneId).join('+'),
      cell(r.bbox.x),
      cell(r.bbox.y),
      cell(r.bbox.w),
      cell(r.bbox.h),
    ].join('|')
    const last = this.zoneRefusalLastReport.get(key)
    if (last !== undefined && timestamp - last < ZONE_REFUSAL_THROTTLE_MS) return false
    this.zoneRefusalLastReport.set(key, timestamp)
    if (this.zoneRefusalLastReport.size > ZONE_REFUSAL_KEY_LIMIT) {
      for (const [k, t] of this.zoneRefusalLastReport) {
        if (timestamp - t >= ZONE_REFUSAL_THROTTLE_MS) this.zoneRefusalLastReport.delete(k)
      }
    }
    return true
  }

  /** How many refusals-in-zone this processor has SEEN — the measure that says
   *  whether this path is a trickle or a storm, before any throttling. */
  zoneRefusalEventsEmitted(): number {
    return this.zoneRefusalEventCount
  }

  /** How many faces this processor refused for belonging to somebody else.
   *  Zero is the expected reading; a rising one means two people stand close
   *  together on this camera, which is worth knowing per-camera rather than
   *  per-fleet. */
  /**
   * A frame `classifyFrame` called out of order: the tracker records the drop
   * (and any clock-step run it extends) and nothing else reads the frame. The
   * per-frame side tables a reader asks for afterwards are emptied, so it never
   * re-reads the previous frame's.
   */
  private droppedFrame(input: FrameProcessInput): FrameProcessorResult {
    this.tracker.drop(input.timestamp, input.frame.detections.length)
    this.lastZoneOverlaps = new Map()
    this.lastZoneRejections = new Map()
    this.lastLabelWriteRefusals = []
    const fusions = this.tracker.drainFusions()
    this.applyFusions(fusions)
    return {
      deviceId: this.deviceId,
      timestamp: input.timestamp,
      frameWidth: input.frame.width,
      frameHeight: input.frame.height,
      tracked: [],
      objectEvents: [],
      appearanceEvents: [],
      rawTrackedDetections: [],
      stationaryConfirmed: [],
      stationaryWoken: [],
      stationaryContinued: 0,
      riderFolds: [],
      ...(input.observe === true ? { observation: DROPPED_FRAME_OBSERVATION } : {}),
      fusions,
      droppedOutOfOrder: true,
    }
  }

  facesRefusedOutsideParent(): number {
    return this.faceOutsideParentCount
  }

  private reportZoneFiltered(excluded: readonly FlatDetection[]): void {
    const observer = this.spawnRefusalObserver
    if (!observer || excluded.length === 0) return
    for (const fd of excluded) {
      const refusalCount = this.zoneRefusalSampler.next('zone-filtered')
      if (refusalCount === undefined) continue
      observer({
        reason: 'zone-filtered',
        detClass: fd.detection.class,
        detScore: fd.detection.score,
        bbox: fd.detection.bbox,
        ...(fd.detection.nativeRecovery !== undefined
          ? { nativeRecoveryScore: fd.detection.nativeRecovery.score }
          : {}),
        refusalCount,
        sampledEvery: SPAWN_REFUSAL_LOG_SAMPLE_EVERY,
      })
    }
  }

  process(input: FrameProcessInput): FrameProcessorResult {
    const { timestamp, frame } = input
    // Frame order is decided FIRST (follow-up 102, fix round 3, MEDIUM-2): a
    // frame the tracker drops never reaches the stationary gate (whose
    // persisted `lastConfirmedAt` it rewound by up to 4 s), the zones, the
    // events or the result's consumers.
    if (this.tracker.classifyFrame(timestamp) === 'out-of-order') return this.droppedFrame(input)
    // The processor's own clock (review M2): what `frameNow` extrapolates from.
    // A taken frame — in order, or a clock step (rebased) — sets it.
    this.lastFrameT = timestamp
    this.lastFrameWallAt = this.wallClock()
    const frameWidth = frame.width
    const frameHeight = frame.height

    // Sub-detector enrichment labels (identity from face-embedding, plate-text
    // from plate-ocr) live on `det.labels` but are dropped by the flatten +
    // tracker (SpatialDetection carries no labels). Keep a frame-local map keyed
    // by the bbox object — the tracker preserves that reference through match
    // and spawn, so a tracked detection's `bbox` resolves back to its labels.
    const labelsByBbox = new Map<BoundingBox, readonly ScoredLabel[]>()
    // The macro class of the detection that OWNS each bbox object. The tracked
    // emission's `class` is the tracklet's VOTED class, which a weak
    // person/animal read can disagree with while still binding to it; the
    // labels on that bbox were computed for the detection's class, not the
    // track's (a `dog` link on a person track, 2026-10-13).
    const detectionClassByBbox = new Map<BoundingBox, string>()
    // The tier the ROOT step declared for its raw class (`debug.originalClass`),
    // keyed by the same bbox object. `SpatialDetection` carries the raw class
    // but no tier, and the tier must NOT be re-derived here — see
    // `DetectionDebug.originalClassTier`.
    const originalClassTierByBbox = new Map<BoundingBox, LabelTier>()
    const embeddingByBbox = new Map<
      BoundingBox,
      { embedding: readonly number[]; embeddingModelId?: string }
    >()
    // First-level detection id → its bbox OBJECT (the tracker preserves this
    // reference, like `labelsByBbox`/`embeddingByBbox`). Used to map a `face`
    // detail's `parentId` back to its person bbox so the FaceRecognizer can crop
    // the actual face instead of the whole person box.
    const firstLevelBboxById = new Map<string, BoundingBox>()
    // Inverse of `firstLevelBboxById` — the bbox object preserved through
    // match/spawn resolves back to the id of the first-level ObjectDetection
    // it came from, so the tracked output can stamp `sourceDetectionId`.
    const sourceIdByBbox = new Map<BoundingBox, string>()
    const faceBboxByBbox = new Map<BoundingBox, { x: number; y: number; w: number; h: number }>()
    // Native-scale face short side (px), same parent-bbox keying — preferred by
    // the min-face gates over the detection-space faceBbox (2026-07-22).
    const nativeFaceSizeByBbox = new Map<BoundingBox, number>()
    // The exact ArcFace-input aligned crop (base64 JPEG) of the `face` detail,
    // indexed by the SAME parent bbox object as `faceBboxByBbox` so it surfaces on
    // the tracked person alongside its inherited embedding + faceBbox.
    const faceAlignedCropByBbox = new Map<BoundingBox, string>()
    // Plate OCR read indexed by parent (vehicle) bbox object — same reference
    // trick as faceBbox: the tracker preserves the parent bbox object through
    // match/spawn, so a tracked vehicle resolves back to its plate read.
    const plateByBbox = new Map<
      BoundingBox,
      { text: string; score: number; bbox: { x: number; y: number; w: number; h: number } }
    >()
    const maskByBbox = new Map<BoundingBox, { mask: Uint8Array; width: number; height: number }>()
    // What a native-resolution second pass measured about a box, same
    // bbox-object keying as the maps above (D377). Read by the confirmation
    // gate through `TrackedDetectionOut.nativeRecovery`.
    const nativeRecoveryByBbox = new Map<BoundingBox, NativeRecoveryEvidence>()
    // The box's OWN pixels, cut at detection time and carried here (D379).
    // Same bbox-object keying; read by the confirmation gate through
    // `TrackedDetectionOut.birthEvidence`.
    const birthEvidenceByBbox = new Map<BoundingBox, BirthEvidence>()
    // First-level box OBJECTS with a face detail inside (D683 §4.4): the
    // tracker makes the piece face-bearing, and L2 waits for the recognizer's
    // verdict before it links one.
    const faceBearingBoxes = new Set<BoundingBox>()
    // Root-drawn child boxes per first-level box object (D730).
    const rootChildBoxesByBbox = new Map<BoundingBox, readonly RootChildBox[]>()

    // 1. Flatten first-level detections
    const flatDetections: FlatDetection[] = frame.detections
      .filter((d) => d.kind === 'first-level')
      .map((det) => {
        const bbox: BoundingBox = {
          x: det.bbox.x,
          y: det.bbox.y,
          w: det.bbox.width,
          h: det.bbox.height,
        }
        const detection: SpatialDetection = {
          class: det.macroClass,
          originalClass: det.debug?.originalClass ?? det.macroClass,
          score: det.score,
          bbox,
          // The tracker's SPAWN gates need this, not just the gate downstream:
          // a per-class floor and a person-over-animal fold tuned for the
          // coarse pass must not eat a box measured at native resolution.
          ...(det.nativeRecovery !== undefined ? { nativeRecovery: det.nativeRecovery } : {}),
          // D683: the runner's model-free descriptor rides into the tracker.
          ...(det.appearance !== undefined ? { appearance: det.appearance } : {}),
        }
        if (det.nativeRecovery !== undefined) nativeRecoveryByBbox.set(bbox, det.nativeRecovery)
        if (det.birthEvidence !== undefined) birthEvidenceByBbox.set(bbox, det.birthEvidence)
        if (det.labels.length > 0) labelsByBbox.set(bbox, det.labels)
        detectionClassByBbox.set(bbox, det.macroClass)
        if (det.debug?.originalClassTier !== undefined) {
          originalClassTierByBbox.set(bbox, det.debug.originalClassTier)
        }
        if (det.embedding !== undefined) {
          embeddingByBbox.set(bbox, {
            embedding: det.embedding,
            ...(det.embeddingModelId !== undefined
              ? { embeddingModelId: det.embeddingModelId }
              : {}),
          })
        }
        if (det.mask !== undefined && det.maskWidth !== undefined && det.maskHeight !== undefined) {
          maskByBbox.set(bbox, {
            mask: Uint8Array.from(Buffer.from(det.mask, 'base64')),
            width: det.maskWidth,
            height: det.maskHeight,
          })
        }
        firstLevelBboxById.set(det.id, bbox)
        sourceIdByBbox.set(bbox, det.id)
        return { ...bbox, detection, sourceId: det.id }
      })

    // Index `face` detail bboxes by their parent person's bbox object, so the
    // tracked person can surface the tight face box (first face per person wins).
    for (const det of frame.detections) {
      if (det.kind !== 'detail' || det.macroClass !== 'face' || !det.parentId) continue
      const parentBbox = firstLevelBboxById.get(det.parentId)
      if (parentBbox === undefined || faceBboxByBbox.has(parentBbox)) continue
      // IS THIS FACE EVEN IN THIS BODY? The detector ran on the parent's crop
      // PADDED by `detailCropPaddingRatio`, so a person standing beside this
      // one is inside the picture it searched. Measured on device 107
      // (2026-09-16): an adult looking down got the child's face bound to him,
      // cut exactly on the padding's top edge — his thumbnail, her identity.
      const face = { x: det.bbox.x, y: det.bbox.y, w: det.bbox.width, h: det.bbox.height }
      if (!faceIsInsideParent(face, parentBbox)) {
        // COUNTED, because a branch that drops work in silence reads as work
        // that never arrived — and this one decides whose name goes on a
        // track. This class has no logger (it runs per frame, on the hot
        // path); it has counters, and the caller reads them.
        this.faceOutsideParentCount += 1
        continue
      }
      // ANY face detail inside its parent (review 2 NH1): the runner's own face
      // floor already applied, and no pixel floor here — the recognizer's 48 px
      // floor is native pixels, while a detection-frame face on this hub is
      // 16.5–28.2 px. The tape carries face details with their parent, so
      // replay decides exactly as live did.
      faceBearingBoxes.add(parentBbox)
      faceBboxByBbox.set(parentBbox, {
        x: det.bbox.x,
        y: det.bbox.y,
        w: det.bbox.width,
        h: det.bbox.height,
      })
      // Carry the exact ArcFace input for this face onto the same parent, so the
      // FaceRecognizer can persist the true embedded crop as the gallery image.
      if (det.faceAlignedCrop !== undefined) {
        faceAlignedCropByBbox.set(parentBbox, det.faceAlignedCrop)
      }
      if (det.nativeFaceShortSidePx !== undefined) {
        nativeFaceSizeByBbox.set(parentBbox, det.nativeFaceShortSidePx)
      }
      // Bind the face detail's OWN arcface embedding to the SAME parent bbox so
      // the face-detection frame's tracked person carries BOTH the faceBbox AND
      // an embedding — even if the first-level `det.embedding` inheritance
      // (result-assembler) didn't populate the person entry. Without this the
      // person would surface a faceBbox with no embedding → the FaceRecognizer
      // wouldn't see it as a candidate → the crop is never captured on the exact
      // frame that has a face box (the root cause of imageless gallery faces).
      // The first-level inherited vector, when present, still wins (only fill the
      // gap here).
      if (det.embedding !== undefined && !embeddingByBbox.has(parentBbox)) {
        embeddingByBbox.set(parentBbox, {
          embedding: det.embedding,
          ...(det.embeddingModelId !== undefined ? { embeddingModelId: det.embeddingModelId } : {}),
        })
      }
    }

    // Index `plate` detail OCR reads by their parent vehicle's bbox object (first
    // non-empty plate per vehicle wins), so the tracked vehicle surfaces its
    // plate text + tight plate box for the PlateRecognizer.
    for (const det of frame.detections) {
      if (det.kind !== 'detail' || det.macroClass !== 'plate' || !det.parentId) continue
      const parentBbox = firstLevelBboxById.get(det.parentId)
      if (parentBbox === undefined || plateByBbox.has(parentBbox)) continue
      const top = det.labels[0]
      if (top === undefined || top.label.length === 0) continue
      plateByBbox.set(parentBbox, {
        text: top.label,
        score: top.score,
        bbox: { x: det.bbox.x, y: det.bbox.y, w: det.bbox.width, h: det.bbox.height },
      })
    }

    // Root child boxes (D730): every detail the ROOT model drew, by its
    // parent's bbox object — never a track of its own (only first-level
    // entries were flattened above).
    for (const det of frame.detections) {
      if (det.kind !== 'detail' || det.rootSupplied === undefined || !det.parentId) continue
      const parentBbox = firstLevelBboxById.get(det.parentId)
      if (parentBbox === undefined) continue
      const boxes = rootChildBoxesByBbox.get(parentBbox) ?? []
      rootChildBoxesByBbox.set(parentBbox, [
        ...boxes,
        {
          stepId: det.rootSupplied.stepId,
          modelId: det.rootSupplied.modelId,
          score: det.score,
          bbox: { x: det.bbox.x, y: det.bbox.y, w: det.bbox.width, h: det.bbox.height },
        },
      ])
    }

    // 2. Zone filter (detection stage) — driven by `detectionZoneRules`
    //    forwarded with the runner config. Empty rules ⇒ everything passes.
    const { passed, excluded } = this.zoneEngine.filterDetections(
      flatDetections,
      this.zones,
      this.detectionRules,
      frameWidth,
      frameHeight,
      (fd) => fd.detection.class,
    )

    this.reportZoneFiltered(excluded)

    let filteredDetections: SpatialDetection[] = passed.map((fd) => fd.detection)

    // RIDER PAIRING — a person ON a two-wheeler is ONE subject, and it is a
    // VEHICLE (operator decision, 2026-07-31).
    //
    // The detector sees both halves and, left alone, the tracker takes them as
    // two independent subjects: one cyclist produces a `person` track AND a
    // `vehicle` track, and which one a notification rule sees depends on which
    // detection wins association that frame. Dropping the RIDER (never the
    // machine) makes the passage a vehicle, once. The person is not lost — the
    // fold is carried on the result and lands as `Track.hasRider` on the
    // surviving vehicle, so the record says "a vehicle WITH a rider" instead of
    // claiming an entity it does not keep. See {@link RiderFold}.
    const riderPairs = pairRiders(
      filteredDetections.map((d, i) => ({
        id: String(i),
        macroClass: d.class,
        ...(d.originalClass !== undefined ? { originalClass: d.originalClass } : {}),
        bbox: d.bbox,
        score: d.score,
      })),
    )
    /**
     * Pending folds, keyed by the SURVIVING vehicle's bbox object.
     *
     * The bbox object reference is the file's established way to carry
     * frame-local facts across the tracker (`labelsByBbox`,
     * `firstLevelBboxById`): the tracker assigns `track.bbox = det.bbox` on
     * every match and spawn, so the emitted `TrackedDetection.bbox` IS this
     * object when the vehicle was seen this frame.
     */
    const foldByVehicleBbox = new Map<BoundingBox, Omit<RiderFold, 'trackId'>>()
    if (riderPairs.length > 0) {
      const riderIdx = new Set(riderPairs.map((p) => Number(p.personId)))
      /**
       * Move every bbox-OBJECT-keyed side table from the machine's box to the
       * folded subject's box (D407).
       *
       * This file carries frame-local facts across the tracker by bbox-object
       * REFERENCE (`labelsByBbox`, `embeddingByBbox`, `maskByBbox`, …); the
       * tracker then assigns `track.bbox = det.bbox`, and the emit block below
       * reads every one of those maps with `td.bbox`. Widening the subject
       * therefore means the widened box must inherit the machine's entries —
       * otherwise a folded rider silently loses its vehicle-classifier label
       * ("Motorcycle"), its mask, its plate read and its source id. One place,
       * exhaustive, next to the maps it moves.
       */
      const adoptSubjectBox = (from: BoundingBox, to: BoundingBox): void => {
        const labels = labelsByBbox.get(from)
        if (labels !== undefined) labelsByBbox.set(to, labels)
        const tier = originalClassTierByBbox.get(from)
        if (tier !== undefined) originalClassTierByBbox.set(to, tier)
        const embedding = embeddingByBbox.get(from)
        if (embedding !== undefined) embeddingByBbox.set(to, embedding)
        const mask = maskByBbox.get(from)
        if (mask !== undefined) maskByBbox.set(to, mask)
        const plate = plateByBbox.get(from)
        if (plate !== undefined) plateByBbox.set(to, plate)
        const rootChildren = rootChildBoxesByBbox.get(from)
        if (rootChildren !== undefined) rootChildBoxesByBbox.set(to, rootChildren)
        const faceBbox = faceBboxByBbox.get(from)
        if (faceBbox !== undefined) faceBboxByBbox.set(to, faceBbox)
        const faceSize = nativeFaceSizeByBbox.get(from)
        if (faceSize !== undefined) nativeFaceSizeByBbox.set(to, faceSize)
        const alignedCrop = faceAlignedCropByBbox.get(from)
        if (alignedCrop !== undefined) faceAlignedCropByBbox.set(to, alignedCrop)
        const sourceId = sourceIdByBbox.get(from)
        if (sourceId !== undefined) {
          sourceIdByBbox.set(to, sourceId)
          firstLevelBboxById.set(sourceId, to)
        }
        if (faceBearingBoxes.has(from)) faceBearingBoxes.add(to)
      }
      /** Folded vehicles, by their index in `filteredDetections`. */
      const foldedVehicles = new Map<number, SpatialDetection>()
      for (const p of riderPairs) {
        const vehicleIdx = Number(p.vehicleId)
        const vehicle = filteredDetections[vehicleIdx]
        const person = filteredDetections[Number(p.personId)]
        if (vehicle === undefined || person === undefined) continue
        // ONE subject ⇒ ONE box: the union, formed here and nowhere else.
        const subjectBox: BoundingBox = riderSubjectBox(person.bbox, vehicle.bbox)
        adoptSubjectBox(vehicle.bbox, subjectBox)
        const folded: SpatialDetection = { ...vehicle, bbox: subjectBox }
        foldedVehicles.set(vehicleIdx, folded)
        foldByVehicleBbox.set(subjectBox, {
          overlap: p.overlap,
          personScore: person.score,
          vehicleScore: vehicle.score,
          vehicleClass: vehicle.originalClass ?? 'two-wheeler',
        })
      }
      filteredDetections = filteredDetections
        .map((d, i) => foldedVehicles.get(i) ?? d)
        .filter((_, i) => !riderIdx.has(i))
    }

    // 2b. Stationary-object gate — consulted BEFORE the tracker (and thus
    //     before minHits). Detections that keep confirming a known parked
    //     object are dropped so they never spawn/refresh a track; the entry's
    //     confirmation + any wake (object departed) are surfaced on the result
    //     for the addon to fold into registry + occupancy state.
    const gateDetectionIds = filteredDetections.map((d) => sourceIdByBbox.get(d.bbox))
    const gate: StationaryGateOutcome = this.stationaryGate
      ? this.stationaryGate.filter({
          detections: filteredDetections,
          frameWidth,
          frameHeight,
          timestamp,
          detectionIds: gateDetectionIds,
        })
      : {
          suppressedIndices: new Set<number>(),
          continuableIndices: new Set<number>(),
          confirmed: [],
          woken: [],
        }
    // A STRONG hold (the parked object's own box) never reaches the tracker.
    // A WEAK hold rides along flagged continuation-only (D410): it may update
    // a confirmed track and may not open, rescue or resurrect one. Indices are
    // re-based onto the tracker's input as the dropped ones fall out.
    const trackerInput: SpatialDetection[] = []
    const continuationOnly = new Set<number>()
    const continuableBoxes = new Set<BoundingBox>()
    for (let i = 0; i < filteredDetections.length; i++) {
      const det = filteredDetections[i]!
      if (gate.suppressedIndices.has(i)) {
        if (!gate.continuableIndices.has(i)) continue
        continuationOnly.add(trackerInput.length)
        continuableBoxes.add(det.bbox)
      }
      trackerInput.push(det)
    }

    // 3. Track. Frame dimensions ride along so the tracker's per-class minimum
    //    bbox-area spawn floor can score box area as a fraction of the frame.
    // 2c. Low-score continuation evidence (D665): the boxes the operator's
    //     class floor dropped, read off the discard trail — never off
    //     `frame.detections` — and put through the same detection-zone rules
    //     a confident box answers to. A separate list: the tracker may only
    //     let them keep a confirmed track alive, and emits that track as a
    //     coasting one, so nothing below this line acts on them.
    const lowCandidates = selectLowScoreContinuations(frame.discarded, this.lowScoreFloor)
    const lowScore =
      lowCandidates.length === 0
        ? lowCandidates
        : this.zoneEngine
            .filterDetections(
              lowCandidates.map((d) => ({ ...d.bbox, detection: d })),
              this.zones,
              this.detectionRules,
              frameWidth,
              frameHeight,
              (fd) => fd.detection.class,
            )
            .passed.map((fd) => fd.detection)

    const trackedDetections: readonly TrackerV2Emission[] = this.tracker.update(
      trackerInput,
      timestamp,
      {
        frameWidth,
        frameHeight,
        continuationOnly,
        lowScore,
        faceBearing: faceBearingBoxes,
      },
    )
    // L2 decisions of this frame: move the absorbed ids' per-track state to
    // their survivors BEFORE the state analyzer runs, so the continuation is
    // neither `leaving` under its old id nor `entered` under the new one.
    const fusions = this.tracker.drainFusions()
    this.applyFusions(fusions)
    for (const td of trackedDetections) {
      if (td.heldByLowScore === true) this.stats.lowScoreHolds += 1
    }
    // How many weak holds a confirmed track actually consumed this frame. The
    // tracker emits the matched detection's bbox by reference, so identity is
    // the join — the same trick the rider fold below relies on.
    const stationaryContinued =
      continuableBoxes.size === 0
        ? 0
        : trackedDetections.filter(
            (t) => t.matchedThisFrame !== false && continuableBoxes.has(t.bbox),
          ).length

    // 3b. Resolve each fold to the track that survived it. A fold whose vehicle
    //     the tracker did not emit this frame (below `minHits`, or the
    //     stationary gate suppressed it) still ships — WITHOUT a trackId — so
    //     the addon can say so out loud. Silence is what produced this defect.
    const riderFolds: readonly RiderFold[] =
      foldByVehicleBbox.size === 0
        ? EMPTY_RIDER_FOLDS
        : [...foldByVehicleBbox].map(([bbox, fold]) => {
            const td = trackedDetections.find(
              (t) => t.bbox === bbox && t.matchedThisFrame !== false,
            )
            return td !== undefined ? { ...fold, trackId: td.trackId } : fold
          })

    // 4. State analysis
    // A dropped frame never gets here (fix round 3): the analyzer only ever
    // sees frames the tracker took, on their own time.
    const objectStates = this.stateAnalyzer.analyze(trackedDetections, timestamp)

    // Build lightweight output + per-track zone lookup. Annotation
    // is geometry-only (no class narrowing): a track is "in" every
    // zone whose polygon its bbox overlaps by more than
    // `zoneMembershipMinOverlap`. Per-class semantics live on rules, not on
    // the membership annotation.
    //
    // This set becomes the event's `zones`, which a notification rule's
    // `zones` condition tests by plain membership — so this threshold, not
    // the zone-RULE `bboxInclusionPct`, is what decides whether a
    // zone-scoped notification can fire.
    const zonesByTrack = new Map<string, readonly string[]>()
    const overlapsByTrack = new Map<string, readonly DetectionZoneMembership[]>()
    const rejectedByTrack = new Map<string, readonly DetectionZoneMembership[]>()
    for (const td of trackedDetections) {
      const m = maskByBbox.get(td.bbox)
      const { memberships, belowBar } = this.zoneEngine.splitDetectionZones(
        td.bbox,
        this.zones,
        frameWidth,
        frameHeight,
        m?.mask,
        m?.width,
        m?.height,
        this.zoneMembershipMinOverlap,
      )
      zonesByTrack.set(
        td.trackId,
        memberships.map((m2) => m2.zoneId),
      )
      if (memberships.length > 0) overlapsByTrack.set(td.trackId, memberships)
      if (belowBar.length > 0) rejectedByTrack.set(td.trackId, belowBar)
    }
    // A track is BORN with the zones its own PRE-CONFIRMATION measurements
    // fell in (D430).
    //
    // The confirmation gate decides WHEN a subject becomes a track; it does
    // not decide where the subject has been. A birth needs `minHits`
    // measurements, and on a subject the full frame keeps missing — one the
    // native crop pass recovers about once a second — those measurements cost
    // seconds. Camera 101, 2026-09-10 05:55: a cat was recovered at 0.586,
    // then 0.620, then 0.829, and the track was born on the third. By then it
    // had left the flowerbed for the doorstep, so `zonesVisited` read
    // `["Uscio"]` and the rule "Animale su Aiuola" was rejected on `zones` —
    // correctly, against data that was wrong.
    //
    // The tracker already carries the boxes (`InternalTrack.path`, emitted as
    // `path`), so this is a history that was being discarded, not one that has
    // to be built. Folded ONCE per track, on its first visible frame; the
    // current frame's own box is excluded because it is already in the set.
    for (const td of trackedDetections) {
      if (this.birthZonesSeeded.has(td.trackId)) continue
      this.birthZonesSeeded.add(td.trackId)
      const trail = td.path
      if (trail.length <= 1) continue
      const atBirth = zonesByTrack.get(td.trackId) ?? []
      const zones = new Set(atBirth)
      const bornWith = zones.size
      for (let i = 0; i < trail.length - 1; i++) {
        const box = trail[i]
        if (box === undefined) continue
        const { memberships } = this.zoneEngine.splitDetectionZones(
          box,
          this.zones,
          frameWidth,
          frameHeight,
          undefined,
          undefined,
          undefined,
          this.zoneMembershipMinOverlap,
        )
        for (const m of memberships) zones.add(m.zoneId)
      }
      if (zones.size === bornWith) continue
      // Captured BEFORE the write: `atBirth` is what the birth frame alone
      // saw, and the difference is the whole point of the line.
      const inherited = [...zones].filter((z) => !atBirth.includes(z))
      zonesByTrack.set(td.trackId, [...zones])
      this.birthZoneTrailObserver?.({
        deviceId: this.deviceId,
        trackId: td.trackId,
        className: td.class,
        measurementsBeforeBirth: trail.length - 1,
        zonesAtBirth: [...atBirth],
        inheritedZones: inherited,
      })
    }

    this.lastZoneOverlaps = overlapsByTrack
    this.lastZoneRejections = rejectedByTrack

    // A track ABSENT from this frame keeps the zones it was last seen in.
    //
    // `zonesByTrack` can only describe tracks the tracker returned THIS frame,
    // but an `object.leaving` event fires precisely for a track that is gone —
    // the emitter resolves it from its own `lastKnownTracks` for that reason.
    // The lookup therefore missed and every leaving event carried `zones: []`,
    // which no zone-scoped notification rule can ever match. Measured on
    // 2026-07-31: a person crossed device 101's "Uscio" zone at 0.889
    // confidence and the rule scoped to exactly that zone never fired, because
    // the only event the passage produced was its exit.
    for (const td of trackedDetections) this.lastDetectionByTrack.set(td.trackId, td)
    for (const [trackId, zoneIds] of zonesByTrack) this.lastZonesByTrack.set(trackId, zoneIds)
    for (const state of objectStates) {
      if (zonesByTrack.has(state.trackId)) continue
      const remembered = this.lastZonesByTrack.get(state.trackId)
      if (remembered && remembered.length > 0) zonesByTrack.set(state.trackId, remembered)
    }

    // Zone CROSSINGS — the passages a rule subscribes to. Until now the emitter
    // was handed a literal `[]` here ("a follow-up", never done), so the whole
    // zone.enter / zone.exit vocabulary was dead: a subject that walked through
    // a zone without changing movement state produced no event at all.
    const zoneEvents: ZoneEvent[] = []
    const pushZoneEvent = (
      type: ZoneEvent['type'],
      zoneId: string,
      detection: TrackedDetection,
    ): void => {
      const zone = this.zones.find((z) => z.id === zoneId)
      zoneEvents.push({
        type,
        zoneId,
        zoneName: zone?.name ?? zoneId,
        trackId: detection.trackId,
        detection,
        timestamp,
      })
    }
    // An exit off the EDGE of the frame. `ZoneTransitionTracker.forget` returns
    // the zones the track was still inside for exactly this reason, and the
    // result was thrown away — so a subject that walked out of SHOT while
    // inside a zone produced no exit at all. For a perimeter camera that is the
    // interesting case, not "walked out of the zone".
    //
    // Done BEFORE the emit so the events reach it, and using the last detection
    // the track had: it is absent from this frame by definition.
    for (const state of objectStates) {
      if (state.state !== 'leaving') continue
      const stillInside = this.zoneTransitions.forget(state.trackId)
      this.tripwires.forget(state.trackId)
      if (stillInside.length === 0) continue
      const last = this.lastDetectionByTrack.get(state.trackId)
      if (last === undefined) continue
      for (const zoneId of stillInside) pushZoneEvent('zone-exit', zoneId, last)
    }

    for (const td of trackedDetections) {
      const crossings = this.zoneTransitions.observe(td.trackId, zonesByTrack.get(td.trackId) ?? [])
      for (const zoneId of crossings.entered) pushZoneEvent('zone-enter', zoneId, td)
      for (const zoneId of crossings.exited) pushZoneEvent('zone-exit', zoneId, td)
    }

    // TRIPWIRE crossings — the other half of the same absence. `tripwireCrossing()`
    // has always existed and had zero callers, so a drawn tripwire could never
    // fire. A tripwire zone stores its directed line as the first two points of
    // `polygon`; the subject's centroid is what crosses it.
    const wires = this.zones.filter((z) => z.kind === 'tripwire' && z.polygon.length >= 2)
    if (wires.length > 0) {
      for (const td of trackedDetections) {
        const centroid = bboxCentroid({
          x: td.bbox.x / frameWidth,
          y: td.bbox.y / frameHeight,
          w: td.bbox.w / frameWidth,
          h: td.bbox.h / frameHeight,
        })
        for (const zone of wires) {
          const a = zone.polygon[0]
          const b = zone.polygon[1]
          if (a === undefined || b === undefined) continue
          const wire: LineSegment = { p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y } }
          for (const cross of this.tripwires.observe(td.trackId, zone.id, wire, centroid)) {
            zoneEvents.push({
              type: 'tripwire-cross',
              zoneId: zone.id,
              zoneName: zone.name,
              trackId: td.trackId,
              detection: td,
              direction: cross.direction,
              timestamp,
            })
          }
        }
      }
    }

    // 5. Event emission. Zone crossings are computed above and passed in; the
    //    emitter's zone branch has always existed, it was simply never fed.
    const rawEvents = this.eventEmitter.emit(
      trackedDetections,
      objectStates,
      zoneEvents,
      [],
      String(this.deviceId),
    )

    // A track that has left is dropped from BOTH zone caches — after the emit,
    // so its leaving event still carried the zones it was in. Without this the
    // maps grow for the life of the process.
    for (const state of objectStates) {
      if (state.state !== 'leaving') continue
      // `zoneTransitions` / `tripwires` were already forgotten above, where
      // their remaining zones became exit events.
      this.lastZonesByTrack.delete(state.trackId)
      this.birthZonesSeeded.delete(state.trackId)
      this.lastDetectionByTrack.delete(state.trackId)
      this.reportedRefusalByTrack.delete(state.trackId)
    }

    const refusals: LabelWriteRefusalInfo[] = []
    // Resolved ONCE per track per frame and reused by the ObjectEvent builder
    // below: the track row and the events it produces on the same frame must
    // not be able to disagree about the label, and running the rule twice is
    // how they would.
    const labelPatchByTrack = new Map<string, TieredLabelPatch>()
    const tracked: TrackedDetectionOut[] = trackedDetections.map((td) => {
      const objectState = objectStates.find((o) => o.trackId === td.trackId)
      const state = mapObjectStateToTrackState(objectState?.state)
      // Settled by the analyzer, dwell still running: `stationarySince` is
      // stamped on the first settled frame and cleared on the first that is
      // not, so its presence under a non-`idle` verdict is exactly "not yet
      // decided" (D547).
      const settling = objectState?.stationarySince !== undefined && state !== 'idle'
      const candidate = resolveDetectionLabelCandidate({
        className: td.class,
        originalClass: td.originalClass,
        ...(originalClassTierByBbox.get(td.bbox) !== undefined
          ? { originalClassTier: originalClassTierByBbox.get(td.bbox) }
          : {}),
        labels: labelsByBbox.get(td.bbox),
        decidedAt: timestamp,
      })
      // Birth writes against an EMPTY row: this is the first thing said about
      // the track, so there is no incumbent to lose to. Every later writer goes
      // through the same rule with the row's current tiers.
      // A label computed for the matched detection's class rides only a track
      // of that class. The write rule speaks first (its refusals keep their
      // diagnoses, e.g. the macro-class collapse); a candidate it would WRITE is
      // then turned away by name when the detection was another class, so a
      // recurrence shows.
      const ownClass = detectionClassByBbox.get(td.bbox)
      const ruled =
        candidate === undefined
          ? undefined
          : resolveTieredLabelWrite({ className: td.class }, candidate)
      const decision: TieredLabelDecision | undefined =
        candidate !== undefined &&
        ruled?.kind === 'write' &&
        ownClass !== undefined &&
        ownClass !== td.class
          ? {
              kind: 'refused',
              reason: {
                kind: 'class-mismatch',
                text: candidate.text,
                stepId: candidate.stepId,
                className: td.class,
                expectedClass: ownClass,
              },
            }
          : ruled
      const labelPatch = decision?.kind === 'write' ? decision.patch : undefined
      if (labelPatch !== undefined) labelPatchByTrack.set(td.trackId, labelPatch)
      // A candidate was turned away. Report it ONCE per (track, token): the same
      // wrong candidate re-offers itself on every frame the track keeps matching
      // it, and one line per frame would bury what it is reporting.
      if (decision?.kind === 'refused' && candidate !== undefined) {
        const key = `${decision.reason.kind}:${candidate.text}`
        if (this.reportedRefusalByTrack.get(td.trackId) !== key) {
          this.reportedRefusalByTrack.set(td.trackId, key)
          refusals.push({ trackId: td.trackId, reason: decision.reason })
        }
      }
      const emb = embeddingByBbox.get(td.bbox)
      const faceBbox = faceBboxByBbox.get(td.bbox)
      const nativeFaceShortSidePx = nativeFaceSizeByBbox.get(td.bbox)
      const faceAlignedCrop = faceAlignedCropByBbox.get(td.bbox)
      const plate = plateByBbox.get(td.bbox)
      const sourceDetectionId = sourceIdByBbox.get(td.bbox)
      // Only when the track MATCHED a real detection this frame: a coasting
      // box carries the last-seen rectangle, and the measurement that produced
      // it belongs to a frame that is over.
      const nativeRecovery =
        td.matchedThisFrame !== false ? nativeRecoveryByBbox.get(td.bbox) : undefined
      const birthEvidence =
        td.matchedThisFrame !== false ? birthEvidenceByBbox.get(td.bbox) : undefined
      const rootChildBoxes =
        td.matchedThisFrame !== false ? rootChildBoxesByBbox.get(td.bbox) : undefined
      return {
        trackId: td.trackId,
        ...(sourceDetectionId !== undefined ? { sourceDetectionId } : {}),
        className: td.class,
        confidence: td.score,
        bbox: { ...td.bbox },
        zones: zonesByTrack.get(td.trackId) ?? [],
        state,
        // Absent (legacy runner) ⇒ treat as matched so media eligibility is
        // never MORE restrictive than before this field existed.
        matchedThisFrame: td.matchedThisFrame !== false,
        settling,
        confirmed: td.confirmed,
        ...(labelPatch !== undefined ? { labelPatch } : {}),
        ...(emb !== undefined
          ? {
              embedding: emb.embedding,
              ...(emb.embeddingModelId !== undefined
                ? { embeddingModelId: emb.embeddingModelId }
                : {}),
            }
          : {}),
        ...(faceBbox !== undefined ? { faceBbox } : {}),
        ...(nativeFaceShortSidePx !== undefined ? { nativeFaceShortSidePx } : {}),
        ...(faceAlignedCrop !== undefined ? { faceAlignedCrop } : {}),
        ...(plate !== undefined
          ? { plateText: plate.text, plateScore: plate.score, plateBbox: plate.bbox }
          : {}),
        ...(nativeRecovery !== undefined ? { nativeRecovery } : {}),
        ...(birthEvidence !== undefined ? { birthEvidence } : {}),
        ...(rootChildBoxes !== undefined ? { rootChildBoxes } : {}),
      }
    })
    this.lastLabelWriteRefusals = refusals

    // 6. Turn raw events into ObjectEvent rows (cap schema). One event
    //    per detected transition — the event emitter already dedupes.
    //    Appearance events (`object.detected`, Requirement 1) are split into
    //    their own stream: they always carry a PRESENT-track bbox and the
    //    canonical `entered` state (the subject just appeared), and the addon
    //    keeps them off the notification bus.
    //    A crossing event is stamped with WHICH WAY it went, so a notification
    //    rule can ask for one direction and not the other. The emitter builds a
    //    crossing event from exactly one `ZoneEvent`, so there is one direction
    //    and one zone per row — never an ambiguous mix. Keyed off the event
    //    TYPE, not off `zoneEvents` being non-empty: a movement-state event
    //    carries the frame's crossings for its track too, and it is not one.
    const crossingOf = (e: (typeof rawEvents)[number]): ZoneCrossing | undefined => {
      const ze = e.zoneEvents[0]
      // A tripwire reuses the SAME condition vocabulary as a zone crossing
      // rather than inventing a second one: its directed line's right-hand side
      // is `enter`, the reverse is `exit`, and an operator picks which physical
      // direction that means by drawing the line one way round. So a rule that
      // already says "only entries" works on a tripwire with no new field.
      const direction: ZoneCrossingDirection | undefined =
        e.type === 'zone.enter'
          ? 'enter'
          : e.type === 'zone.exit'
            ? 'exit'
            : e.type === 'tripwire.cross'
              ? ze?.direction === 'out'
                ? 'exit'
                : 'enter'
              : undefined
      if (direction === undefined) return undefined
      // Unreachable by construction (the emitter's zone branch always attaches
      // the crossing it fired for); degrading to an unstamped event rather than
      // throwing keeps one malformed row from killing the frame path.
      if (ze === undefined) return undefined
      return { direction, zoneId: ze.zoneId, zoneName: ze.zoneName }
    }

    const toObjectEvent = (
      e: (typeof rawEvents)[number],
      forcedState?: TrackState,
    ): ObjectEventDraft => {
      const td = trackedDetections.find((t) => t.trackId === e.detection.trackId)
      const state =
        forcedState ??
        mapObjectStateToTrackState(
          objectStates.find((o) => o.trackId === e.detection.trackId)?.state,
        )
      const zones = zonesByTrack.get(e.detection.trackId) ?? []
      const crossing = crossingOf(e)
      // The SAME decision the track row got, not a second evaluation of the
      // same inputs — see `labelPatchByTrack`.
      //
      // And when THIS frame decided nothing, the row still carries what the
      // TRACK already knows (`trackLabelState`). Without that fallback only the
      // rows of the frame that produced a label carried it: a face recognised
      // at second 11 back-patched the rows emitted BEFORE it and every row
      // emitted AFTER it came out blank, so one track's events disagreed with
      // the track and with each other. The back-patch was blamed for a hole the
      // emitter was digging behind it.
      const labelPatch =
        labelPatchByTrack.get(e.detection.trackId) ??
        knownTrackLabelPatch(this.trackLabelState?.(e.detection.trackId))
      return {
        deviceId: this.deviceId,
        timestamp,
        kind: 'object' as const,
        source: this.source,
        // Scene/parent key: all events from this frame share it (see cap doc).
        frameId: frame.frameId,
        trackId: e.detection.trackId,
        className: e.detection.class,
        confidence: e.detection.score,
        // ABSENT when the track is not in this frame, never a box at the
        // origin. A `left` event is resolved by the emitter from
        // `lastKnownTracks` precisely BECAUSE the subject is gone this frame
        // ("NOT crop-bearing" — `event-emitter.ts`), and `{0,0,0,0}` states
        // that as a rectangle: a consumer cannot tell a fabricated box from a
        // measured one, and every one that did not think about it got a
        // subject 0×0 pixels wide in the top-left corner. `bbox` is optional on
        // the cap schema, so absence is a shape consumers already handle.
        ...(td ? { bbox: { ...td.bbox } } : {}),
        zones,
        state,
        ...(crossing !== undefined ? { zoneCrossing: crossing } : {}),
        ...labelPatch,
        // Detection-frame dimensions — let consumers scale the pixel-space
        // bbox onto a displayed image (e.g. the viewer's bbox overlay).
        frameWidth,
        frameHeight,
      }
    }

    // A detection the TRACKER refused, inside a watched zone, still becomes an
    // event.
    //
    // The gate below (`e.detection.trackId`) is correct for everything the
    // tracker accepted, and it is what silenced a dog at 0.7729 with 100% of
    // its box inside the operator's "Aiuola" zone on 2026-09-09: refused three
    // times in six seconds with three different candidate ids, because the
    // camera analysed seven frames in that window and the subject appeared in a
    // handful of them, metres apart. `threshold=3 measured=1 trackLifeMs=0`.
    //
    // Tracking answers "is this the same subject as before?" and its
    // confirmation threshold presumes continuity. A zone-scoped immediate rule
    // asks "is there an animal in the flowerbed NOW?" — a question the
    // detection had already answered. The threshold stays where it is (the
    // phantom guard it exists for is real: eight non-existent `vehicle` boxes
    // were refused on this same camera the same morning); what changes is that
    // the refused detection is no longer thrown away in SILENCE — it is
    // reported to an observer the addon logs. It does NOT become an event:
    // production said this population is stationary junk and that the only
    // alerts it ever raised were phantoms the gate had rightly refused
    // (D426). Only refusals inside a zone are worth even the log line.
    this.reportRefusedDetectionsInZones(timestamp, frameWidth, frameHeight)

    const withTrackId = rawEvents.filter((e) => e.detection.trackId)
    const objectEvents: ObjectEventDraft[] = withTrackId
      .filter((e) => e.type !== 'object.detected')
      .map((e) => toObjectEvent(e))
    const appearanceEvents: ObjectEventDraft[] = withTrackId
      .filter((e) => e.type === 'object.detected')
      .map((e) => toObjectEvent(e, 'entered'))

    const observation =
      input.observe === true
        ? observeFrame({
            detectionIds: gateDetectionIds,
            gateBoxes: filteredDetections.map((d) => d.bbox),
            gate,
            tracked,
            heldByLowScore: new Set(
              trackedDetections.filter((t) => t.heldByLowScore === true).map((t) => t.trackId),
            ),
          })
        : undefined
    return {
      deviceId: this.deviceId,
      timestamp,
      frameWidth,
      frameHeight,
      tracked,
      objectEvents,
      appearanceEvents,
      rawTrackedDetections: trackedDetections,
      stationaryConfirmed: gate.confirmed,
      stationaryWoken: gate.woken,
      stationaryContinued,
      riderFolds,
      ...(observation !== undefined ? { observation } : {}),
      fusions,
    }
  }
}
