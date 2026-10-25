/**
 * L1 of tracker v2 (D683 §3): conservative online tracklets. A subject is a
 * tracklet while the detector sees it; stillness is NOT decided here — the
 * parked-object registry promotes a still subject and the processor ends its
 * tracklet `stationary` (spec §5, operator decision 2026-09-30).
 *
 * Order of one frame:
 *   0. `expire(t)` ends what the coast budget no longer covers (review 2 NC1),
 *      and a tracklet unseen past the prediction horizon is demoted to
 *      `coasting` — silence is a miss even when no frame recorded it (review H1);
 *   1. association (Task 4); every ambiguous group ENDS its tracklets and its
 *      detections spawn split pieces — doubt never becomes a guess;
 *   2. kept pairs update their tracklets; double fires are refused at spawn;
 *   3. unassigned confident boxes: the spawn gates, else a birth;
 *   4. sub-floor boxes follow moving person/animal tracklets;
 *   5. unmatched tracklets coast; `expire(t)` again;
 *   6. confirmed tracklets are emitted.
 *
 * `expire(now)` alone is what the close sweep calls on a silent camera (the
 * motion gate stopped the frames, D438): no frame is needed for a coasting
 * tracklet to end.
 */
import type { BoundingBox, SpatialDetection } from '@camstack/types'
import type { TrackIdMinter } from '../track-id.js'
import type { SpawnRefusalReason } from '../tracker/spawn-refusal.js'
import {
  type AmbiguousGroup,
  type AssocDetection,
  type AssocPair,
  type AssocTracklet,
  associate,
  type DoubleFire,
} from './association.js'
import {
  CONTESTED_MAX_MS,
  LINGERING_CLASSES,
  LINK_WINDOW_MS,
  MAX_PREDICTION_MS,
} from './constants.js'
import { iou } from './geometry.js'
import { Tracklet } from './tracklet.js'
import type {
  Lineage,
  TrackDropReason,
  TrackerV2Config,
  TrackerV2FrameContext,
  TrackerV2Observers,
  TrackletEndReason,
} from './types.js'

export interface TrackletEmission {
  readonly tracklet: Tracklet
  readonly detection: SpatialDetection | undefined
  readonly matched: boolean
}

export interface TrackletStepResult {
  readonly emissions: readonly TrackletEmission[]
}

interface SpawnRefusal {
  readonly reason: SpawnRefusalReason
  readonly threshold?: number
  readonly measured?: number
  readonly against?: Tracklet
}

/** What one `step` accumulates while it walks the association. */
interface FrameState {
  readonly t: number
  readonly ctx: TrackerV2FrameContext
  readonly detections: readonly SpatialDetection[]
  readonly contOnly: ReadonlySet<number>
  /** Tracklet id → the box it took this frame (pairs, split pieces, births). */
  readonly bound: Map<string, SpatialDetection>
  /** Detection indices already consumed (pair, split piece or refused double fire). */
  readonly used: Set<number>
  /** Detection index → the tracklet that took it this frame (pair or split piece). */
  readonly taken: Map<number, Tracklet>
}

const NO_INDICES: ReadonlySet<number> = new Set()

export class TrackletTracker {
  private readonly live = new Map<string, Tracklet>()
  private readonly ended: Tracklet[] = []
  private cohortSeq = 0

  constructor(
    private readonly config: TrackerV2Config,
    private readonly mint: TrackIdMinter,
    private readonly observers: TrackerV2Observers = {},
  ) {}

  get(id: string): Tracklet | undefined {
    return this.live.get(id) ?? this.ended.find((t) => t.id === id)
  }

  liveTracklets(): readonly Tracklet[] {
    return [...this.live.values()]
  }

  endedTracklets(): readonly Tracklet[] {
    return this.ended
  }

