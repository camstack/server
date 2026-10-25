/**
 * One L1 tracklet (D683 §3.1). Internal mutable state of the tracker —
 * nothing outside `tracker-v2/` holds a reference; what leaves is an
 * immutable emission.
 */
import type { BoundingBox, NativeRecoveryEvidence, SpatialDetection } from '@camstack/types'
import { type AppearanceAggregate, foldAppearance } from './appearance.js'
import { MAX_PATH_LENGTH, MAX_PREDICTION_MS } from './constants.js'
import { centreOf } from './geometry.js'
import type { Lineage, TrackletEndReason, TrackletMode } from './types.js'

export interface TrackletInit {
  readonly id: string
  readonly startedAt: number
  readonly det: SpatialDetection
  readonly lineage: Lineage
  readonly cohort: string | null
  readonly faceBearing: boolean
}

export interface Velocity {
  readonly vx: number
  readonly vy: number
}

/** `TrackedDetection.velocity`'s unit: px per emit interval. */
export interface EmitVelocity {
  readonly dx: number
  readonly dy: number
}

/** `stale`: the sighting is older than the tracklet's last one and was not recorded. */
export type ObserveOutcome = 'recorded' | 'stale'

export class Tracklet {
  readonly id: string
  readonly startedAt: number
  readonly lineage: Lineage
  /** The class the tracklet ASSOCIATES as, set at birth (D442). */
  readonly klass: string
  /** The birth box — kept apart from `path`, which is truncated. L2 measures from it. */
  readonly firstBox: BoundingBox
  cohort: string | null
  mode: TrackletMode = 'active'
  confirmed = false
  hits = 0
  /** Hits taken while contested inside a split cohort (§3.2). */
  contestedHits = 0
  /** When the tracklet's doubt began; `null` = never contested. Bounds it (CONTESTED_MAX_MS). */
  contestedSince: number | null = null
  /** Still inside the doubt it was born in: true from a split until its first
   *  uncontested pair. Cohort members in doubt never split each other again. */
  inDoubt = false
  /** The confirmation gate refused this birth: it never becomes a link end (review H2). */
  suppressed = false
  score: number
  originalClass: string
  lastBox: BoundingBox
  lastSeenAt: number
  assocBox: BoundingBox
  assocAt: number
  velocity: Velocity = { vx: 0, vy: 0 }
  emitIntervalMs = 0
  path: BoundingBox[] = []
  appearance: AppearanceAggregate | null = null
  /** A face detail was seen inside one of its boxes (any size — review 2 NH1). */
  faceBearing = false
  /** When it first became face-bearing: the start of L2's recognition wait. */
  firstFaceAt: number | null = null
  /** The FaceRecognizer's settled identity for this piece (or the tape's pseudonym in replay); `null` = none yet. */
  identity: string | null = null
  heldByLowScore = false
  lastNativeRecovery: NativeRecoveryEvidence | undefined
  endedAt: number | null = null
  endReason: TrackletEndReason | null = null
  private readonly classVotes = new Map<string, number>()

  constructor(init: TrackletInit) {
    this.id = init.id
    this.startedAt = init.startedAt
    this.lineage = init.lineage
    this.klass = init.det.class
    this.firstBox = init.det.bbox
    this.cohort = init.cohort
    this.score = init.det.score
    this.originalClass = init.det.originalClass
    this.lastBox = init.det.bbox
    this.lastSeenAt = init.startedAt
    this.assocBox = init.det.bbox
    this.assocAt = init.startedAt
    this.recordConfident(init.det, init.startedAt, init.faceBearing)
  }

  predicted(now: number): BoundingBox {
    const dt = Math.min(Math.max(0, now - this.assocAt), MAX_PREDICTION_MS)
    return {
      x: this.assocBox.x + this.velocity.vx * dt,
      y: this.assocBox.y + this.velocity.vy * dt,
      w: this.assocBox.w,
      h: this.assocBox.h,
    }
  }

  /**
   * A confident sighting. One OLDER than the last (`t < lastSeenAt` — ~1 % of
   * frames reach the tracker out of capture order, up to 1.2 s back) is
   * `stale`: it changes nothing. A rewound tracklet would be measured from a
   * box its subject left a second ago, and L2 refused a link by reach on
   * exactly that (follow-up 102, F1). The caller reports it.
   */
  observeConfident(det: SpatialDetection, t: number, faceBearing: boolean): ObserveOutcome {
    if (t < this.lastSeenAt) return 'stale'
    const dt = t - this.lastSeenAt
    if (dt > 0) {
      const from = centreOf(this.lastBox)
      const to = centreOf(det.bbox)
      this.velocity = { vx: (to.x - from.x) / dt, vy: (to.y - from.y) / dt }
      this.emitIntervalMs = dt
    }
    this.recordConfident(det, t, faceBearing)
    return 'recorded'
  }

  observeLowScore(box: BoundingBox, t: number): void {
    this.assocBox = box
    this.assocAt = t
    this.heldByLowScore = true
  }

  reportedClass(voting: boolean, minFraction: number): string {
    if (!voting) return this.klass
    let total = 0
    let best = this.klass
    let bestWeight = -1
    for (const [cls, w] of this.classVotes) {
      total += w
      if (w > bestWeight) {
        best = cls
        bestWeight = w
      }
    }
    return total > 0 && bestWeight / total >= minFraction ? best : this.klass
  }

  emitVelocity(): EmitVelocity {
    return {
      dx: this.velocity.vx * this.emitIntervalMs,
      dy: this.velocity.vy * this.emitIntervalMs,
    }
  }

  end(t: number, reason: TrackletEndReason): void {
    if (this.endedAt !== null) return
    this.endedAt = t
    this.endReason = reason
  }

  private recordConfident(det: SpatialDetection, t: number, faceBearing: boolean): void {
    this.hits += 1
    this.score = det.score
    this.originalClass = det.originalClass
    this.lastBox = det.bbox
    this.lastSeenAt = t
    this.assocBox = det.bbox
    this.assocAt = t
    this.heldByLowScore = false
    this.lastNativeRecovery = det.nativeRecovery
    this.path.push(det.bbox)
    if (this.path.length > MAX_PATH_LENGTH) this.path.shift()
    this.classVotes.set(det.class, (this.classVotes.get(det.class) ?? 0) + det.score)
    if (det.appearance !== undefined)
      this.appearance = foldAppearance(this.appearance, det.appearance)
    if (faceBearing) {
      this.faceBearing = true
      this.firstFaceAt ??= t
    }
  }
}
