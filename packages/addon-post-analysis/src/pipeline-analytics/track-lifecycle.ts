/**
 * Track-lifecycle events — pure gate + payload assembly.
 *
 * `PipelineAnalyticsTrackLifecycle` is one event carrying
 * `phase:'start'|'update'|'end'`. The emit sites live in `index.ts`
 * (track-create, the `isNewBest` snapshot decision, and the TTL-gated
 * `sweepExpiredTracks` end); this module holds the two pure pieces those
 * sites need:
 *
 *  - `evaluateTrackLifecycleUpdate` — the MATERIAL-improvement gate for
 *    `phase:'update'`. Reuses the existing `isNewBest` signal and adds a
 *    confidence-delta / newly-resolved-label / larger-crop trigger, then
 *    debounces so a track can't rapid-fire updates. Compares against the
 *    LAST-EMITTED values so sub-threshold improvements accumulate.
 *  - `buildTrackLifecyclePayload` — assembles the typed cross-phase
 *    payload, omitting absent optional fields and the `media` object when
 *    no media key is present.
 *
 * No timers, no machinery beyond a small per-track memory the caller
 * keeps (seeded at `start`, dropped at `end`).
 */
import type { PipelineAnalyticsTrackLifecyclePayload, TrackLifecyclePhase } from '@camstack/types'

import { patchDisplayLabel, type TieredLabelPatch } from './pipeline/label-tier.js'

/** Minimum confidence increase (vs last emit) that counts as a material
 *  improvement. */
const UPDATE_MIN_CONF_DELTA = 0.1
/** Debounce floor between two `update` emits for the same track (ms). */
const UPDATE_MIN_INTERVAL_MS = 4000
/** Minimum fractional bbox-area growth (vs last emit) counted as a
 *  materially larger representative crop (e.g. 0.15 = 15% bigger). */
const UPDATE_MIN_CROP_AREA_GROWTH = 0.15

/**
 * The label a `phase:'update'` SIGNAL and PAYLOAD carry, resolved from its
 * two possible sources in order: this frame's tiered patch (the frame path
 * wrote a label this very frame), then the track ROW's stored display label
 * (`subLabel ?? label`, as `trackStore.peekActive` exposes it).
 *
 * The fallback is not a nicety. The face recognizer assigns an identity over
 * the async detail plane and writes it to the row (`applyLabelCandidate`) —
 * never into a frame patch — so a signal reading only the patch can never
 * fire the identity trigger for a recognised face. Measured on the live hub
 * (2026-09-05, device 104): six of six face identities reached Home
 * Assistant only on the `end` event at track close + sweep (~lastSeen+33 s),
 * zero during the track's life, while the subject was still on camera.
 */
export function resolveLifecycleUpdateLabel(
  labelPatch: TieredLabelPatch | undefined,
  storedDisplayLabel: string | undefined,
): string | undefined {
  return patchDisplayLabel(labelPatch) ?? storedDisplayLabel
}

export interface TrackLifecycleUpdateConfig {
  readonly minConfDelta: number
  readonly minIntervalMs: number
  readonly minCropAreaGrowth: number
}

export const DEFAULT_UPDATE_GATE_CONFIG: TrackLifecycleUpdateConfig = {
  minConfDelta: UPDATE_MIN_CONF_DELTA,
  minIntervalMs: UPDATE_MIN_INTERVAL_MS,
  minCropAreaGrowth: UPDATE_MIN_CROP_AREA_GROWTH,
}

/** The subset of the track's best-so-far state carried across `update`
 *  evaluations. Seeded at `start`, updated only when an `update` emits. */
export interface TrackLifecycleUpdateMemory {
  readonly lastConfidence: number
  readonly lastEmitAt: number
  readonly lastLabel?: string
  readonly lastBboxArea?: number
  /** Zones the track had visited at the last evaluation — growth = entry. */
  readonly lastZonesVisitedCount?: number
  /** Triggers dropped by the debounce since the last emit. Reset on emit;
   *  surfaced by the caller's suppression log line — a drop is counted,
   *  never silent. */
  readonly suppressedSinceEmit?: number
}

