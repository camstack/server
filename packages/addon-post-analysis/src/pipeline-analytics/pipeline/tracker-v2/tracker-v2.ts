/**
 * Tracker v2 (D683): L1 tracklets + L2 linker behind one object, the
 * `FrameProcessor`'s only tracker. Emitted ids are always chain roots — the
 * one choke point where a provisional id becomes the definitive one (§6.1).
 *
 * The facade owns the linker's two obligations: every `link` hands L2 EVERY
 * piece L1 still holds, live ones included, each with its current
 * `lastSeenAt` (concurrency and a coasting predecessor's re-bind are read from
 * it); and both layers are pruned on every step, since an L2 step is O(n²) in
 * the pieces it holds.
 */
import type { SpatialDetection } from '@camstack/types'
import type { TrackIdMinter } from '../track-id.js'
import { CLOCK_STEP_CONFIRM_FRAMES, LINK_MAX_GAP_MS } from './constants.js'
import { DeferredLinker, type LinkPiece } from './linker.js'
import { type TrackletEmission, TrackletTracker } from './tracklet-tracker.js'
import type { Tracklet } from './tracklet.js'
import type {
  FrameOrder,
  Lineage,
  TrackDropReason,
  TrackerV2Config,
  TrackerV2Emission,
  TrackerV2FrameContext,
  TrackerV2Observers,
  TrackFusion,
} from './types.js'

export interface TrackerV2Deps {
  readonly mintTrackId: TrackIdMinter
  readonly observers?: TrackerV2Observers
}

export class TrackerV2 {
  private readonly l1: TrackletTracker
  private readonly l2: DeferredLinker
  private pending: TrackFusion[] = []
  /**
   * Internal time = the caller's frame time + `offset`. Zero until a clock
   * step; each step moves it so the internal clock never goes back and
   * resumes past `LINK_MAX_GAP_MS` of silence (fix round 2, C1). L1, L2, their
   * facts and prunes run on internal time; fusions and `frameClock()` are
   * handed back in the caller's clock.
   */
  private offset = 0
  private lastT = 0
  /** The latest FRAME time taken (internal) — never the sweep's extrapolated `now`. */
  private lastFrameT = Number.NEGATIVE_INFINITY
  private readonly observers: TrackerV2Observers
  /** Caller times of the consecutive frames past the stale bound so far — the
   *  run a clock step needs `CLOCK_STEP_CONFIRM_FRAMES` of (fix round 3). */
  private stepRun: number[] = []

  constructor(
    private readonly config: TrackerV2Config,
    deps: TrackerV2Deps,
  ) {
    this.observers = deps.observers ?? {}
    // L1 and L2 report on the internal clock; their facts leave in the
    // caller's (fix round 3, LOW-6) — log lines are correlated across a step.
    const out = this.observers
    const internal: TrackerV2Observers = {
      ...(out.refusal !== undefined ? { refusal: out.refusal } : {}),
      ended: (f) => out.ended?.({ ...f, at: f.at - this.offset }),
      split: (f) => out.split?.({ ...f, t: f.t - this.offset }),
    }
    this.l1 = new TrackletTracker(config, deps.mintTrackId, internal)
    this.l2 = new DeferredLinker(
      {
        maxMissedMs: config.maxMissedMs,
        appearanceResolvesAmbiguity: config.appearanceResolvesAmbiguity,
      },
      (f) => out.link?.({ ...f, t: f.t - this.offset }),
    )
  }

  update(
    detections: readonly SpatialDetection[],
    frameT: number,
    ctx: TrackerV2FrameContext,
  ): readonly TrackerV2Emission[] {
    const order = this.classifyFrame(frameT)
    if (order === 'out-of-order') return this.drop(frameT, detections.length)
    let t = frameT + this.offset
    if (order === 'clock-step') t = this.clockStep(frameT, this.lastFrameT - t)
    this.stepRun = []
    this.lastFrameT = t
    this.lastT = Math.max(this.lastT, t)
    const step = this.l1.step(detections, t, ctx)
    // L2 and both prunes run on the latest time seen, never backwards (review
    // L2): a frame stamped before an earlier `advance(now)` must not re-open
    // what that sweep already decided or pruned.
    this.link(this.lastT)
    return step.emissions.map((e) => this.emit(e, t))
  }

