/**
 * The contract every tracker a tape is replayed through implements (D681,
 * spec §5.2) — the production processor under replay (`ProcessorTracker`),
 * the recorded live output (`RecordedTracker`), and the v2 tracker (D683).
 *
 * The replay owns time: `start`, then `control`/`step` once per record in tape
 * order, then `finish`. `skip` and `gap` records are not passed — a tracker
 * sees them only as a jump in `frame.t`. No `Date.now`, `Math.random`, I/O or
 * store: two replays through two fresh instances must hash the same.
 *
 * An online tracker returns `finalised: []` (final id = provisional id). A
 * deferred linker returns a finalisation when it decides, at `t` ≤ the current
 * frame's `t`; the last one for a provisional id wins.
 *
 * A tracker reads the detector's side of a frame and never `frame.live[]` AS
 * AN INPUT TO WHAT IT EMITS: that is the old tracker's recorded answer (only
 * `RecordedTracker` re-emits it as its own output).
 *
 * **One narrow, named exception** (Task 19 fix round 1, M1): a tracker MAY
 * read the `live[]` of frames it has already stepped, but ONLY to resolve an
 * `identity` control record's `trk` (a LIVE id — `tape-schema.ts`'s own
 * comment on `TapeIdentity` says so) to the detection ids that live track
 * bound, so it can re-attach the recognizer's verdict to whatever id or ids
 * IT is tracking that subject under. It may never use `live[]` to decide
 * what to emit — only to interpret a record that names something by an id
 * only `live[]` defines.
 *
 * (Extended by D683 Task 12, M4.) The same exception covers `drop.trk`: a
 * recorded `dropTrack` names a LIVE id too, and a replay that passed it
 * through untranslated dropped nothing — the piece coasted and could be
 * linked where live it never could. A tracker resolves it exactly like an
 * `identity` (the join of the frame at the record's own `t`) and for nothing
 * else. A recorded `fusion` (tape v2) is the live L2's ANSWER: only
 * `RecordedTracker` re-emits it; a tracker under replay recomputes its own.
 */
import type {
  TapeBox,
  TapeControlRecord,
  TapeFrame,
  TapeHeader,
  TapePlane,
} from '../tape-schema.js'

/** `bound`: the output carries a detection of this frame. `coasting`: a
 *  prediction with no detection. `presence`: a stationary subject held at its
 *  anchor with no detection. */
export type TapeTrackOutputKind = 'bound' | 'coasting' | 'presence'

export interface TapeTrackOutput {
  /** Provisional id: the id a live notification would use on this frame. */
  readonly liveId: string
  /** The id of the `TapeDetection` (in `frame.dets`) this output bound on this
   *  frame. Required when `kind === 'bound'`, absent otherwise. */
  readonly detectionId?: string
  /** `[x, y, w, h]` in detection-frame pixels. */
  readonly box: TapeBox
  readonly kind: TapeTrackOutputKind
  /**
   * Emitted AS A TRACK: past the tracker's OWN birth gate (`minHits`, or a
   * confidence bypass) — never the post-analysis confirmation gate (the crop
   * re-detection in `pipeline-analytics/index.ts`) or the notification
   * emitter's age/cooldown gates, neither of which a tape carries (M2, fix
   * round 1). A tape has no way to know a birth the confirmation gate would
   * have suppressed live; `confirmed: true` here says only "the tracker
   * decided this is a track", not "a notification would have fired".
   */
  readonly confirmed: boolean
}

/** A deferred decision: provisional id `provisionalId` is, finally, `finalId`.
 *  `t` is the tape time at which the tracker decided it. */
export interface TapeFinalisation {
  readonly provisionalId: string
  readonly finalId: string
  readonly t: number
}

export interface TapeStepOutput {
  readonly outputs: readonly TapeTrackOutput[]
  readonly finalised: readonly TapeFinalisation[]
}

export interface TapeFinalOutput {
  readonly finalised: readonly TapeFinalisation[]
}

export interface TapeTracker {
  /** Short stable name, printed in reports (`processor`, `recorded`, `v2`, …). */
  readonly name: string
  /** Once, before any record. `header.planes[plane]` holds the recorded
   *  processor inputs, `header.scene` the zones and rules,
   *  `header.stationaryEntries` the registry at the origin. */
  start(header: TapeHeader, plane: TapePlane): void
  /** A `processor`, `scene`, `drop`, `identity` or `fusion` record, in tape
   *  order. Records of another plane are passed too; the tracker ignores them.
   *  An `identity` record (a face-recognizer verdict) and a `drop` record
   *  are keyed by a LIVE id (`trk`) — the two cases where reading `live[]` is
   *  allowed, per the narrow exception above. */
  control(record: TapeControlRecord): void
  /** One `frame` record of the replayed plane, in tape order. */
  step(frame: TapeFrame): TapeStepOutput
  /** After the last record: flush every pending finalisation. */
  finish(endT: number): TapeFinalOutput
}

export type TapeTrackerFactory = () => TapeTracker