/** The current-frame signal fed to the gate. */
export interface TrackLifecycleUpdateSignal {
  /** The existing `bestFrameTracker.observe(...)` result for this frame. */
  readonly isNewBest: boolean
  readonly confidence: number
  readonly now: number
  readonly label?: string
  /** Representative crop area (pixel² or normalised — units only need to be
   *  self-consistent since the trigger is a relative growth). */
  readonly bboxArea?: number
  /** Cumulative zones the track has visited (`zonesVisited.length` on the
   *  store row — it never shrinks, so growth means a NEW zone entered). */
  readonly zonesVisitedCount?: number
}

export type TrackLifecycleUpdateReason = 'confidence' | 'identity' | 'crop' | 'zone'

export interface TrackLifecycleUpdateDecision {
  readonly emit: boolean
  readonly reason?: TrackLifecycleUpdateReason
  /** Set when a live trigger was dropped by the debounce — the cadence
   *  drop the caller must COUNT (log), never swallow. */
  readonly suppressed?: TrackLifecycleUpdateReason
  /** Memory to persist for the next evaluation — unchanged when not
   *  emitting, advanced to the just-emitted best when emitting. */
  readonly memory: TrackLifecycleUpdateMemory
}

/**
 * Decide whether a `phase:'update'` event should fire this frame.
 *
 * Priority of triggers: newly-resolved identity/plate > confidence
 * improvement > newly-entered zone > materially larger crop. All triggers are debounced by
 * `minIntervalMs` relative to the last emit. Deltas are measured against
 * the LAST-EMITTED memory, so a run of sub-threshold new-bests accumulates
 * and fires once it crosses `minConfDelta`.
 */
export function evaluateTrackLifecycleUpdate(
  signal: TrackLifecycleUpdateSignal,
  memory: TrackLifecycleUpdateMemory | undefined,
  config: TrackLifecycleUpdateConfig,
): TrackLifecycleUpdateDecision {
  const hasLabel = signal.label !== undefined && signal.label !== ''
  const identityTrigger = hasLabel && (memory === undefined || memory.lastLabel !== signal.label)
  const confidenceTrigger =
    signal.isNewBest &&
    (memory === undefined || signal.confidence - memory.lastConfidence >= config.minConfDelta)
  // Growth only: `zonesVisited` never shrinks, so a larger count is a NEW
  // zone entered — an intermediate event worth pushing while the subject is
  // still there. A missing baseline seeds below without emitting (a track
  // born inside a zone already carried it on `start`).
  const zoneTrigger =
    signal.zonesVisitedCount !== undefined &&
    memory?.lastZonesVisitedCount !== undefined &&
    signal.zonesVisitedCount > memory.lastZonesVisitedCount
  const cropTrigger =
    signal.bboxArea !== undefined &&
    memory?.lastBboxArea !== undefined &&
    memory.lastBboxArea > 0 &&
    signal.bboxArea >= memory.lastBboxArea * (1 + config.minCropAreaGrowth)

  const reason: TrackLifecycleUpdateReason | undefined = identityTrigger
    ? 'identity'
    : confidenceTrigger
      ? 'confidence'
      : zoneTrigger
        ? 'zone'
        : cropTrigger
          ? 'crop'
          : undefined

  const keptMemory: TrackLifecycleUpdateMemory =
    memory === undefined
      ? {
          lastConfidence: signal.confidence,
          lastEmitAt: signal.now,
          ...(signal.zonesVisitedCount !== undefined
            ? { lastZonesVisitedCount: signal.zonesVisitedCount }
            : {}),
        }
      : memory.lastZonesVisitedCount === undefined && signal.zonesVisitedCount !== undefined
        ? { ...memory, lastZonesVisitedCount: signal.zonesVisitedCount }
        : memory

  if (reason === undefined) return { emit: false, memory: keptMemory }

  // Debounce against the previous emit (only meaningful once we have one).
  // The drop is COUNTED into memory and named in the decision — a cadence
  // throttle that swallowed events silently is how a 30-second delivery
  // delay stayed invisible for weeks.
  if (memory !== undefined && signal.now - memory.lastEmitAt < config.minIntervalMs) {
    return {
      emit: false,
      suppressed: reason,
      memory: {
        ...keptMemory,
        suppressedSinceEmit: (keptMemory.suppressedSinceEmit ?? 0) + 1,
      },
    }
  }

  const nextLabel = signal.label ?? memory?.lastLabel
  const nextBboxArea = signal.bboxArea ?? memory?.lastBboxArea
  const nextZonesCount = signal.zonesVisitedCount ?? memory?.lastZonesVisitedCount
  // `suppressedSinceEmit` is deliberately dropped: the counter covers the
  // window since the LAST emit, and this is one.
  const nextMemory: TrackLifecycleUpdateMemory = {
    lastConfidence:
      memory === undefined ? signal.confidence : Math.max(memory.lastConfidence, signal.confidence),
    lastEmitAt: signal.now,
    ...(nextLabel !== undefined ? { lastLabel: nextLabel } : {}),
    ...(nextBboxArea !== undefined ? { lastBboxArea: nextBboxArea } : {}),
    ...(nextZonesCount !== undefined ? { lastZonesVisitedCount: nextZonesCount } : {}),
  }
  return { emit: true, reason, memory: nextMemory }
}

