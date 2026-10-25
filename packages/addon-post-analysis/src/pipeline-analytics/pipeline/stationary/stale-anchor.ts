/**
 * When a WEAK reading keeps saying the same thing, the anchor is what is wrong.
 *
 * The registry's two anchoring rules are sound on their own: a STRONG read
 * (IoU ≥ `suppressIou`) is the parked object unmoved and re-anchors the entry;
 * a WEAK hold merely overlaps the spot — a swallow, a jitter, a departing box —
 * so it confirms and never re-anchors. Letting a weak box move the anchor would
 * let a passing lorry drag a parked car's reference across the frame.
 *
 * It has one failure mode, and device 102 sat in it for eight and a half hours.
 * Entry `02e6bf01` was anchored, at promotion, on its source track's last box:
 * **406x1103**. The car's real reading is **399x814** — same object, same
 * place, a box inflated by a merged frame. IoU ≈ 0.58 against a `suppressIou`
 * of 0.60. Two hundredths.
 *
 * So every reading of that car is weak. For ever. And "a weak hold never
 * re-anchors" means nothing can ever correct it:
 *
 *  - the entry never suppresses STRONGLY, so the car's own re-detections keep
 *    reaching the tracker and minting a track a minute;
 *  - worse, a weak hold is CONTINUABLE, so a passer-by's coasting track latches
 *    onto the parked car's box, its velocity drops below the still threshold,
 *    and the predicted box freezes there. Measured over 12 h: 18 198 weak holds
 *    on 102 of which **1 330 were consumed by a confirmed track**, against
 *    **0** on a healthy camera. Four moving vehicles were provably captured
 *    this way, each sitting 33-35 s of its 35-38 s life on the parked car's box.
 *
 * The rule here is the narrowest thing that breaks the deadlock: a weak box
 * that is seen AGAIN, in the SAME PLACE, for long enough, stops being evidence
 * about the anchor's neighbourhood and becomes evidence about the anchor. One
 * lorry passing does not qualify — it moves. A wrong anchor does, because the
 * object under it never does.
 *
 * Deliberately NOT a widening of `suppressIou`: that dial decides what counts
 * as the same object everywhere, on every camera, and loosening it to rescue a
 * bad anchor would loosen every suppression on the fleet. This corrects ONE
 * entry, from its own repeated readings, and leaves the dial alone.
 */

import { iou } from './stationary-match.js'
import type { StationaryBbox } from './stationary-types.js'

/**
 * How much the repeated box must still OVERLAP the anchor it is correcting.
 *
 * The time bound alone is not enough, and the first hour in production proved
 * it: on `Camera studio` a `person` entry of 236x568 was re-anchored onto
 * a 1094x1406 box — eleven times the area, IoU 0.087. That is not an anchor
 * that is slightly wrong, it is a different object standing in front of the
 * entry long enough to steal it. The rule this replaces refused exactly that,
 * by never letting a weak read anchor at all.
 *
 * So the correction is bounded at BOTH ends. Above `suppressIou` (0.60) a read
 * already re-anchors on the spot and needs none of this. Below this floor the
 * two boxes are not the same object and no amount of patience makes them one.
 * 0.45 sits between: it admits 102's 0.58 — the two-hundredths case this exists
 * for — and refuses the 0.087 that broke the studio.
 */
export const STALE_ANCHOR_MIN_IOU = 0.45

/**
 * How long the same weak box must keep being seen before it may re-anchor.
 *
 * OBSERVED time, never wall clock: an on-motion camera is dark between
 * sessions and a run measured against the wall would re-anchor on the first
 * reading after a gap (D501 is the same lesson from the retirement side).
 *
 * Thirty seconds. A session on the affected cameras runs ~35 s, so a genuine
 * bad anchor is corrected within its first session; nothing that merely
 * crosses the spot survives a quarter of it.
 */
export const STALE_ANCHOR_MIN_OBSERVED_MS = 30_000

/**
 * How far a box's centre may drift and still count as "the same place".
 *
 * Relative to the box's own diagonal, with an absolute floor. An absolute
 * threshold alone cannot serve both a 399x814 car and a 2779x1572 SUV — the
 * same 8 px is a fifth of a person's width and a rounding error on the SUV. It
 * is the reasoning of D394 and D400: the measure is rated against the subject.
 */
const STALE_ANCHOR_MAX_DRIFT_FRAC = 0.01
const STALE_ANCHOR_MIN_DRIFT_PX = 4

/** What is remembered about one entry's repeated weak reading. */
export interface WeakRun {
  readonly bbox: StationaryBbox
  /** Observed-clock instant the run began. */
  readonly since: number
  /** How many readings have agreed so far. Diagnostic; the decision is time. */
  readonly seen: number
}

export type StaleAnchorStep =
  /** The run continues (or begins). Nothing is re-anchored yet. */
  | { readonly kind: 'hold'; readonly run: WeakRun }
  /** The reading moved: whatever this is, it is not a still object under a bad
   *  anchor. The run is dropped rather than decayed — a box that moved once has
   *  disproved the whole argument. */
  | { readonly kind: 'reset' }
  /** Long enough, in the same place: the anchor is wrong and this is the box. */
  | { readonly kind: 'reanchor'; readonly bbox: StationaryBbox }

function centre(b: StationaryBbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

function driftAllowance(b: StationaryBbox): number {
  const diagonal = Math.hypot(b.w, b.h)
  return Math.max(STALE_ANCHOR_MIN_DRIFT_PX, diagonal * STALE_ANCHOR_MAX_DRIFT_FRAC)
}

/**
 * Fold one weak reading into an entry's run.
 *
 * Pure: the caller owns the memory and the observed clock. `previous` absent
 * starts a run — which can never itself re-anchor, because a single reading is
 * exactly what this rule refuses to act on.
 */
export function stepStaleAnchor(
  previous: WeakRun | undefined,
  bbox: StationaryBbox,
  observedAt: number,
  minObservedMs: number = STALE_ANCHOR_MIN_OBSERVED_MS,
  /** The entry's current reference box — what this correction would replace.
   *  Absent keeps the old behaviour for callers that have no anchor to check
   *  against, which is only the unit tests of the run itself. */
  anchor?: StationaryBbox,
): StaleAnchorStep {
  // Too far from the anchor to BE the anchor's object. A box this different is
  // something else standing on the spot, and patience must not turn it into a
  // correction — see {@link STALE_ANCHOR_MIN_IOU}.
  if (anchor !== undefined && iou(anchor, bbox) < STALE_ANCHOR_MIN_IOU) {
    return { kind: 'reset' }
  }
  if (previous === undefined) {
    return { kind: 'hold', run: { bbox: { ...bbox }, since: observedAt, seen: 1 } }
  }
  const a = centre(previous.bbox)
  const b = centre(bbox)
  if (Math.hypot(a.x - b.x, a.y - b.y) > driftAllowance(previous.bbox)) {
    return { kind: 'reset' }
  }
  // A clock that went backwards is not evidence of duration. Treat it as the
  // start of a run rather than as a long one.
  const heldMs = observedAt - previous.since
  if (heldMs >= minObservedMs) {
    return { kind: 'reanchor', bbox: { ...bbox } }
  }
  return {
    kind: 'hold',
    run: { bbox: previous.bbox, since: previous.since, seen: previous.seen + 1 },
  }
}
