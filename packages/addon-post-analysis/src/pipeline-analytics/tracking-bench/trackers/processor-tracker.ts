/**
 * `processor` — PRODUCTION code under replay, not a re-implementation
 * (spec §5.2): a real `FrameProcessor` built by `createFrameProcessor` from the
 * tape's RECORDED processor inputs, with the recorded gate, the recorded scene,
 * the recorded drops and rebuilds, and a deterministic minter. Whatever tracker
 * `FrameProcessor` contains is what a committed case exercises.
 *
 * D683: that tracker is v2. Its L2 fusions arrive as finalisations, `confirmed`
 * is read off each tracklet's own birth gate, open tails are flushed by
 * `finish`, and the recognizer's recorded verdicts (`identity`) reach the
 * processor exactly as live delivered them — see {@link FrameJoin}.
 */
import type { IScopedLogger } from '@camstack/types'
import { createFrameProcessor } from '../../pipeline/frame-processor-config.js'
import type { FrameProcessor } from '../../pipeline/frame-processor.js'
import { sequentialTrackIdMinter, type TrackIdMinter } from '../../pipeline/track-id.js'
import { LINK_WINDOW_MS } from '../../pipeline/tracker-v2/constants.js'
import { createNoopLogger } from '../no-op-logger.js'
import type {
  TapeControlRecord,
  TapeDrop,
  TapeFrame,
  TapeHeader,
  TapeIdentity,
  TapePlane,
  TapeProcessorInputs,
  TapeScene,
} from '../tape-schema.js'
import { RecordedStationaryGate } from './recorded-stationary-gate.js'
import { toFrameResult, toRules, toZones } from './tape-frame-result.js'
import type {
  TapeFinalOutput,
  TapeStepOutput,
  TapeTracker,
  TapeTrackOutput,
} from './tape-tracker.js'

export interface ProcessorTrackerOptions {
  readonly mintTrackId?: TrackIdMinter
  /** Where an unresolved identity or drop record is reported (once each per tape). */
  readonly logger?: IScopedLogger
}

const NO_OUTPUT: TapeStepOutput = { outputs: [], finalised: [] }

/**
 * One stepped frame's join, for resolving an `identity` or `drop` record
 * (review 2 NH2; `drop` since D683 Task 12, M4).
 * D681 writes detection ids as per-frame ORDINALS (`d0`, `d1`, … reset every
 * frame), so the join is valid on its own frame only: `recordedDetOf` is the
 * RECORDED live binding `trk → det` (`frame.live[]` — read for this and
 * nothing else, the one use D681 permits), `replayIdOfDet` is THIS replay's
 * output id for each ordinal it bound.
 */
interface FrameJoin {
  readonly recordedDetOf: ReadonlyMap<string, string>
  readonly replayIdOfDet: ReadonlyMap<string, string>
}

export class ProcessorTracker implements TapeTracker {
  readonly name = 'processor'
  private readonly mint: TrackIdMinter
  private readonly gate = new RecordedStationaryGate()
  private processor: FrameProcessor | null = null
  private deviceId = 0
  private plane: TapePlane = 'pipeline'
  private scene: TapeScene | null = null
  private readonly logger: IScopedLogger
  /**
   * Frame joins by tape `t`, kept for `LINK_WINDOW_MS` of TAPE time and pruned
   * by `t` — never by a frame count (review 3 R3-H1): the verdict for frame k
   * is recorded after frames k+1 … k+n (the recognizer's second pass runs
   * after awaited crop captures, seconds late under lane pressure), stamped
   * with its own frame's `t`. A verdict older than the link window could not
   * change an L2 decision anyway.
   */
  private readonly frameJoins = new Map<number, FrameJoin>()
  private unresolvedIdentities = 0
  private unresolvedDrops = 0

  constructor(options: ProcessorTrackerOptions = {}) {
    // ONE minter for the whole replay: a rebuilt processor must not re-mint t1.
    this.mint = options.mintTrackId ?? sequentialTrackIdMinter()
    this.logger = options.logger ?? createNoopLogger()
  }

  /** Identity records that named a track which did not bind on their frame (or
   *  whose ordinal this replay did not bind) — never attached elsewhere. */
  get unresolvedIdentityRecords(): number {
    return this.unresolvedIdentities
  }

  /** Drop records that named a track which did not bind on their frame —
   *  never applied to another track (D683 Task 12, M4). */
  get unresolvedDropRecords(): number {
    return this.unresolvedDrops
  }

  start(header: TapeHeader, plane: TapePlane): void {
    this.deviceId = header.deviceId
    this.plane = plane
    this.scene = header.scene
    const inputs = header.planes[plane]
    this.processor = inputs === undefined ? null : this.build(inputs)
  }

  control(record: TapeControlRecord): void {
    switch (record.kind) {
      case 'processor':
        if (record.plane === this.plane) this.processor = this.build(record.inputs)
        return
      case 'scene':
        this.scene = record.scene
        return
      case 'drop':
        if (record.plane === this.plane) this.applyDrop(record)
        return
      case 'identity':
        this.applyIdentity(record)
        return
      // (v2, D683) The live L2's decision: this tracker IS the production
      // processor under replay and recomputes its own fusions.
      case 'fusion':
        return
    }
  }

