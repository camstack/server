import type { EncodedPacket } from '@camstack/types'

import { backingStoreBytes, detachFromPool } from './owned-buffer.js'

/**
 * Time-based ring buffer for encoded video packets.
 *
 * Keeps the most recent N seconds of encoded packets, evicting old ones
 * based on timestamp. Used for pre-buffering: when an addon needs the last
 * N seconds of video (e.g., for clip creation), it calls `getPackets()`.
 *
 * The buffer always starts from the most recent keyframe to ensure
 * consumers can decode the returned data.
 *
 * Every entry OWNS its backing store (`owned-buffer.ts`): a sub-stream NAL
 * arrives as a view of a shared 8 KiB pool slab, and a ring that kept it for
 * 60 s pinned the slab and every short-lived packet beside it — the clip
 * rings of ~70 brokers were the largest holder of the hub broker's
 * 550–980 MB of ArrayBuffers. The byte budget charges what an entry pins.
 */
export class EncodedRingBuffer {
  private readonly packets: EncodedPacket[] = []
  private maxDurationMs: number
  private readonly maxBytes: number
  private bytes = 0
  private clampedByBytes = false

  /**
   * @param maxDurationSec how much WALL TIME to keep.
   * @param maxBytes how much MEMORY that is allowed to cost. `0` = unbounded,
   *   which is what this buffer was before and is why it needed a bound: the
   *   retention is set in SECONDS, but what a second costs depends entirely on
   *   which profile got armed. On the operator's fleet the cheap profile runs
   *   at 34-118 kbps while the main stream runs at up to 11 Mbps — a 25:1
   *   ratio — so one rule arming a clip on the main stream turns a 60-second
   *   retention into 82 MB on a single camera, silently, in native memory.
   *   A time limit cannot express that; only a byte limit can.
   */
  constructor(maxDurationSec: number = 10, maxBytes = 0) {
    this.maxDurationMs = maxDurationSec * 1000
    this.maxBytes = Math.max(0, maxBytes)
  }

  /** Update the buffer duration (in seconds). Evicts old packets immediately. */
  setDuration(seconds: number): void {
    this.maxDurationMs = seconds * 1000
    this.evict()
  }

  /** Get the current buffer duration in seconds. */
  getDuration(): number {
    return this.maxDurationMs / 1000
  }

  /**
   * Push a new packet into the buffer and evict expired ones.
   *
   * A pooled payload is copied into its own allocation on the way in; one
   * that already owns its ArrayBuffer is stored as-is. The consumers fanned
   * out from the same packet keep the original, so the copy is the ring's
   * alone and is freed with it.
   */
  push(packet: EncodedPacket): void {
    const data = detachFromPool(packet.data)
    const stored: EncodedPacket = data === packet.data ? packet : { ...packet, data }
    this.packets.push(stored)
    this.bytes += backingStoreBytes(data)
    this.evict()
  }

  /** What the retained window currently costs, in bytes of backing store. */
  getBufferedBytes(): number {
    return this.bytes
  }

  /**
   * True when the byte budget — not the clock — is what bounds this window.
   *
   * Worth asking rather than inferring from a short buffer: a window cut by
   * bytes holds LESS time than it was configured for, and a consumer that
   * believes the configured number will look for footage that was never kept.
   */
  isClampedByBytes(): boolean {
    return this.clampedByBytes
  }

  /**
   * Get buffered packets, starting from the most recent keyframe.
   * Returns packets in chronological order (oldest first).
   * Returns an empty array if no keyframe is found.
   */
  getPackets(): readonly EncodedPacket[] {
    // Find the last keyframe index — consumers need a keyframe to start decoding
    let lastKeyframeIdx = -1
    for (let i = this.packets.length - 1; i >= 0; i--) {
      if (this.packets[i]!.keyframe && this.packets[i]!.type === 'video') {
        lastKeyframeIdx = i
        break
      }
    }

    if (lastKeyframeIdx < 0) return []

    return this.packets.slice(lastKeyframeIdx)
  }

  /**
   * EVERY retained packet, oldest first — the whole window, not just the
   * current GOP.
   *
   * `getPackets()` cuts at the most recent keyframe because its consumers are
   * decoders that must start there. A clip cut around a past instant needs the
   * opposite: the seconds BEFORE that keyframe are most of the pre-roll, and
   * returning the current GOP would yield a clip that starts (and often ends)
   * after the moment it is supposed to show. Callers doing this are expected to
   * align their own cut to a keyframe.
   */
  getAllPackets(): readonly EncodedPacket[] {
    return this.packets.slice()
  }

  /** Get the approximate duration of buffered content in seconds. */
  getBufferedDurationMs(): number {
    if (this.packets.length < 2) return 0
    const first = this.packets[0]!
    const last = this.packets[this.packets.length - 1]!
    return last.pts - first.pts
  }

  /** Get the number of packets in the buffer. */
  getPacketCount(): number {
    return this.packets.length
  }

  /** Clear all buffered packets. */
  clear(): void {
    this.packets.length = 0
    this.bytes = 0
    this.clampedByBytes = false
  }

  /**
   * Remove packets older than maxDurationMs based on PTS.
   *
   * PTS here is the source RTP timestamp (90kHz → ms), which is NOT
   * monotonic across the buffer's lifetime: an RTSP/rfc4571 redial re-bases
   * it to a fresh random value (RFC 3550) and the 32-bit field wraps every
   * ~13.25h. A purely `pts < cutoff` head-trim stalls forever whenever the
   * newest packet's pts drops below the stale head's — the buffer then
   * retains the entire pre-discontinuity history (an unbounded native-memory
   * leak of full-bitrate AnnexB copies). So we also evict any head packet
   * whose pts is GREATER than the newest packet's: it can only belong to a
   * prior, higher-based epoch that the source has since jumped away from.
   */
  private evict(): void {
    if (this.packets.length === 0) return

    const newest = this.packets[this.packets.length - 1]!.pts
    const cutoff = newest - this.maxDurationMs
    let removeCount = 0

    while (
      removeCount < this.packets.length &&
      (this.packets[removeCount]!.pts < cutoff || this.packets[removeCount]!.pts > newest)
    ) {
      removeCount++
    }

    if (removeCount > 0) {
      for (let i = 0; i < removeCount; i++) this.bytes -= backingStoreBytes(this.packets[i]!.data)
      this.packets.splice(0, removeCount)
    }

    // THE BYTE BUDGET, applied after the clock. Oldest-first, exactly like the
    // time eviction — a clip cut around a past instant loses its pre-roll
    // first, which is the honest thing to lose when the memory is not there to
    // hold it. `clampedByBytes` is latched per eviction so a caller can tell a
    // window bounded by memory from one bounded by its configured seconds.
    if (this.maxBytes > 0 && this.bytes > this.maxBytes) {
      this.clampedByBytes = true
      let dropped = 0
      while (dropped < this.packets.length && this.bytes > this.maxBytes) {
        this.bytes -= backingStoreBytes(this.packets[dropped]!.data)
        dropped++
      }
      if (dropped > 0) this.packets.splice(0, dropped)
    } else if (this.maxBytes > 0) {
      this.clampedByBytes = false
    }
  }
}
