/**
 * A Map with a TTL that is actually ENFORCED, and a size that is actually
 * BOUNDED.
 *
 * The pattern this replaces: `Map<K, {value, timestamp}>` with the age checked
 * on read and nowhere else. That is not a TTL — it is a staleness test. An
 * entry whose key is never requested again is never read, so it is never found
 * expired, so it is never deleted. The map only ever grows, and it grows in
 * proportion to how MANY distinct keys were seen rather than how many are live.
 *
 * `StreamProbeService` held exactly that shape, keyed by stream URL: every URL
 * an operator ever typed, every credential rotation, every per-camera probe of
 * a field that was later changed, retained for the life of the process.
 *
 * Two bounds, because either alone leaves a hole:
 *  - the TTL, swept on every write, releases entries nobody asks about again;
 *  - `maxEntries` with least-recently-USED eviction holds the ceiling even when
 *    every entry is inside its TTL.
 */
export interface TtlCacheOptions {
  /** Entry lifetime in ms. */
  readonly ttlMs: number
  /** Hard ceiling on retained entries. */
  readonly maxEntries: number
  /** Injected clock so the bounds are testable without waiting. */
  readonly now?: () => number
}

interface TtlCacheSlot<V> {
  readonly value: V
  readonly storedAt: number
  lastAccessAt: number
}

export class TtlCache<V> {
  private readonly entries = new Map<string, TtlCacheSlot<V>>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries
    this.now = options.now ?? ((): number => Date.now())
  }

  /** The live value, or undefined when absent or expired. An expired entry is
   *  DELETED here, not merely reported missing. */
  get(key: string): V | undefined {
    const slot = this.entries.get(key)
    if (slot === undefined) return undefined
    const at = this.now()
    if (at - slot.storedAt >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    slot.lastAccessAt = at
    return slot.value
  }

  /**
   * Store a value, then bring the map back inside both bounds.
   *
   * The sweep runs on WRITE and not on a timer on purpose: a timer would have
   * to be owned, unref'd and stopped by every holder of a cache, and a cache
   * that is never written to is a cache that is not growing.
   */
  set(key: string, value: V): void {
    const at = this.now()
    this.entries.set(key, { value, storedAt: at, lastAccessAt: at })
    this.sweepExpired(at)
    this.enforceMaxEntries(key)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Entries currently retained. The number that used to only go up. */
  size(): number {
    return this.entries.size
  }

  private sweepExpired(at: number): void {
    for (const [key, slot] of this.entries) {
      if (at - slot.storedAt >= this.ttlMs) this.entries.delete(key)
    }
  }

  /** Evict least-recently-USED first. `protectedKey` is the entry just written —
   *  evicting it would make `set` a no-op. */
  private enforceMaxEntries(protectedKey: string): void {
    if (this.entries.size <= this.maxEntries) return
    const coldestFirst = [...this.entries.entries()]
      .filter(([key]) => key !== protectedKey)
      .toSorted((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
    for (const [key] of coldestFirst) {
      if (this.entries.size <= this.maxEntries) return
      this.entries.delete(key)
    }
  }
}