  /**
   * `dropped`: the registry's legacy call and D681 `drop` records — never linked.
   * `stationary` (round 4): the parked-object registry promoted this subject;
   * the tracklet ends at its LAST SIGHTING, and L2 may link a later piece to it
   * when the subject moves again within the link window (spec §5).
   */
  drop(id: string, t: number, reason: TrackDropReason = 'dropped'): void {
    const tr = this.live.get(id)
    if (tr !== undefined) this.finish(tr, reason === 'stationary' ? tr.lastSeenAt : t, reason)
  }

  /** The FaceRecognizer settled this tracklet's identity, or took it back
   *  (`null`) — C3: kept for L2's cannot-link. */
  noteIdentity(id: string, identity: string | null): void {
    const tr = this.get(id)
    if (tr !== undefined) tr.identity = identity
  }

  /** The confirmation gate refused this birth (review H3): it never links. */
  markSuppressed(id: string): void {
    const tr = this.get(id)
    if (tr !== undefined) tr.suppressed = true
  }

  /** A tracklet unseen past the prediction horizon is `coasting`, frame or no
   *  frame (review H1): it re-binds on its last box and the size bar only. */
  private demoteSilent(t: number): void {
    for (const tr of this.live.values()) {
      if (tr.mode === 'active' && t - tr.lastSeenAt > MAX_PREDICTION_MS) tr.mode = 'coasting'
    }
  }

  /** Ends every live tracklet at its own last sighting (a clock step); the ids it ended. */
  endAll(reason: TrackletEndReason): readonly string[] {
    const ended: string[] = []
    for (const tr of [...this.live.values()]) {
      ended.push(tr.id)
      this.finish(tr, tr.lastSeenAt, reason)
    }
    return ended
  }

  /** Silence: end what the coast budget no longer covers. */
  expire(now: number): void {
    for (const tr of [...this.live.values()]) {
      if (now - tr.lastSeenAt > this.config.maxMissedMs) this.finish(tr, tr.lastSeenAt, 'missed')
    }
  }

  prune(now: number): void {
    for (let i = this.ended.length - 1; i >= 0; i--) {
      const e = this.ended[i]
      if (e !== undefined && e.endedAt !== null && now - e.endedAt > LINK_WINDOW_MS)
        this.ended.splice(i, 1)
    }
  }

  step(
    detections: readonly SpatialDetection[],
    t: number,
    ctx: TrackerV2FrameContext,
  ): TrackletStepResult {
    // 0. End what the coast budget no longer covers BEFORE associating (review 2
    //    NC1): a tracklet silent past `maxMissedMs` must never bind this frame's
    //    box — that is the 101 identity theft, and live (where the 5 s sweep may
    //    already have expired it) and replay (no sweep) must decide the same.
    this.expire(t)
    this.demoteSilent(t)
    const frame: FrameState = {
      t,
      ctx,
      detections,
      contOnly: ctx.continuationOnly ?? NO_INDICES,
      bound: new Map(),
      used: new Set(),
      taken: new Map(),
    }
    const liveList = [...this.live.values()]
    const assoc = associate(
      liveList.map((tr) => this.toAssoc(tr, t)),
      detections.map((d, i) => this.toAssocDetection(d, frame.contOnly.has(i))),
      this.config,
    )
    // 1. Doubt → split.
    for (const group of assoc.ambiguous) this.splitGroup(group, liveList, frame)
    // 2. Kept pairs, then double fires.
    for (const pair of assoc.pairs) this.bindPair(pair, liveList, frame)
    for (const fire of assoc.doubleFires) this.refuseDoubleFire(fire, liveList, frame)
    // 3. Unassigned confident boxes.
    this.spawnUnassigned(frame)
    // 4. Sub-floor boxes follow moving person/animal tracklets.
    if (this.config.lowScoreContinuationEnabled)
      this.followWithLowScore(ctx.lowScore ?? [], detections, frame.bound, t)
    // 5. Unmatched tracklets coast, then expire.
    for (const tr of this.live.values()) {
      if (!frame.bound.has(tr.id) && tr.mode === 'active') tr.mode = 'coasting'
    }
    this.expire(t)
    // 6. Emissions.
    return { emissions: this.emissions(frame.bound) }
  }

