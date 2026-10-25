import { LogRingBuffer } from './log-ring-buffer.js'
import type { LogEntry, LogFilter, LogLevel } from '@camstack/types'

/** Bucket key for entries that carry no resolvable `addonId` tag. */
const NO_ADDON_KEY = ''

/**
 * Normalise an `addonId` tag value to its bare manifest id — mirrors the
 * suffix-stripping in {@link matchesLogTags} so a worker line tagged
 * `provider-homeassistant@0.1.0` and a sub-service line tagged
 * `audio-codec-nodeav::native-device-ops` bucket under the same addon as the
 * addon's own lines. Returns {@link NO_ADDON_KEY} for a missing/non-string id.
 */
function addonBucketKey(addonId: unknown): string {
  if (typeof addonId !== 'string' || addonId.length === 0) return NO_ADDON_KEY
  let bare = addonId.split('@')[0] ?? addonId
  const colon = bare.indexOf('::')
  if (colon >= 0) bare = bare.slice(0, colon)
  return bare
}

/**
 * Once a total cap is hit, prune down to this fraction of it rather than to
 * exactly the cap. Without the gap, the buffer would sit permanently at the
 * threshold and every single subsequent push would trigger a sweep.
 */
const PRUNE_TARGET_RATIO = 0.9

/**
 * Default ceiling on retained entries across every bucket.
 *
 * This used to be `null` — no aggregate bound at all — and the only thing
 * holding hub-main's log memory was `perAddonCapacity x buckets`, a product
 * that grows with the roster. Measured on the live cluster: 37 forked runners
 * on the hub plus its in-process builtins, and hub-main additionally ingests
 * every line from both agents, so ~60 buckets is the ordinary case and
 * 60 x 5000 = 300k retained entries.
 *
 * A realistic entry (timestamp, level, scope, ~70-char message, three tags, no
 * `meta`) measures **~306 B retained** in V8. So the old unbounded case is
 * ~92MB of a hub process that is being asked to fit inside a cgroup with a
 * neighbour to protect, and 50_000 is **~15MB**.
 *
 * 50_000 across a ~60-bucket roster is ~830 entries per addon on average while
 * still letting a single chatty addon hold its full 5000-entry ring — the
 * partitioning is not weakened, only the total is held.
 */
export const DEFAULT_MAX_TOTAL_LOG_ENTRIES = 50_000

/**
 * Default ceiling on the NUMBER of buckets.
 *
 * Buckets were created on first write and never removed, so every addon id
 * that ever logged — a removed addon, a renamed one, a one-off worker id —
 * kept a ring alive for the life of the process. {@link DEFAULT_MAX_TOTAL_LOG_ENTRIES}
 * alone does not fix that: the total sweep may only discard entries at or below
 * `pruneLevel`, so a dead addon's 5000 `info` lines are untouchable by it.
 *
 * 128 is ~2x the ~60-bucket live roster, so no real deployment ever evicts on
 * bucket count alone; it exists to make an unbounded id space impossible.
 */
export const DEFAULT_MAX_LOG_BUCKETS = 128

export interface PartitionedLogBufferOptions {
  /** Hard ring size for EACH addon's bucket. */
  readonly perAddonCapacity?: number
  /**
   * Soft ceiling on entries across all buckets. `null` means the only bound is
   * the per-addon rings. Defaults to {@link DEFAULT_MAX_TOTAL_LOG_ENTRIES}.
   */
  readonly maxTotalEntries?: number | null
  /** Highest severity the total-cap sweep may discard. Default `debug`. */
  readonly pruneLevel?: LogLevel
  /**
   * Hard ceiling on the number of buckets. `null` means unbounded. Defaults to
   * {@link DEFAULT_MAX_LOG_BUCKETS}.
   */
  readonly maxBuckets?: number | null
}

