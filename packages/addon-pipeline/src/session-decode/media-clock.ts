/**
 * WHEN a decoded frame was actually shot — the only clock a pre-roll frame can
 * honestly carry.
 *
 * Everything else in this path stamps `Date.now()`: `FrameSlot.publish` is
 * handed `Date.now()` by the worker, and `toDecodedFrame` sets
 * `capturedAt: Date.now()`. For a LIVE frame that is right to within the decode
 * latency, and it is why `frameAge` (a wall-clock diff) means anything at all.
 *
 * For a frame reconstructed out of the restreamer's retained history it is
 * wrong by the width of the pre-roll — up to `PREBUFFER_MAX_MS`. A detection
 * carrying it would date a track's `firstSeen`, its positions, its media and
 * the notification's instant at SESSION OPEN rather than at the moment the
 * subject was there. That is a worse failure than the late birth this whole
 * change exists to fix, because a wrong timestamp is silent: nothing downstream
 * can tell it from a right one.
 *
 * So the pre-roll gets a real clock, anchored ONCE per session:
 *
 *   the first frame the decoder produces is `preRollMs` old,
 *   and every later frame is that anchor plus its own pts delta.
 *
 * `preRollMs` is the SERVED span — how much history the restreamer actually
 * delivered — and the caller must pass 0 when it does not know it.
 *
 * It used to be what the dial ASKED for (`preRollRequestOf`, read off the url),
 * on the argument that the realized span is the restreamer's own number,
 * possibly from another process, and an anchor that waits for a cross-process
 * fact is not there when the first frame arrives. The clamp below, the argument
 * went, would turn an over-ask into "no older than the pre-roll window".
 *
 * MEASURED 2026-09-09, and the argument was wrong. The dial asks for 15 000 ms;
 * the broker served 1 270–6 391 ms on 18 consecutive bursts. The clamp only
 * stops a frame landing in the FUTURE — it does nothing about a frame dated too
 * OLD. So every frame of every session was back-dated by the difference:
 * `pipeline stats` reported `frameAge.avg` of 10.0–15.0 s across three nodes
 * and twelve cameras, against a 5 ms baseline before the change.
 *
 * A wrong timestamp is silent — nothing downstream can tell it from a right one,
 * which is this module's whole reason for existing. So the rule is now the same
 * one applied to an unconvertible pts: an anchor that cannot be computed
 * honestly is not fabricated. 0 means "the first frame is NOW", which is
 * exactly the behaviour that predates the pre-roll work.
 */

/** A rational time base, as node-av's `Frame.timeBase` reports it. */
export interface MediaTimeBase {
  readonly num: number
  readonly den: number
}

/** The per-session anchor tying media time (pts) to wall clock. */
export interface MediaClockAnchor {
  /** pts of the session's FIRST decoded frame, in ms. */
  readonly firstPtsMs: number
  /** Wall clock at which that frame was shot. */
  readonly wallAtFirstPts: number
}

/** Inputs to {@link anchorMediaClock}. */
export interface MediaClockAnchorInput {
  readonly firstPtsMs: number
  /** History this dial asked the broker for, in ms. `0` ⇒ the anchor is now. */
  readonly preRollMs: number
  readonly nowWall: number
}

/**
 * Convert a container pts to milliseconds.
 *
 * Returns `null` — never a fabricated `0` — for a time base that cannot
 * describe a duration. A zero here would place every frame of the session at
 * the anchor, i.e. a whole burst of detections sharing one instant, which is
 * exactly the kind of plausible-looking wrong timestamp this module exists to
 * refuse. The caller degrades to the wall clock instead.
 */
export function ptsToMs(pts: bigint, timeBase: MediaTimeBase): number | null {
  if (!Number.isFinite(timeBase.num) || !Number.isFinite(timeBase.den)) return null
  if (timeBase.num <= 0 || timeBase.den <= 0) return null
  return (Number(pts) * timeBase.num * 1000) / timeBase.den
}

/** Anchor the session's media clock on its first decoded frame. */
export function anchorMediaClock(input: MediaClockAnchorInput): MediaClockAnchor {
  const preRoll = Number.isFinite(input.preRollMs) && input.preRollMs > 0 ? input.preRollMs : 0
  return { firstPtsMs: input.firstPtsMs, wallAtFirstPts: input.nowWall - preRoll }
}

/**
 * The wall clock at which the frame with `ptsMs` was shot.
 *
 * Clamped to `nowWall`: a container whose pts runs past the anchor (a clock
 * jump, a source whose pts is not wall-clock-shaped, a re-dial that reset it)
 * must never produce a track that starts in the FUTURE. A future `firstSeen`
 * sorts a track ahead of everything, and no later pass can detect that it is
 * wrong. Clamping loses precision on a pathological source and keeps the
 * ordering property every consumer relies on.
 */
export function mediaWallClockOf(anchor: MediaClockAnchor, ptsMs: number, nowWall: number): number {
  const shotAt = anchor.wallAtFirstPts + (ptsMs - anchor.firstPtsMs)
  return shotAt > nowWall ? nowWall : shotAt
}

/**
 * The session's anchor, tagged with the DIAL it belongs to.
 *
 * A worker outlives its dials: a warm re-attach reuses the process, a GPU
 * degrade or a reconnect re-dials inside it, and each dial is a new pts epoch
 * (RTP timestamps start wherever the source restarted them). An anchor kept
 * across that boundary dates every frame of the new dial against the OLD
 * dial's first pts. Measured 2026-09-09 on `agent-a`, camera 111: a
 * re-dial 247 s into the session, pts restarting near 0, and `frameAge.avg`
 * sitting at a constant 268 655 ms for the rest of the session — a silent,
 * wrong timestamp on every frame, which is exactly what this module exists to
 * refuse.
 */
export interface DialMediaClock {
  readonly dialSeq: number
  readonly anchor: MediaClockAnchor
}

/**
 * The anchor for a frame of dial `dialSeq`: the current one while the dial is
 * the same, a fresh one — anchored on THIS frame — the moment the dial changes.
 * Pure; the caller keeps the returned value and passes it back next frame.
 */
export function mediaClockForDial(
  current: DialMediaClock | null,
  dialSeq: number,
  input: MediaClockAnchorInput,
): DialMediaClock {
  if (current !== null && current.dialSeq === dialSeq) return current
  return { dialSeq, anchor: anchorMediaClock(input) }
}