  /** Confirmed tracklets only; `matched` = bound this frame (a sighting). */
  private emissions(bound: ReadonlyMap<string, SpatialDetection>): TrackletEmission[] {
    const out: TrackletEmission[] = []
    for (const tr of this.live.values()) {
      if (!tr.confirmed) continue
      out.push({ tracklet: tr, detection: bound.get(tr.id), matched: bound.has(tr.id) })
    }
    return out
  }

  /** Every tracklet of an ambiguous group ENDS; its detections spawn split pieces
   *  of one cohort, born in doubt — doubt never becomes a guess (O2). */
  private splitGroup(
    group: AmbiguousGroup,
    liveList: readonly Tracklet[],
    frame: FrameState,
  ): void {
    const parents = group.tracklets
      .map((i) => liveList[i])
      .filter((p): p is Tracklet => p !== undefined)
    for (const p of parents) this.finish(p, p.lastSeenAt, 'ambiguous')
    this.cohortSeq += 1
    const cohort = `c${this.cohortSeq}`
    const lineage: Lineage = { kind: 'split', from: parents.map((p) => p.id) }
    const born: string[] = []
    const refused: BoundingBox[] = []
    for (const j of group.detections) {
      frame.used.add(j)
      const d = frame.detections[j]
      if (d === undefined) continue
      if (frame.contOnly.has(j)) {
        // Refused AGAINST the group (D391): not the line of a box nobody claimed.
        const against = parents[0]
        this.refuse({ reason: 'stationary-hold', ...(against !== undefined ? { against } : {}) }, d)
        refused.push(d.bbox)
        continue
      }
      const piece = this.spawn(d, frame.t, lineage, cohort, true, frame.ctx)
      frame.bound.set(piece.id, d)
      frame.taken.set(j, piece)
      born.push(piece.id)
    }
    this.observers.split?.({
      t: frame.t,
      ended: parents.map((p) => p.id),
      born,
      refused,
      tests: group.tests,
    })
  }

  private bindPair(pair: AssocPair, liveList: readonly Tracklet[], frame: FrameState): void {
    const tr = liveList[pair.tracklet]
    const d = frame.detections[pair.detection]
    if (tr === undefined || d === undefined) return
    frame.used.add(pair.detection)
    // Belt and braces (F1): `TrackerV2.update` never hands L1 a frame older
    // than the last one, so a stale sighting can only come from a direct caller.
    // It binds nothing and is not emitted — its box may be another subject's.
    if (tr.observeConfident(d, frame.t, frame.ctx.faceBearing?.has(d.bbox) === true) === 'stale')
      return
    tr.mode = 'active'
    if (d.class !== tr.klass) this.refuse({ reason: 'cross-class-absorbed', against: tr }, d)
    if (pair.contested) {
      tr.contestedHits += 1
      tr.contestedSince ??= frame.t
    } else {
      tr.inDoubt = false
    }
    this.confirmIfDue(tr, frame.t)
    frame.bound.set(tr.id, d)
    frame.taken.set(pair.detection, tr)
  }

  /** A second box on one subject is refused, never split (review M1). */
  private refuseDoubleFire(
    fire: DoubleFire,
    liveList: readonly Tracklet[],
    frame: FrameState,
  ): void {
    frame.used.add(fire.detection)
    const d = frame.detections[fire.detection]
    // Against whoever took the duplicated box — a split piece when the pair was
    // split this frame, never the parent that just ended (review L2).
    const against = frame.taken.get(fire.chosen) ?? liveList[fire.tracklet]
    if (d !== undefined)
      this.refuse(
        {
          reason: 'dedup-iou',
          threshold: this.config.dedupSpawnIou,
          ...(against !== undefined ? { against } : {}),
        },
        d,
      )
  }