/**
 * A log buffer partitioned into one fixed-capacity {@link LogRingBuffer} per
 * `addonId`. A chatty addon (e.g. detection-pipeline) only ever evicts its OWN
 * bucket, so a quiet addon's sparse lines (e.g. a HomeAssistant `image` entity)
 * survive far longer than they would in a single shared FIFO ring.
 *
 * Drop-in for {@link LogRingBuffer} from {@link LogManager}'s perspective —
 * exposes the same `push` / `getAll` / `query` / `clear` surface.
 *
 * ## Three bounds, doing different jobs
 *
 * **`perAddonCapacity`** is a HARD bound: each bucket is a fixed-size ring, so
 * total memory can never exceed `perAddonCapacity × buckets` whatever else
 * happens. This is the safety net.
 *
 * **`maxTotalEntries`** targets the total across all buckets, and it exists because
 * the hard bound scales with addon count — 60 buckets × 5000 was 300k retained
 * entries on the live hub. When the total is exceeded, the sweep first discards
 * only entries at or below `pruneLevel` (default `debug`), oldest first, from the
 * largest buckets first.
 *
 * It is deliberately soft ON A LIVE BUCKET. Meeting a total cap by discarding
 * `warn` and `error` from an addon that is still logging would trade the entries
 * that explain an incident for entries about frame timings. A cap that can evict
 * a live addon's error is not a feature.
 *
 * Largest-bucket-first because the noisy addon is the one creating the pressure —
 * the same principle that motivated partitioning in the first place.
 *
 * **`maxBuckets`, and bucket eviction, are the hard backstop.** Pruning alone
 * cannot bound this structure: it may only discard at or below `pruneLevel`, so
 * a bucket full of `info` from an addon that no longer exists was immortal, and
 * the roster the product scales with is not fixed. When pruning cannot reach the
 * target — or the bucket count exceeds `maxBuckets` — whole buckets are dropped
 * **least-recently-WRITTEN first**, and never the bucket currently being written
 * to. That is precisely the dead addon's bucket, and it is precisely not the
 * bucket of the addon whose incident is in progress.
 */
export class PartitionedLogBuffer {
  private readonly buffers = new Map<string, LogRingBuffer>()
  /**
   * Bucket key → the write ordinal of its last `push`. A monotonic counter, not
   * a clock: eviction order must follow the order writes actually happened, and
   * a wall clock that steps backwards would pick the wrong victim.
   */
  private readonly lastWriteSeq = new Map<string, number>()
  private writeSeq = 0
  // MUTABLE (2026-07-30): the buffer's knobs used to be fixed at construction,
  // and `LoggingService` is built at boot BEFORE the settings store is wired —
  // so an operator-written value could never reach them. `reconfigure` is what
  // lets the buffer behave like every other log destination.
  private perAddonCapacity: number
  private maxTotalEntries: number | null
  private pruneLevel: LogLevel
  private maxBuckets: number | null
  /** Running total, so `push` does not walk every bucket to decide. */
  private totalEntries = 0

  constructor(perAddonCapacity = 5000, options: PartitionedLogBufferOptions = {}) {
    this.perAddonCapacity = options.perAddonCapacity ?? perAddonCapacity
    // `undefined` takes the default; an EXPLICIT `null` is the opt-out.
    this.maxTotalEntries =
      options.maxTotalEntries === undefined
        ? DEFAULT_MAX_TOTAL_LOG_ENTRIES
        : options.maxTotalEntries
    this.pruneLevel = options.pruneLevel ?? 'debug'
    this.maxBuckets =
      options.maxBuckets === undefined ? DEFAULT_MAX_LOG_BUCKETS : options.maxBuckets
  }

