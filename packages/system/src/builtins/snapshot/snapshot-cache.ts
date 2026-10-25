/**
 * The per-device snapshot cache, keyed by (device, STREAM).
 *
 * It used to be keyed by device alone, and `getSnapshot` served the hit before
 * it had resolved which stream the caller asked for — so `?streamId=low`
 * silently returned whatever was already cached. In production that meant the
 * 4K main frame: probing a live camera with `low`, `sub` and `high` returned
 * three byte-identical 1.2 MB responses. The parameter existed, was documented,
 * and did nothing.
 *
 * Two views still need to ask a device-wide question — "when did this camera
 * last produce a frame" (`getSnapshotOverview`, `getStatus`) — so
 * {@link SnapshotCache.latest} answers it across streams rather than making
 * every caller guess a key.
 */

/** The cached frame. Structurally the addon's `SnapshotImage` — declared here
 *  rather than imported so the cache does not depend on the 1,100-line addon. */
export interface SnapshotCacheImage {
  readonly base64: string
  readonly contentType: string
}

export interface SnapshotCacheEntry {
  readonly data: SnapshotCacheImage
  readonly ts: number
  /** Stream id resolved at capture time — 'high' | 'mid' | 'low' | custom | null. */
  readonly streamId: string | null
}

/** A request with no explicit stream is its OWN entry, not a wildcard: the
 *  per-device preference decides what it captures, and conflating it with an
 *  explicit request is how the original bug read. */
const AUTO = 'auto'

function keyOf(deviceId: number, streamId: string | undefined): string {
  return `${deviceId}:${streamId ?? AUTO}`
}

/**
 * Byte budget across every cached frame.
 *
 * The cache shipped with NO bound of any kind: no TTL, no LRU, no size cap. It
 * holds base64 JPEG payloads — a 4K main-stream frame is ~1.6 MB as base64 —
 * keyed by (device, stream), so the ceiling was "every camera × every stream it
 * was ever asked for", which is not a ceiling.
 *
 * 64 MiB is roughly 40 main-stream frames, comfortably above the live 27-camera
 * roster's working set (the whole `snapshot` runner measures 185 MB RSS, of
 * which the node baseline is ~130 MB), so nothing an operator does today starts
 * evicting. It exists so a roster that grows, or a device that gets probed on
 * many stream ids, cannot walk this structure into the OOM.
 */
export const SNAPSHOT_CACHE_MAX_BYTES: number = 64 * 1024 * 1024

/**
 * Drop an entry nobody has READ for this long.
 *
 * Deliberately an IDLE timeout and not a capture-age one. Capture age is
 * already governed per device by `snapshotMaxAgeS` (default 15s, but one HOUR
 * for battery cameras), so a TTL on age would either fight those rules or have
 * to sit above the largest of them and bound nothing. "Nobody has looked at
 * this in an hour" is orthogonal to freshness and is the actual condition under
 * which the bytes are dead weight — a removed camera, an unreachable one, a
 * stream id probed once by a debug view.
 */
export const SNAPSHOT_CACHE_IDLE_TTL_MS = 3_600_000

/** Why an entry was dropped. `budget` = the byte ceiling; `idle` = unread for
 *  {@link SNAPSHOT_CACHE_IDLE_TTL_MS}. */
export type SnapshotCacheEvictReason = 'budget' | 'idle'

/** Notified for every eviction so the owner can put it on the record with the
 *  device tag. A cached frame that vanishes is the explanation for a later
 *  capture that did not have to happen; silence reads as "never happened". */
export type SnapshotCacheEvictListener = (
  deviceId: number,
  streamId: string | null,
  reason: SnapshotCacheEvictReason,
) => void

export interface SnapshotCacheOptions {
  /** Total base64 bytes held across all entries. Default {@link SNAPSHOT_CACHE_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Idle timeout. Default {@link SNAPSHOT_CACHE_IDLE_TTL_MS}. */
  readonly idleTtlMs?: number
  /** Injected clock — the bounds must be testable without waiting an hour. */
  readonly now?: () => number
  readonly onEvict?: SnapshotCacheEvictListener
}

/** What the cache retains per key: the entry, its cost, and when it was last read. */
interface SnapshotCacheSlot {
  readonly entry: SnapshotCacheEntry
  readonly deviceId: number
  readonly bytes: number
  lastAccessAt: number
}