  /** Boxes association gave to nobody: the spawn gates, else a birth. */
  private spawnUnassigned(frame: FrameState): void {
    for (const [j, d] of frame.detections.entries()) {
      if (frame.used.has(j)) continue
      if (frame.contOnly.has(j)) {
        this.refuse({ reason: 'stationary-hold' }, d)
        continue
      }
      const refusal = this.spawnRefusal(d, frame.bound, frame.ctx)
      if (refusal !== null) {
        this.refuse(refusal, d)
        continue
      }
      const born = this.spawn(d, frame.t, { kind: 'birth' }, null, false, frame.ctx)
      frame.bound.set(born.id, d)
    }
  }

  private toAssoc(tr: Tracklet, t: number): AssocTracklet {
    return {
      id: tr.id,
      klass: tr.klass,
      mode: tr.mode,
      confirmed: tr.confirmed,
      inDoubt: tr.inDoubt,
      cohort: tr.cohort,
      lastBox: tr.lastBox,
      predicted: this.config.predictiveCoasting ? tr.predicted(t) : tr.assocBox,
      appearance: tr.appearance,
    }
  }

  private toAssocDetection(d: SpatialDetection, continuationOnly: boolean): AssocDetection {
    return {
      klass: d.class,
      score: d.score,
      bbox: d.bbox,
      nativeRecovery: d.nativeRecovery !== undefined,
      continuationOnly,
      ...(d.appearance !== undefined ? { appearance: d.appearance } : {}),
    }
  }

  private spawn(
    d: SpatialDetection,
    t: number,
    lineage: Lineage,
    cohort: string | null,
    contested: boolean,
    ctx: TrackerV2FrameContext,
  ): Tracklet {
    const tr = new Tracklet({
      id: this.mint(),
      startedAt: t,
      det: d,
      lineage,
      cohort,
      faceBearing: ctx.faceBearing?.has(d.bbox) === true,
    })
    if (contested) {
      // Born in doubt: this hit could be either subject's. Set BEFORE confirmation (review M14).
      tr.contestedHits = 1
      tr.contestedSince = t
      tr.inDoubt = true
    }
    this.confirmIfDue(tr, t)
    this.live.set(tr.id, tr)
    return tr
  }

  private confirmIfDue(tr: Tracklet, t: number): void {
    if (tr.confirmed) return
    const uncontested = tr.hits - tr.contestedHits
    const bypass =
      this.config.confirmBypassEnabled &&
      tr.score >= this.config.confirmBypassScore &&
      tr.contestedHits === 0
    // A doubt older than CONTESTED_MAX_MS no longer withholds the subject (review H9).
    const doubtExpired =
      tr.contestedSince !== null &&
      t - tr.contestedSince >= CONTESTED_MAX_MS &&
      tr.hits >= this.config.minHits
    if (uncontested >= this.config.minHits || bypass || doubtExpired) tr.confirmed = true
  }

  private finish(tr: Tracklet, at: number, reason: TrackletEndReason): void {
    if (!this.live.delete(tr.id)) return
    tr.end(at, reason)
    this.ended.push(tr)
    this.observers.ended?.({
      trackletId: tr.id,
      reason,
      at,
      confirmed: tr.confirmed,
      hits: tr.hits,
      className: tr.klass,
    })
    // A split parent's boxes went to its pieces, or are reported on the split
    // facts as `refused` (review M1); a `stationary` end hands the subject to
    // the occupancy registry (review L1). Neither is a lost spawn (review L10).
    if (!tr.confirmed && reason !== 'ambiguous' && reason !== 'stationary') {
      this.observers.refusal?.({
        reason: 'unconfirmed-spawn-lost',
        detClass: tr.klass,
        detScore: tr.score,
        bbox: tr.lastBox,
        droppedTrackId: tr.id,
        trackLifeMs: tr.lastSeenAt - tr.startedAt,
        ...(tr.lastNativeRecovery !== undefined
          ? { nativeRecoveryScore: tr.lastNativeRecovery.score }
          : {}),
      })
    }
  }