  /**
   * Apply new limits at runtime. Shrinking takes effect as entries are pushed
   * (each partition trims to the new capacity on its next write) — existing
   * entries are NOT dropped eagerly: losing history the operator is currently
   * reading, the instant they lower a number, is a worse surprise than a
   * momentarily oversized buffer.
   */
  reconfigure(options: {
    readonly perAddonCapacity?: number
    readonly maxTotalEntries?: number | null
    readonly pruneLevel?: LogLevel
    readonly maxBuckets?: number | null
  }): void {
    if (options.perAddonCapacity !== undefined && options.perAddonCapacity > 0) {
      this.perAddonCapacity = options.perAddonCapacity
    }
    if (options.maxTotalEntries !== undefined) this.maxTotalEntries = options.maxTotalEntries
    if (options.pruneLevel !== undefined) this.pruneLevel = options.pruneLevel
    if (options.maxBuckets !== undefined) this.maxBuckets = options.maxBuckets
  }

  private bufferFor(key: string): LogRingBuffer {
    let buf = this.buffers.get(key)
    if (buf === undefined) {
      buf = new LogRingBuffer(this.perAddonCapacity)
      this.buffers.set(key, buf)
    }
    return buf
  }

  push(entry: LogEntry): void {
    const key = addonBucketKey(entry.tags?.addonId)
    const buf = this.bufferFor(key)
    const before = buf.size()
    buf.push(entry)
    // A full ring evicts as it accepts, so the delta is 0 or 1 — never assume 1.
    this.totalEntries += buf.size() - before
    this.lastWriteSeq.set(key, ++this.writeSeq)
    if (this.maxBuckets !== null && this.buffers.size > this.maxBuckets) {
      this.evictBuckets(this.buffers.size - this.maxBuckets, key)
    }
    if (this.maxTotalEntries !== null && this.totalEntries > this.maxTotalEntries) {
      this.enforceTotalCap(this.maxTotalEntries, key)
    }
  }

  /**
   * Bring the total down to `PRUNE_TARGET_RATIO × cap`.
   *
   * Two passes, in this order and no other: first discard prunable entries,
   * largest bucket first, which is free of information cost. Only if that
   * cannot reach the target does the second pass drop WHOLE buckets,
   * least-recently-written first — the bound has to hold even when every
   * retained entry is above `pruneLevel`, and a bucket nobody has written to is
   * the cheapest thing in the structure to lose.
   */
  private enforceTotalCap(cap: number, protectedKey: string): void {
    const target = Math.max(1, Math.floor(cap * PRUNE_TARGET_RATIO))
    let deficit = this.totalEntries - target
    if (deficit <= 0) return

    const bySizeDesc = [...this.buffers.entries()].toSorted((a, b) => b[1].size() - a[1].size())
    for (const [key, buf] of bySizeDesc) {
      if (deficit <= 0) break
      const removed = buf.pruneOldestAtOrBelow(this.pruneLevel, deficit)
      this.totalEntries -= removed
      deficit -= removed
      if (buf.size() === 0) this.dropBucket(key)
    }
    if (deficit > 0) this.evictBucketsUntil(target, protectedKey)
  }

  /**
   * Drop whole buckets, least-recently-WRITTEN first, until the total is at or
   * below `target`. Never touches `protectedKey` (the bucket being written to
   * right now) and always leaves at least one bucket standing.
   */
  private evictBucketsUntil(target: number, protectedKey: string): void {
    for (const key of this.evictionOrder(protectedKey)) {
      if (this.totalEntries <= target || this.buffers.size <= 1) return
      this.dropBucket(key)
    }
  }

  /** Drop exactly `count` buckets, least-recently-written first. */
  private evictBuckets(count: number, protectedKey: string): void {
    let remaining = count
    for (const key of this.evictionOrder(protectedKey)) {
      if (remaining <= 0 || this.buffers.size <= 1) return
      this.dropBucket(key)
      remaining -= 1
    }
  }

  /** Bucket keys ordered least-recently-written first, excluding `protectedKey`.
   *  A bucket with no recorded write sorts first — it can only be a leftover. */
  private evictionOrder(protectedKey: string): readonly string[] {
    return [...this.buffers.keys()]
      .filter((key) => key !== protectedKey)
      .toSorted((a, b) => (this.lastWriteSeq.get(a) ?? 0) - (this.lastWriteSeq.get(b) ?? 0))
  }