export interface TrackLifecycleBuildInput {
  readonly deviceId: number
  readonly trackId: string
  readonly phase: TrackLifecyclePhase
  readonly classes: readonly string[]
  readonly bestClassName: string
  readonly bestConfidence: number
  readonly firstSeen: number
  readonly lastSeen: number
  readonly label?: string
  readonly identityId?: string
  readonly plateText?: string
  readonly zonesVisited?: readonly string[]
  readonly totalDistance?: number
  readonly positionsCount?: number
  readonly importance?: number
  readonly importanceReason?: string
  /** Audio-classification labels heard on the camera during the track's
   *  life so far (mirrors `Track.audioLabels`). */
  readonly audioLabels?: PipelineAnalyticsTrackLifecyclePayload['audioLabels']
  readonly keyFrameMediaId?: number
  readonly bestCropMediaId?: number
  readonly bestEventId?: string
  readonly embeddingId?: string
  readonly embeddingModelId?: string
}

/**
 * Assemble the typed lifecycle payload. Optional fields (and the whole
 * `media` object) are omitted when absent so consumers get a clean shape.
 */
export function buildTrackLifecyclePayload(
  input: TrackLifecycleBuildInput,
): PipelineAnalyticsTrackLifecyclePayload {
  const media: PipelineAnalyticsTrackLifecyclePayload['media'] = {
    ...(input.keyFrameMediaId !== undefined ? { keyFrameMediaId: input.keyFrameMediaId } : {}),
    ...(input.bestCropMediaId !== undefined ? { bestCropMediaId: input.bestCropMediaId } : {}),
    ...(input.bestEventId !== undefined ? { bestEventId: input.bestEventId } : {}),
  }
  const hasMedia = Object.keys(media).length > 0

  return {
    deviceId: input.deviceId,
    trackId: input.trackId,
    phase: input.phase,
    classes: [...input.classes],
    bestClassName: input.bestClassName,
    bestConfidence: input.bestConfidence,
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen,
    durationMs: Math.max(0, input.lastSeen - input.firstSeen),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
    ...(input.plateText !== undefined ? { plateText: input.plateText } : {}),
    ...(input.zonesVisited !== undefined ? { zonesVisited: [...input.zonesVisited] } : {}),
    ...(input.totalDistance !== undefined ? { totalDistance: input.totalDistance } : {}),
    ...(input.positionsCount !== undefined ? { positionsCount: input.positionsCount } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.importanceReason !== undefined ? { importanceReason: input.importanceReason } : {}),
    ...(input.audioLabels !== undefined && input.audioLabels.length > 0
      ? { audioLabels: input.audioLabels }
      : {}),
    ...(input.embeddingId !== undefined ? { embeddingId: input.embeddingId } : {}),
    ...(input.embeddingModelId !== undefined ? { embeddingModelId: input.embeddingModelId } : {}),
    ...(hasMedia ? { media } : {}),
  }
}