  private refuse(refusal: SpawnRefusal, d: SpatialDetection): void {
    this.observers.refusal?.({
      reason: refusal.reason,
      detClass: d.class,
      detScore: d.score,
      bbox: d.bbox,
      ...(d.nativeRecovery !== undefined ? { nativeRecoveryScore: d.nativeRecovery.score } : {}),
      ...(refusal.threshold !== undefined ? { threshold: refusal.threshold } : {}),
      ...(refusal.measured !== undefined ? { measured: refusal.measured } : {}),
      ...(refusal.against !== undefined
        ? { againstTrackId: refusal.against.id, againstTrackClass: refusal.against.klass }
        : {}),
    })
  }

  /** Spawn gates. A double fire is judged against tracklets BOUND THIS FRAME only:
   *  a coasting ghost must not refuse a returning or different subject. */
  private spawnRefusal(
    d: SpatialDetection,
    bound: ReadonlyMap<string, SpatialDetection>,
    ctx: TrackerV2FrameContext,
  ): SpawnRefusal | null {
    const cfg = this.config
    const floor = cfg.perClassMinScoreEnabled ? cfg.classMinScores[d.class] : undefined
    if (floor !== undefined && d.nativeRecovery === undefined && d.score < floor)
      return { reason: 'score-floor', threshold: floor, measured: d.score }
    const areaFloor = cfg.minSpawnAreaEnabled ? cfg.classSpawnAreaFracs[d.class] : undefined
    if (areaFloor !== undefined && ctx.frameWidth > 0 && ctx.frameHeight > 0) {
      const frac = (d.bbox.w * d.bbox.h) / (ctx.frameWidth * ctx.frameHeight)
      if (frac < areaFloor) return { reason: 'area-floor', threshold: areaFloor, measured: frac }
    }
    for (const tr of this.live.values()) {
      const boundBox = bound.get(tr.id)?.bbox
      if (boundBox === undefined) continue
      const overlap = iou(boundBox, d.bbox)
      if (
        cfg.personAnimalDedup &&
        d.class === 'animal' &&
        tr.klass === 'person' &&
        d.score < cfg.animalOverPersonMaxScore &&
        overlap >= cfg.animalOverPersonIou
      ) {
        return {
          reason: 'animal-over-person',
          threshold: cfg.animalOverPersonIou,
          measured: overlap,
          against: tr,
        }
      }
      const compatible =
        tr.klass === d.class ||
        (cfg.personAnimalDedup &&
          ((tr.klass === 'person' && d.class === 'animal') ||
            (tr.klass === 'animal' && d.class === 'person')))
      if (cfg.dedupEnabled && compatible && overlap >= cfg.dedupSpawnIou)
        return { reason: 'dedup-iou', threshold: cfg.dedupSpawnIou, measured: overlap, against: tr }
    }
    return null
  }

  private followWithLowScore(
    low: readonly SpatialDetection[],
    confident: readonly SpatialDetection[],
    bound: ReadonlyMap<string, SpatialDetection>,
    t: number,
  ): void {
    const taken = new Set<string>()
    for (const box of low) {
      if (confident.some((c) => iou(c.bbox, box.bbox) >= this.config.lowScoreIouThreshold)) continue
      let best: Tracklet | undefined
      let bestOverlap = 0
      for (const tr of this.live.values()) {
        if (!tr.confirmed || bound.has(tr.id) || taken.has(tr.id)) continue
        if (tr.klass !== box.class || !LINGERING_CLASSES.has(tr.klass)) continue
        const overlap = iou(tr.predicted(t), box.bbox)
        if (overlap >= this.config.lowScoreIouThreshold && overlap > bestOverlap) {
          best = tr
          bestOverlap = overlap
        }
      }
      if (best === undefined) continue
      taken.add(best.id)
      best.observeLowScore(box.bbox, t)
    }
  }
}
