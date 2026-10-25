/**
 * A bump allocator for the buffers the WebRTC send path builds per packet
 * (repacketizer outputs, STAP-A aggregates).
 *
 * `Buffer.from([...])` and `Buffer.concat` below 4 KiB are served from Node's
 * shared 8 KiB pool: one ~1.2 KB fragment per pool slab share, interleaved
 * with every other short-lived pooled buffer in the process. werift keeps the
 * last RTP_HISTORY_SIZE (4096) outputs of a sender for NACK, so each pinned
 * the shared slab it came from and everything beside it. Here every output is
 * a dense view of an arena that holds nothing else.
 *
 * Nothing is ever reused: an arena is left to the GC once full, and lives as
 * long as the last view of it (a NACK slot, a datagram still in flight). That
 * is why there is no hold/release protocol here, unlike `slab-pool.ts`.
 */

/** Bytes per arena: ~50 packets of ~1.2 KB per allocation instead of one per 6. */
export const OUTPUT_ARENA_BYTES = 64 * 1024

/** A request larger than a quarter of an arena gets its own buffer. */
const OUTPUT_ARENA_MAX_REQUEST = OUTPUT_ARENA_BYTES >> 2

export class OutputArena {
  private chunk: Buffer = Buffer.allocUnsafeSlow(0)
  private offset = 0
  private chunks = 0

  /** `size` writable bytes (contents unspecified: the caller fills all of them). */
  take(size: number): Buffer {
    if (size > OUTPUT_ARENA_MAX_REQUEST) return Buffer.allocUnsafeSlow(size)
    if (this.offset + size > this.chunk.length) {
      this.chunk = Buffer.allocUnsafeSlow(OUTPUT_ARENA_BYTES)
      this.chunks += 1
      this.offset = 0
    }
    const out = this.chunk.subarray(this.offset, this.offset + size)
    this.offset += size
    return out
  }

  /** ArrayBuffers allocated by this arena so far. */
  get allocations(): number {
    return this.chunks
  }
}
