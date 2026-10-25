/**
 * One wire request per (frame, region, size) — pure, RN-free, clock-injected.
 *
 * Every enrichment consumer (face, plate, clip, detail, best shot) pulls its
 * ROI by frame handle, and each response transits hub-main as a msgpack buffer.
 * Measured 2026-08-29: ~2 267 responses/min at ~236 kB each = 81% of hub-main's
 * outbound bytes; 2026-09-03 the live counters still read 423 MB/min to this
 * addon alone. That traffic is what holds hub-main ~12% above its RSS budget,
 * with a 0.5-1 s stop-the-world reclaim every couple of minutes on the ONE
 * process that mediates every cross-runner call.
 *
 * Two mechanisms, kept separate because their costs differ:
 *
 *  - **Coalescing.** Callers arriving while a request is in flight join it.
 *    Pure win: nothing is retained beyond a request that was already happening.
 *  - **A short TTL.** A repeat arriving just after is answered from memory.
 *    This one DOES hold bytes in this process, so it is deliberately small and
 *    brief: the point is to move bytes off hub-main, not to move a leak here.
 *
 * A MISS is never remembered. `null` means the lease was evicted or the tier
 * was refused, and the caller's own retry must be allowed to reach a fresh
 * frame — caching that would turn a transient miss into a permanent one.
 */

export interface NativeCropHandleKey {
  readonly shmId: string
  readonly slot: number
  readonly seq: number
}

export interface NativeCropRegionKey {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface NativeCropDedupeConfig {
  readonly now: () => number
  /** How long a fetched crop may answer a repeat. Small on purpose. */
  readonly ttlMs: number
  /** Hard ceiling on retained entries — this must never become the problem. */
  readonly maxEntries: number
}

interface Entry<T> {
  readonly pending: Promise<T | null>
  /** Set once resolved with a hit; absent while in flight or after a miss. */
  value?: T
  at?: number
}

/**
 * Generic in the reply type on purpose. An earlier draft cached the JPEG bytes
 * and kept the surrounding reply (tier, served dims) in a SECOND map beside it —
 * two sources of truth for one fetch, and the tier gate downstream reads that
 * reply. Whatever a caller needs travels as one value.
 */
export interface NativeCropDedupeCounts {
  /** Requests that crossed the wire. */
  readonly fetched: number
  /** Requests answered by joining one already in flight. */
  readonly coalesced: number
  /** Requests answered from the window. */
  readonly reused: number
}

export class NativeCropDedupe<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private fetched = 0
  private coalesced = 0
  private reused = 0

  /**
   * What this actually saved, since the last read.
   *
   * Shipped WITH the optimisation, not after it: without a counter the only
   * evidence available is the process's RSS, which is allocator residue that
   * ratchets within a boot and cannot answer "did the dedupe fire". An
   * optimisation nobody can measure is a claim, not a fix.
   */
  drainCounts(): NativeCropDedupeCounts {
    const counts = { fetched: this.fetched, coalesced: this.coalesced, reused: this.reused }
    this.fetched = 0
    this.coalesced = 0
    this.reused = 0
    return counts
  }

  constructor(private readonly config: NativeCropDedupeConfig) {}

  /** Retained entries — for the bound's own test, and for metrics. */
  size(): number {
    return this.entries.size
  }

  async run(
    handle: NativeCropHandleKey,
    region: NativeCropRegionKey,
    maxWidth: number | undefined,
    fetch: () => Promise<T | null>,
  ): Promise<T | null> {
    // The seq is what makes this safe: a ring slot is REUSED, so keying on
    // `shmId#slot` alone would hand one frame's pixels to another frame's
    // request. Region and width are part of the identity because face, plate
    // and clip all cut different windows out of the same frame.
    const key = `${handle.shmId}#${handle.slot}#${handle.seq}|${region.x},${region.y},${region.w},${region.h}|${maxWidth ?? 'full'}`
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      if (existing.value !== undefined && existing.at !== undefined) {
        if (this.config.now() - existing.at < this.config.ttlMs) {
          this.reused += 1
          return existing.value
        }
        this.entries.delete(key)
      } else {
        // Still in flight — join it rather than issue a second request.
        this.coalesced += 1
        return existing.pending
      }
    }

    this.fetched += 1
    const pending = fetch()
    const entry: Entry<T> = { pending }
    this.entries.set(key, entry)
    try {
      const result = await pending
      if (result === null) {
        // A miss stays retry-eligible: see the module docblock.
        this.entries.delete(key)
        return null
      }
      entry.value = result
      entry.at = this.config.now()
      this.evictOverflow()
      return result
    } catch (err) {
      // A thrown fetch must not leave a promise nobody can retry behind.
      this.entries.delete(key)
      throw err
    }
  }

  /** Oldest-first, and only ever over the ceiling. */
  private evictOverflow(): void {
    while (this.entries.size > this.config.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) return
      this.entries.delete(oldest.value)
    }
  }
}