export class SnapshotCache {
  private readonly byKey = new Map<string, SnapshotCacheSlot>()
  /** deviceId → its live keys, so invalidation is O(streams) not O(cache). */
  private readonly keysByDevice = new Map<number, Set<string>>()
  private readonly maxBytes: number
  private readonly idleTtlMs: number
  private readonly now: () => number
  private readonly onEvict: SnapshotCacheEvictListener | undefined
  private totalBytes = 0

  constructor(options: SnapshotCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? SNAPSHOT_CACHE_MAX_BYTES
    this.idleTtlMs = options.idleTtlMs ?? SNAPSHOT_CACHE_IDLE_TTL_MS
    this.now = options.now ?? ((): number => Date.now())
    this.onEvict = options.onEvict
  }

  get(deviceId: number, streamId: string | undefined): SnapshotCacheEntry | undefined {
    return this.read(keyOf(deviceId, streamId))
  }

  set(deviceId: number, streamId: string | undefined, entry: SnapshotCacheEntry): void {
    const key = keyOf(deviceId, streamId)
    // Replacing an entry releases the old payload's cost first, or the running
    // total drifts up forever and the budget fires on a cache that is not full.
    this.forget(key)
    this.byKey.set(key, {
      entry,
      deviceId,
      bytes: entry.data.base64.length,
      lastAccessAt: this.now(),
    })
    this.totalBytes += entry.data.base64.length
    const keys = this.keysByDevice.get(deviceId) ?? new Set<string>()
    keys.add(key)
    this.keysByDevice.set(deviceId, keys)
    this.enforceBudget(key)
  }

  /** The newest entry for a device, whichever stream produced it. */
  latest(deviceId: number): SnapshotCacheEntry | undefined {
    let newest: SnapshotCacheEntry | undefined
    // Snapshot the key set: `read` may delete an idle-expired key underneath us.
    for (const key of [...(this.keysByDevice.get(deviceId) ?? [])]) {
      const entry = this.read(key)
      if (entry !== undefined && (newest === undefined || entry.ts > newest.ts)) newest = entry
    }
    return newest
  }

  /** Base64 bytes currently retained. The number the budget is enforced on. */
  sizeBytes(): number {
    return this.totalBytes
  }

  /** Entries currently retained. */
  entryCount(): number {
    return this.byKey.size
  }

  /** Read through the idle timeout: an entry nobody has touched inside
   *  `idleTtlMs` is dropped here rather than on a sweep, so the cost is paid by
   *  the caller that proves it was not wanted. */
  private read(key: string): SnapshotCacheEntry | undefined {
    const slot = this.byKey.get(key)
    if (slot === undefined) return undefined
    const at = this.now()
    if (at - slot.lastAccessAt > this.idleTtlMs) {
      this.evict(key, 'idle')
      return undefined
    }
    slot.lastAccessAt = at
    return slot.entry
  }

  /** Evict least-recently-ACCESSED first until the budget holds. `protectedKey`
   *  is the entry just written — evicting it would make `set` a no-op. */
  private enforceBudget(protectedKey: string): void {
    if (this.totalBytes <= this.maxBytes) return
    const coldestFirst = [...this.byKey.entries()]
      .filter(([key]) => key !== protectedKey)
      .toSorted((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
    for (const [key] of coldestFirst) {
      if (this.totalBytes <= this.maxBytes) return
      this.evict(key, 'budget')
    }
  }

  private evict(key: string, reason: SnapshotCacheEvictReason): void {
    const slot = this.byKey.get(key)
    if (slot === undefined) return
    this.forget(key)
    this.onEvict?.(slot.deviceId, slot.entry.streamId, reason)
  }

  /** Remove a key and everything that indexes or accounts for it. */
  private forget(key: string): void {
    const slot = this.byKey.get(key)
    if (slot === undefined) return
    this.totalBytes -= slot.bytes
    this.byKey.delete(key)
    const keys = this.keysByDevice.get(slot.deviceId)
    if (keys !== undefined) {
      keys.delete(key)
      if (keys.size === 0) this.keysByDevice.delete(slot.deviceId)
    }
  }

  /**
   * Drop every stream of one device.
   *
   * Device-wide on purpose: a settings change or an operator refresh
   * invalidates the CAMERA, and leaving a sibling entry behind would keep
   * serving the pre-change frame from the other key.
   */
  deleteDevice(deviceId: number): void {
    // Spread first: `forget` deletes from the very Set being iterated.
    for (const key of [...(this.keysByDevice.get(deviceId) ?? [])]) this.forget(key)
    this.keysByDevice.delete(deviceId)
  }

  clear(): void {
    this.byKey.clear()
    this.keysByDevice.clear()
    this.totalBytes = 0
  }
}