  /** Remove a bucket and everything that indexes it. An empty ring left behind
   *  is the leak this class shipped with — the map only ever grew. */
  private dropBucket(key: string): void {
    const buf = this.buffers.get(key)
    if (buf === undefined) return
    this.totalEntries -= buf.size()
    this.buffers.delete(key)
    this.lastWriteSeq.delete(key)
  }

  /** Entries retained across every bucket. */
  size(): number {
    return this.totalEntries
  }

  /** Buckets currently retained. Observability for the aggregate bound — an
   *  addon roster that only ever grows is what this class had to stop doing. */
  bucketCount(): number {
    return this.buffers.size
  }

  /** Every retained entry across all buckets, newest-first (mirrors
   *  {@link LogRingBuffer.getAll}). Used to replay history to a destination. */
  getAll(): LogEntry[] {
    return this.mergeNewestFirst((buf) => buf.getAll())
  }

  /**
   * Query across buckets. When the filter pins an `addonId`, only that addon's
   * bucket is scanned (the common case — the device/addon Logs tab). Otherwise
   * every bucket is scanned, merged newest-first, then limited — so a
   * `deviceId`-only filter (a device's own Logs tab) still finds its lines
   * regardless of which addon emitted them.
   */
  query(filter: LogFilter): LogEntry[] {
    const pinned = this.pinnedAddonKey(filter)
    const limit = filter.limit
    // Run the per-bucket query WITHOUT the limit, merge, then apply the limit
    // once globally so a cross-bucket query returns the true newest N.
    const unbounded: LogFilter = { ...filter, limit: undefined }
    const matched =
      pinned !== null
        ? (this.buffers.get(pinned)?.query(unbounded) ?? [])
        : this.mergeNewestFirst((buf) => buf.query(unbounded))
    return limit !== undefined && limit > 0 ? matched.slice(0, limit) : matched
  }

  clear(filter: LogFilter = {}): number {
    const pinned = this.pinnedAddonKey(filter)
    // Every path must decrement `totalEntries`. A running total that only ever
    // goes up would drift until the cap fired constantly on a buffer that was
    // actually near-empty — the kind of bug that looks like "logs keep vanishing".
    if (pinned !== null) {
      const removed = this.buffers.get(pinned)?.clear(filter) ?? 0
      this.totalEntries -= removed
      this.dropIfEmpty(pinned)
      return removed
    }
    let removed = 0
    // Spread first: `dropIfEmpty` deletes from the very Map being iterated.
    for (const [key, buf] of [...this.buffers.entries()]) {
      removed += buf.clear(filter)
      this.dropIfEmpty(key)
    }
    this.totalEntries -= removed
    return removed
  }

  /** An emptied bucket is removed rather than left as an empty ring: the map
   *  used to grow with every addon id that ever logged and never shrink. */
  private dropIfEmpty(key: string): void {
    if (this.buffers.get(key)?.size() === 0) {
      this.buffers.delete(key)
      this.lastWriteSeq.delete(key)
    }
  }

  /** The bucket key a filter pins to via `tags.addonId`, or null when the
   *  filter doesn't constrain the addon (→ scan all buckets). */
  private pinnedAddonKey(filter: LogFilter): string | null {
    const addonId = filter.tags?.addonId
    return typeof addonId === 'string' && addonId.length > 0 ? addonBucketKey(addonId) : null
  }

  private mergeNewestFirst(select: (buf: LogRingBuffer) => LogEntry[]): LogEntry[] {
    const merged: LogEntry[] = []
    for (const buf of this.buffers.values()) merged.push(...select(buf))
    // Each bucket is already newest-first; the global order across buckets is
    // restored by sorting on the timestamp (descending).
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return merged
  }
}
