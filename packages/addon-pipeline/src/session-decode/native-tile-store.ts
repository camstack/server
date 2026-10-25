/**
 * `NativeTileStore` — what SURVIVES a frame.
 *
 * The decode worker holds a delivered frame only until its detection result
 * comes back (`native-lease-store.ts`). At that moment — the last instant
 * native pixels for that frame exist — the runner asks for one **tile** per
 * surviving detection: the subject's box, padded into a container
 * (`native-tile-geometry.ts`), cut at native resolution and JPEG-encoded in the
 * process that owns the pixels. Those tiles go in here, and the frame is freed.
 *
 * ## Why this is the whole redesign in one sentence
 *
 * The old lease paid per FRAME (~24.9 MB at 4K, on every admitted frame,
 * including the overwhelming majority on which nothing was detected) and was
 * interrogated per SUBJECT. A tile costs ~60-120 KB and a frame with no
 * detections costs nothing at all, so the same RAM buys a retention window an
 * order of magnitude longer than the measured ask age (2.2-9.9 s on this
 * cluster) instead of one four times too short.
 *
 * ## Lifetime
 *
 * A tile lives from {@link put} until the FIRST of:
 *  - its **TTL** — here a TTL is honest, because a tile is not waiting for an
 *    event: it is speculative retention against a request that may never come.
 *    That is the exact inverse of the held frame, which is why one has a clock
 *    and the other does not;
 *  - the **RAM budget**, oldest frame first;
 *  - {@link clear} on re-dial / teardown.
 *
 * Tiles are grouped BY FRAME because that is how they are produced and how they
 * are evicted: a frame's subjects share its fate. Lookup is by frame, and the
 * caller then picks the tile whose region contains the rectangle it wants —
 * containment is the serve gate, and it lives in `native-tile-geometry.ts`.
 *
 * Generic over the payload so the store is unit-testable without an encoder.
 */
import type { ResolvedRegion } from './crop-geometry.js'

/** One retained subject tile: where it was cut from, and its encoded bytes. */
export interface NativeTile {
  /** The tile's placement in the SOURCE frame, in native pixels. */
  readonly region: ResolvedRegion
  /** Encoded (JPEG) bytes of the tile raster. */
  readonly bytes: Uint8Array
}

/** Options for {@link NativeTileStore}. */
export interface NativeTileStoreOptions {
  /** Hard RAM budget in bytes; `<= 0` disables the store (tiles off). */
  readonly budgetBytes: number
  /** How long a tile is served before it counts as a miss. */
  readonly ttlMs: number
  /** Injectable clock (tests). Defaults to `Date.now`. */
  readonly now?: () => number
}

/** Tiles cut from one frame, plus when they were cut. */
interface TileEntry {
  readonly tiles: readonly NativeTile[]
  readonly bytes: number
  readonly insertedAt: number
}

/**
 * A byte-bounded, TTL'd map from worker frameId → the subject tiles cut from
 * that frame. Insertion-ordered (`Map`), so budget eviction is FIFO by age.
 */
export class NativeTileStore {
  private readonly entries = new Map<number, TileEntry>()
  private readonly budgetBytes: number
  private readonly ttlMs: number
  private readonly now: () => number
  private bytes = 0
  /**
   * Frames whose tiles were dropped by the BUDGET before their TTL ran out.
   *
   * Counted, not silent: budget eviction is the one path here that destroys
   * retained work, and on the scene store a dropped entry is a key frame that
   * can never be captured again. `0` means the TTL is what bounds this store —
   * anything else is the signal that its budget is the binding limit.
   */
  private evicted = 0

  constructor(options: NativeTileStoreOptions) {
    this.budgetBytes = options.budgetBytes
    this.ttlMs = options.ttlMs
    this.now = options.now ?? Date.now
  }

  /** Frames dropped by the byte budget rather than by the TTL (tests / metrics). */
  get evictedCount(): number {
    return this.evicted
  }

  /** `false` when tiles are disabled (`budgetBytes <= 0`). */
  get enabled(): boolean {
    return this.budgetBytes > 0
  }

  /** Number of frames with retained tiles (tests / metrics). */
  get frameCount(): number {
    return this.entries.size
  }

  /** Total retained tiles across every frame (tests / metrics). */
  get tileCount(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.tiles.length
    return total
  }

  /** Total resident bytes (tests / metrics). */
  get totalBytes(): number {
    return this.bytes
  }

  /**
   * Retain `tiles` for `frameId`. Returns `false` when the store is disabled —
   * the caller then simply has nothing to fall back on, exactly as before this
   * store existed. Sweeps expired entries first, then evicts oldest-first while
   * over budget; the entry just admitted is never the one evicted.
   */
  put(frameId: number, tiles: readonly NativeTile[]): boolean {
    if (!this.enabled || tiles.length === 0) return false
    this.drop(frameId)
    this.sweepExpired()
    let size = 0
    for (const tile of tiles) size += tile.bytes.byteLength
    this.entries.set(frameId, { tiles, bytes: size, insertedAt: this.now() })
    this.bytes += size
    while (this.bytes > this.budgetBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined || oldest === frameId) break
      this.drop(oldest)
      this.evicted += 1
    }
    return true
  }

  /**
   * The tiles retained for `frameId`, or an empty array when there are none or
   * they have aged out. An expired entry is dropped here so a caller reading
   * just after expiry cannot resurrect it.
   */
  get(frameId: number): readonly NativeTile[] {
    const entry = this.entries.get(frameId)
    if (!entry) return []
    if (this.now() - entry.insertedAt > this.ttlMs) {
      this.drop(frameId)
      return []
    }
    return entry.tiles
  }

  /** Drop every entry older than the TTL. */
  sweepExpired(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [frameId, entry] of this.entries) {
      if (entry.insertedAt < cutoff) this.drop(frameId)
    }
  }

  /** Drop everything. Idempotent (re-dial + teardown call it). */
  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  /** Remove one frame's tiles, keeping the byte tally exact. */
  private drop(frameId: number): void {
    const entry = this.entries.get(frameId)
    if (!entry) return
    this.entries.delete(frameId)
    this.bytes -= entry.bytes
  }
}