  /**
   * A frame stamped before the latest one already taken (follow-up 102, F1;
   * ~1 % of frames, up to 1.2 s back). It is decided ONCE, for the whole
   * frame (fix round 1, H1): matched against the tracklets' NEWEST boxes, a
   * stale box can land on another subject — a walker's old box on the walker
   * behind — and be emitted under that id. So nothing binds, spawns, splits or
   * is demoted on it; the confirmed tracklets are emitted as on a frame that
   * matched nothing (no sighting), and one fact says the frame was dropped.
   */
  /**
   * How `update` will take a frame at `frameT` — without taking it. The
   * processor asks first (fix round 3, MEDIUM-2), so a dropped frame never
   * reaches the stationary gate, the zones or the event path.
   *  - `in-order`: not behind the latest frame taken;
   *  - `out-of-order`: behind it — within `maxMissedMs` (disorder, ≤ 1.2 s
   *    measured), or further back but not yet the `CLOCK_STEP_CONFIRM_FRAMES`-th
   *    such frame in a row;
   *  - `clock-step`: the K-th consecutive frame past the bound, each in order
   *    with the one before (within `maxMissedMs`).
   */
  classifyFrame(frameT: number): FrameOrder {
    const behindMs = this.lastFrameT - (frameT + this.offset)
    if (!(behindMs > 0)) return 'in-order'
    if (behindMs <= this.config.maxMissedMs) return 'out-of-order'
    return this.runLength(frameT) >= CLOCK_STEP_CONFIRM_FRAMES ? 'clock-step' : 'out-of-order'
  }

  /** The past-bound run this frame would make, itself included. */
  private runLength(frameT: number): number {
    const prev = this.stepRun.at(-1)
    const continues =
      prev !== undefined && frameT >= prev && frameT - prev <= this.config.maxMissedMs
    return (continues ? this.stepRun.length : 0) + 1
  }

  /**
   * Drops a frame `classifyFrame` called `out-of-order`. A frame past the
   * bound extends (or restarts) the run a clock step needs; any other breaks
   * it. One fact per frame.
   */
  drop(frameT: number, detections: number): TrackerV2Emission[] {
    const behindMs = this.lastFrameT - (frameT + this.offset)
    let pendingClockStep = 0
    if (behindMs > this.config.maxMissedMs) {
      pendingClockStep = this.runLength(frameT)
      this.stepRun = pendingClockStep === 1 ? [frameT] : [...this.stepRun, frameT]
    } else {
      this.stepRun = []
    }
    this.observers.outOfOrder?.({
      t: frameT,
      lastFrameT: this.frameClock(),
      behindMs,
      detections,
      pendingClockStep,
    })
    return this.l1
      .liveTracklets()
      .filter((tr) => tr.confirmed)
      .map((tracklet) =>
        this.emit({ tracklet, detection: undefined, matched: false }, this.lastFrameT),
      )
  }

  /**
   * The frame clock stepped back further than `maxMissedMs` (fix round 2, C1):
   * not disorder — an NTP correction, or a camera moved to a runner whose clock
   * is behind. An unbounded gate dropped every frame until the new clock passed
   * the old high mark (60 s back: 461 frames, a new subject never tracked, the
   * departed one coasting on). Instead: commit what L2 has decided, end every
   * live tracklet at its own last sighting, decide every piece still undecided
   * `new` (no fusion crosses the step), and resume the internal clock past
   * `LINK_MAX_GAP_MS` of silence, so nothing later can continue anything
   * earlier. Returns the frame's internal time.
   */
  private clockStep(frameT: number, behindMs: number): number {
    const lastFrameT = this.frameClock()
    this.link(this.lastT)
    const ended = this.l1.endAll('clock-step')
    this.l2.closeUndecided(this.lastT, this.pieces())
    const resumeAt = Math.max(this.lastT, this.lastFrameT) + LINK_MAX_GAP_MS + 1
    this.offset = resumeAt - frameT
    this.lastT = resumeAt
    this.observers.clockStep?.({ t: frameT, lastFrameT, behindMs, ended })
    return resumeAt
  }

  /** The latest frame time taken, in the caller's clock (rebased by a clock step). */
  frameClock(): number {
    return this.lastFrameT - this.offset
  }

  /**
   * The close sweep's entry on a camera whose frames stopped (D438): end the
   * tracklets the coast budget no longer covers, THEN run L2 (review C2).
   * `now` is FRAME time (the processor converts wall clock, Task 11).
   */
  advance(frameNow: number): void {
    const now = frameNow + this.offset
    this.lastT = Math.max(this.lastT, now)
    this.l1.expire(now)
    this.link(now)
  }

  /** The FaceRecognizer settled an identity for this track, or retracted it
   *  (`null`) — C3: every live member takes it; a chain with none, its latest. */
  noteIdentity(id: string, identity: string | null): void {
    const members = this.l2.membersOf(this.l2.rootOf(id))
    const live = members.filter((m) => this.isLiveTracklet(m))
    for (const m of live.length > 0 ? live : members.slice(-1)) this.l1.noteIdentity(m, identity)
  }