  /**
   * A recorded `dropTrack` (a registry promotion), in tape order (D683 Task
   * 12, M4). `drop.trk` is a LIVE id, so it is resolved exactly like an
   * identity's — through the join of the frame whose `t` is the record's
   * own `t` (the recorder writes the drop after that frame, at its time) —
   * and the replay's OWN id for that subject is dropped. Passing the live id
   * straight through did nothing: the piece coasted, ended `missed` and could
   * be linked, where live it ended `dropped` and never could. A record that
   * does not resolve is counted and never applied to another track.
   */
  private applyDrop(record: TapeDrop): void {
    const replayId = this.resolveOnItsFrame(record.t, record.trk)
    if (replayId === undefined || this.processor === null) {
      this.unresolvedDrops += 1
      if (this.unresolvedDrops === 1) {
        this.logger.info('replay: drop record did not resolve on its frame — not applied', {
          tags: { deviceId: this.deviceId },
          meta: {
            t: record.t,
            trk: record.trk,
            reason: this.frameJoins.has(record.t) ? 'not-bound-on-frame' : 'frame-not-stepped',
          },
        })
      }
      return
    }
    this.processor.dropTrack(replayId, record.reason)
  }

  /** A live id named by a control record at `t` → this replay's id for the
   *  detection that live track bound on the frame at `t`, if both exist. */
  private resolveOnItsFrame(t: number, trk: string): string | undefined {
    const join = this.frameJoins.get(t)
    const det = join?.recordedDetOf.get(trk)
    return det === undefined ? undefined : join?.replayIdOfDet.get(det)
  }

  /**
   * The recognizer's verdict, in tape order — the order the live processor
   * received `noteTrackIdentity` relative to frames. Resolved ONLY through the
   * join of the frame whose `t` is the record's own `t`; a record that does
   * not resolve is counted and never attached to another track.
   */
  private applyIdentity(record: TapeIdentity): void {
    const replayId = this.resolveOnItsFrame(record.t, record.trk)
    if (replayId === undefined || this.processor === null) {
      this.unresolvedIdentities += 1
      if (this.unresolvedIdentities === 1) {
        this.logger.info('replay: identity record did not resolve on its frame — not applied', {
          tags: { deviceId: this.deviceId },
          meta: {
            t: record.t,
            trk: record.trk,
            reason: this.frameJoins.has(record.t) ? 'not-bound-on-frame' : 'frame-not-stepped',
          },
        })
      }
      return
    }
    this.processor.noteTrackIdentity(replayId, record.fid)
  }

  step(frame: TapeFrame): TapeStepOutput {
    const p = this.processor
    const scene = this.scene
    if (p === null || scene === null || frame.plane !== this.plane) return NO_OUTPUT
    p.setZones(toZones(scene))
    p.setDetectionRules(toRules(scene))
    p.setZoneMembershipMinOverlap(scene.zoneMembershipMinOverlap)
    p.setLowScoreContinuationFloor(scene.lowScoreFloor)
    this.gate.load(frame.gate)
    const result = p.process({
      timestamp: frame.t,
      frame: toFrameResult(frame, this.deviceId),
      observe: true,
    })
    // One lookup per frame, not one per live binding (L2, fix round 1): the
    // O(n²) `result.tracked.find` per binding is harmless at these sizes, but
    // a Map is the honest cost for what is, in effect, a join on `trackId`.
    const trackedById = new Map(result.tracked.map((t) => [t.trackId, t]))
    const outputs: TapeTrackOutput[] = []
    const replayIdOfDet = new Map<string, string>()
    for (const l of result.observation?.live ?? []) {
      const tracked = trackedById.get(l.trackId)
      if (tracked === undefined) continue
      const detectionId = l.matched ? l.detectionId : undefined
      if (detectionId !== undefined) replayIdOfDet.set(detectionId, l.trackId)
      outputs.push({
        liveId: l.trackId,
        ...(detectionId !== undefined ? { detectionId } : {}),
        box: [tracked.bbox.x, tracked.bbox.y, tracked.bbox.w, tracked.bbox.h],
        kind: detectionId !== undefined ? 'bound' : 'coasting',
        // D681's ruling: past the tracker's OWN birth gate, set per tracklet.
        confirmed: tracked.confirmed,
      })
    }
    this.noteFrameJoin(frame, replayIdOfDet)
    return {
      outputs,
      finalised: result.fusions.flatMap((f) =>
        f.members.map((m) => ({ provisionalId: m, finalId: f.survivorId, t: f.t })),
      ),
    }
  }

  /** Open tails at the end of the tape are decided now; each finalisation is
   *  stamped no later than `endT` (the interface's `t ≤` rule, review M13). */
  finish(endT: number): TapeFinalOutput {
    const p = this.processor
    if (p === null) return { finalised: [] }
    return {
      finalised: p.advanceTo(endT + LINK_WINDOW_MS).flatMap((f) =>
        f.members.map((m) => ({
          provisionalId: m,
          finalId: f.survivorId,
          t: Math.min(f.t, endT),
        })),
      ),
    }
  }

  /** Keep this frame's join for identity records (see {@link frameJoins}). */
  private noteFrameJoin(frame: TapeFrame, replayIdOfDet: ReadonlyMap<string, string>): void {
    const recordedDetOf = new Map<string, string>()
    for (const l of frame.live) if (l.det !== undefined) recordedDetOf.set(l.trk, l.det)
    this.frameJoins.set(frame.t, { recordedDetOf, replayIdOfDet })
    for (const t of this.frameJoins.keys()) {
      if (t >= frame.t - LINK_WINDOW_MS) break
      this.frameJoins.delete(t)
    }
  }

  private build(inputs: TapeProcessorInputs): FrameProcessor {
    // Replay reads no wall clock (review 2 L8, D681's determinism rule):
    // `frameNow` is never used here — `finish` advances in frame time.
    const p = createFrameProcessor(this.deviceId, this.plane, inputs, {
      mintTrackId: this.mint,
      wallClock: () => 0,
    })
    p.setStationaryGate(this.gate)
    return p
  }
}
