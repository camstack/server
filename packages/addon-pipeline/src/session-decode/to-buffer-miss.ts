/**
 * The words for a `toBuffer` miss — which rung lost the frame.
 *
 * "unknown or stale" said nothing for a month: the same line covered a frame
 * the runner never marked (so it was never leased), a marked frame the hold
 * evicted or a release already freed, and an id newer than anything
 * delivered. Each is a different fault with a different owner, and the
 * worker knows which one it is at the moment of the miss.
 */
export interface ToBufferMissFacts {
  readonly frameId: number
  /** The id the last `pull` delivered (the reserved slot), or null before any. */
  readonly reservedFrameId: number | null
  /** The runner marked this frame as admitted to inference. */
  readonly marked: boolean
  /** Frames the hold currently keeps, and its bound. */
  readonly leaseFrames: number
  readonly holdFrames: number
  /** Evictions the hold bound has performed so far. */
  readonly holdOverflow: number
  /**
   * Who withdrew this frame's mark before the read, when someone did: the
   * runner's `releaseNativeLease` message or the result path's `cutTiles`.
   * Absent when the frame was never unmarked — then a `released` rung is the
   * bound's or a re-dial's doing.
   */
  readonly unmarkedBy?: 'release' | 'cut'
}

export type ToBufferMissRung = 'not-yet-delivered' | 'never-leased' | 'hold-full' | 'released'

/** Which rung lost the frame, from what the worker knows at the miss. */
export function toBufferMissRung(facts: ToBufferMissFacts): ToBufferMissRung {
  if (facts.reservedFrameId !== null && facts.frameId > facts.reservedFrameId) {
    return 'not-yet-delivered'
  }
  if (!facts.marked) return 'never-leased'
  if (facts.leaseFrames >= facts.holdFrames) return 'hold-full'
  return 'released'
}

/** The error line the runner sees: the rung first, the numbers after it. */
export function describeToBufferMiss(facts: ToBufferMissFacts): string {
  const rung = toBufferMissRung(facts)
  return (
    `decode-worker-child: toBuffer miss for frameId ${facts.frameId} — ${rung} ` +
    `{reserved=${facts.reservedFrameId ?? 'none'} marked=${facts.marked} ` +
    `leaseFrames=${facts.leaseFrames}/${facts.holdFrames} holdOverflow=${facts.holdOverflow}` +
    `${facts.unmarkedBy !== undefined ? ` unmarkedBy=${facts.unmarkedBy}` : ''}}`
  )
}