  /** The confirmation gate refused this birth (review H3): it never links. */
  markSuppressed(id: string): void {
    this.l1.markSuppressed(id)
  }

  /** In the caller's clock (translated when each was committed, LOW-5). */
  drainFusions(): readonly TrackFusion[] {
    const out = this.pending
    this.pending = []
    return out
  }

  rootOf(id: string): string {
    return this.l2.rootOf(id)
  }

  /** A root is live while any member of its chain is a live tracklet (§4.5). */
  isLive(id: string): boolean {
    return this.l2.membersOf(this.l2.rootOf(id)).some((m) => this.isLiveTracklet(m))
  }

  isTailFinal(id: string, frameNow: number): boolean {
    return this.l2.isTailFinal(id, frameNow + this.offset, (m) => this.isLiveTracklet(m))
  }

  /**
   * Ends every live member of the chain. `stationary` (round 4): the
   * parked-object registry promoted a subject that MOVED — it ends at its last
   * sighting and a later piece may still be linked to it (spec §5). `dropped`
   * (the processor's own drop, a refused fusion, a never-moved disposal) is
   * never linked.
   */
  dropTrack(id: string, reason: TrackDropReason = 'dropped'): void {
    for (const m of this.l2.membersOf(this.l2.rootOf(id))) this.l1.drop(m, this.lastT, reason)
  }

  private isLiveTracklet(id: string): boolean {
    const tr = this.l1.get(id)
    return tr !== undefined && tr.endedAt === null
  }

  private pieces(): readonly LinkPiece[] {
    return [...this.l1.liveTracklets(), ...this.l1.endedTracklets()].map(toPiece)
  }

  private link(now: number): void {
    // Translated on the clock it was committed under (fix round 3, LOW-5): a
    // fusion still queued when a step moves the offset keeps its own time.
    const offset = this.offset
    for (const f of this.l2.step(now, this.pieces())) this.pending.push({ ...f, t: f.t - offset })
    this.l1.prune(now)
    this.l2.prune(now)
  }

  private emit(e: TrackletEmission, t: number): TrackerV2Emission {
    const tr = e.tracklet
    // A sighting carries the detection's own box (the processor's side tables
    // key on it); a coasting frame carries the last confident box.
    const bbox = e.matched && e.detection !== undefined ? e.detection.bbox : tr.lastBox
    return {
      class: tr.reportedClass(this.config.classVotingEnabled, this.config.classVoteMinFraction),
      originalClass: tr.originalClass,
      score: tr.score,
      bbox,
      trackId: this.l2.rootOf(tr.id),
      trackAge: tr.hits,
      velocity: tr.emitVelocity(),
      path: [...tr.path],
      matchedThisFrame: e.matched,
      lineage: this.resolveLineage(tr.lineage),
      ...(e.matched && e.detection?.appearance !== undefined
        ? { appearance: e.detection.appearance }
        : {}),
      // D681: past the tracker's OWN birth gate, per tracklet. L1 emits only
      // confirmed tracklets, so this is true on every emission today — carried
      // explicitly so `ProcessorTracker` reads it instead of assuming it.
      confirmed: tr.confirmed,
      ...(heldThisFrame(e, t) ? { heldByLowScore: true as const } : {}),
    }
  }

  private resolveLineage(lineage: Lineage): Lineage {
    return lineage.kind === 'birth'
      ? lineage
      : { kind: 'split', from: lineage.from.map((f) => this.l2.rootOf(f)) }
  }
}

/**
 * A sub-floor box held the tracklet on THIS frame. `Tracklet.heldByLowScore`
 * is sticky until the next confident box (a coast after the hold still reads
 * `true`); the frame's association time is what says this frame's box did it.
 */
function heldThisFrame(e: TrackletEmission, t: number): boolean {
  return !e.matched && e.tracklet.heldByLowScore && e.tracklet.assocAt === t
}

function toPiece(tr: Tracklet): LinkPiece {
  return {
    id: tr.id,
    klass: tr.klass,
    startedAt: tr.startedAt,
    lastSeenAt: tr.lastSeenAt,
    endedAt: tr.endedAt,
    endReason: tr.endReason,
    confirmed: tr.confirmed && !tr.suppressed,
    contested: tr.contestedHits > 0,
    faceBearing: tr.faceBearing,
    firstFaceAt: tr.firstFaceAt,
    identity: tr.identity,
    firstBox: tr.firstBox,
    lastBox: tr.lastBox,
    appearance: tr.appearance,
    lineage: tr.lineage,
  }
}
