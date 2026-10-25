/**
 * session-mem — what ONE WebRTC session pins, measured by BACKING STORE.
 *
 * The `[broker-mem]` line counted only broker-owned rings and missed ~230 MB of
 * v8 external memory per live browser session. The suspects all hold `Buffer`s
 * that can be views of shared 8 KiB pool slabs (see `owned-buffer.ts`), so
 * `.length` under-reports them by the slab: werift's per-sender NACK history,
 * the push-frame queue, the paced RTP replay queue and the scrub fragment
 * cache. Each is read here the same way — a {@link BackingTally} — and reports
 * three numbers so pinning is visible:
 *
 *  - `payloadBytes`          what the entries SAY they hold (`.length`);
 *  - `naiveBackingBytes`     each entry's own {@link pinnedBackingBytes} summed,
 *                            a slab counted once per entry that views it;
 *  - `distinctBackingBytes`  each distinct ArrayBuffer counted ONCE: what the
 *                            process really holds.
 *
 * Cost: nothing per packet. A reading iterates the structures at PROBE time
 * only (every five minutes, plus once at session open / close), and every
 * tally stops at {@link TALLY_MAX_ENTRIES} and says so (`capped`).
 */

import { pinnedBackingBytes } from './owned-buffer.js'

/** A tally never walks more entries than this; a capped one is flagged. */
export const TALLY_MAX_ENTRIES = 200_000

/** One structure's measured totals. */
export interface BackingTotals {
  readonly entries: number
  readonly payloadBytes: number
  readonly naiveBackingBytes: number
  readonly distinctBackingBytes: number
  readonly capped: boolean
}

export const EMPTY_BACKING_TOTALS: BackingTotals = {
  entries: 0,
  payloadBytes: 0,
  naiveBackingBytes: 0,
  distinctBackingBytes: 0,
  capped: false,
}

/** Accumulates entries; each distinct backing ArrayBuffer is summed once. */
export class BackingTally {
  private readonly seen = new Set<ArrayBufferLike>()
  private entries = 0
  private payload = 0
  private naive = 0
  private distinct = 0
  private capped = false

  add(buf: Uint8Array): void {
    if (this.entries >= TALLY_MAX_ENTRIES) {
      this.capped = true
      return
    }
    this.entries += 1
    this.payload += buf.length
    const backing = pinnedBackingBytes(buf)
    this.naive += backing
    if (!this.seen.has(buf.buffer)) {
      this.seen.add(buf.buffer)
      this.distinct += backing
    }
  }

  totals(): BackingTotals {
    return {
      entries: this.entries,
      payloadBytes: this.payload,
      naiveBackingBytes: this.naive,
      distinctBackingBytes: this.distinct,
      capped: this.capped,
    }
  }
}

/** One session's reading. */
export interface SessionMemReading {
  readonly sessionId: string
  readonly deviceId: number | undefined
  /** werift video + audio NACK history, deduplicated across both senders. */
  readonly rtpCache: BackingTotals
  /** `createPushFrameSource` queue. */
  readonly pushQueue: BackingTotals
  /** `activeRtpReplay` queue. */
  readonly rtpReplay: BackingTotals
  /** The session's ScrubFragmentCache (what the timeline warm-up fills). */
  readonly scrub: BackingTotals
}

/** What the session class itself owns (the server entry adds the rest). */
export interface SessionOwnMemReading {
  readonly rtpCache: BackingTotals
  readonly rtpReplay: BackingTotals
}

/** Shape of a werift sender's NACK history slot we read: the payload only. */
export interface RtpCacheSlot {
  readonly payload: Uint8Array
}

/** Add every populated slot of a sender's `rtpCache` (≤ RTP_HISTORY_SIZE). */
export function tallyRtpCache(
  tally: BackingTally,
  cache: readonly (RtpCacheSlot | undefined)[] | undefined,
): void {
  if (cache === undefined) return
  for (let i = 0; i < cache.length; i++) {
    const slot = cache[i]
    if (slot !== undefined) tally.add(slot.payload)
  }
}

/** Distinct backing bytes a session pins across all four structures. */
export function sessionBackingBytes(r: SessionMemReading): number {
  return (
    r.rtpCache.distinctBackingBytes +
    r.pushQueue.distinctBackingBytes +
    r.rtpReplay.distinctBackingBytes +
    r.scrub.distinctBackingBytes
  )
}

function mbOf(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1))
}

/** Flat log meta for the session open / close lines. */
export function sessionMemMeta(r: SessionMemReading): Record<string, number | boolean> {
  return {
    rtpCacheEntries: r.rtpCache.entries,
    rtpCachePayloadMb: mbOf(r.rtpCache.payloadBytes),
    rtpCacheNaiveMb: mbOf(r.rtpCache.naiveBackingBytes),
    rtpCacheBackingMb: mbOf(r.rtpCache.distinctBackingBytes),
    pushQueueFrames: r.pushQueue.entries,
    pushQueueBackingMb: mbOf(r.pushQueue.distinctBackingBytes),
    rtpReplayPackets: r.rtpReplay.entries,
    rtpReplayBackingMb: mbOf(r.rtpReplay.distinctBackingBytes),
    scrubPayloadMb: mbOf(r.scrub.payloadBytes),
    scrubBackingMb: mbOf(r.scrub.distinctBackingBytes),
    sessionBackingMb: mbOf(sessionBackingBytes(r)),
    memCapped: r.rtpCache.capped || r.pushQueue.capped || r.rtpReplay.capped || r.scrub.capped,
  }
}
