/**
 * `ParkedFrameStore` — the per-track PARCEL a node keeps once the hub has
 * judged a frame relevant to a track
 * ([D422](../../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)).
 *
 * ## What a parcel is
 *
 * One JPEG, encoded ONCE from pixels this node already held, keyed by
 * `(deviceId, trackId, kind)`. The hub's `BestDetectionTracker` decides that a
 * frame is a track's best and orders a PARK while the frame's handle is still
 * young (150–500 ms after decode); every later consumer — the `keyFrame`
 * writer, the best-shot `thumbnail`, the detail plane's full-frame rung —
 * retrieves by that key. A lookup keyed by a track cannot miss on AGE, because
 * the pixels were copied before they could expire.
 *
 * `trackId` is OPAQUE here. The runner knows nothing about tracks (nothing in
 * `pipeline-runner/` names one); the hub owns tracking and the ranking, and
 * this store only keeps what it is told to keep, under the bounds below.
 *
 * ## The bounds, stated where they are spent
 *
 * - {@link PARKED_FRAMES_PER_DEVICE_MAX} parcels per camera. A burst of
 *   subjects on one camera evicts that camera's OLDEST parcel first, never a
 *   neighbour's — the same fairness rule `RetainedFrameStore` learned on
 *   2026-07-19.
 * - {@link PARKED_FRAME_BUDGET_BYTES} per node. Past it the globally oldest
 *   parcel goes, whatever its device (the OOM guard wins over fairness).
 * - {@link PARKED_FRAME_MAX_AGE_MS}: a track the hub forgot to release ages
 *   out. The hub releases a track's parcels when the track closes; this is the
 *   backstop for a lost release, not a lifetime.
 *
 * A park is never REFUSED for space: the parcel being parked is the frame that
 * was just judged to matter, and the one it evicts was judged to matter longer
 * ago. Eviction is reported through `onEvict` so a camera whose parcels keep
 * leaving early can be named.
 *
 * ## Idempotent, replacing, and safe against a wire race
 *
 * A park for a key that already holds a parcel REPLACES it — the ranking that
 * decided "better" lives on the hub and this store adds no second opinion
 * (D62). The one thing it does check is ORDER: two parks in flight for the
 * same key can land out of sequence, and the loser must not overwrite the
 * winner, so a park whose frame instant is older than the held parcel's is
 * ignored and reported as such.
 */

/** What a consumer asks for, by name. Mirrors `ParkedFrameKind` on the cap. */
export type ParkedFrameKind = 'keyFrame' | 'thumbnail'

/** Per-camera parcel bound. 24 live tracks × two kinds on one camera is a
 *  crowd scene; past that the camera's oldest parcel leaves first. */
export const PARKED_FRAMES_PER_DEVICE_MAX = 48

/**
 * Per-node parcel budget (MB). A 4K `keyFrame` JPEG at quality 90 measures
 * ~1.5–2.5 MB (`scene-tile.ts` sizing); a `thumbnail` slab is ~60–120 KB. 64 MB
 * therefore holds ≥ 24 concurrent 4K key frames plus their thumbnails — above
 * the 12-session peak measured on this cluster (D397) at two tracks each. It
 * is spent INSTEAD of full-resolution surfaces, not beside them: once nothing
 * asks late, the 160 MB retained store and the 4 096-entry registry shrink to
 * the enrichment horizon (the step after this one).
 */
export const PARKED_FRAME_BUDGET_MB = 64

/** {@link PARKED_FRAME_BUDGET_MB} in bytes. */
export const PARKED_FRAME_BUDGET_BYTES = PARKED_FRAME_BUDGET_MB * 1024 * 1024

/**
 * Hard ceiling on a parcel's life. The hub releases a track's parcels at
 * close (30 s after `lastSeen`); a session hold is at most 600 s. Ten minutes
 * past the park only a LOST release is still holding — a hub restart mid-track,
 * a dropped RPC — and RAM must not wait for it.
 */
export const PARKED_FRAME_MAX_AGE_MS = 10 * 60_000

/** The parcel as parked: the runner's own JPEG and the instant it shows. */
export interface ParkedFrame {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  /** Frame instant (the hub's clock) the parcel was cut at — orders parks. */
  readonly timestamp: number
}

/** A parcel as retrieved: the park plus WHEN this node stored it. */
export interface RetrievedParkedFrame extends ParkedFrame {
  readonly parkedAt: number
}

/** What `park` did with the parcel it was handed. */
export type ParkVerdict = 'stored' | 'replaced' | 'older-ignored'

/** Why a parcel left without a release. */
export type ParkedFrameEvictCause = 'device-bound' | 'node-budget' | 'age'

export interface ParkedFrameEviction {
  readonly deviceId: number
  readonly trackId: string
  readonly kind: ParkedFrameKind
  readonly cause: ParkedFrameEvictCause
}

export interface ParkedFrameStoreOptions {
  /** Byte budget override (tests); defaults to {@link PARKED_FRAME_BUDGET_BYTES}. */
  readonly budgetBytes?: number
  /** Per-device bound override (tests); defaults to {@link PARKED_FRAMES_PER_DEVICE_MAX}. */
  readonly perDeviceMax?: number
  /** Age ceiling override (tests); defaults to {@link PARKED_FRAME_MAX_AGE_MS}. */
  readonly maxAgeMs?: number
  /** Clock override (tests). */
  readonly now?: () => number
  /** Fired when a parcel leaves for any reason but a release. */
  readonly onEvict?: (eviction: ParkedFrameEviction) => void
}

interface ParkedEntry {
  readonly deviceId: number
  readonly trackId: string
  readonly kind: ParkedFrameKind
  readonly frame: ParkedFrame
  readonly parkedAt: number
}

function keyOf(deviceId: number, trackId: string, kind: ParkedFrameKind): string {
  return `${deviceId}|${trackId}|${kind}`
}

export class ParkedFrameStore {
  private readonly budgetBytes: number
  private readonly perDeviceMax: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly onEvict: ((eviction: ParkedFrameEviction) => void) | undefined
  /** Insertion-ordered → the head is the globally oldest park. A replace
   *  re-inserts, so order IS park order. */
  private readonly entries = new Map<string, ParkedEntry>()
  /** Per-device keys in park order, mirroring {@link entries} for the bound. */
  private readonly perDeviceKeys = new Map<number, string[]>()
  private totalBytes = 0

  constructor(options: ParkedFrameStoreOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? PARKED_FRAME_BUDGET_BYTES
    this.perDeviceMax = options.perDeviceMax ?? PARKED_FRAMES_PER_DEVICE_MAX
    this.maxAgeMs = options.maxAgeMs ?? PARKED_FRAME_MAX_AGE_MS
    this.now = options.now ?? Date.now
    this.onEvict = options.onEvict
  }

  /** Number of parcels held (tests / metrics). */
  get size(): number {
    return this.entries.size
  }

  /** Bytes of JPEG held (tests / metrics). */
  get bytes(): number {
    return this.totalBytes
  }

  /**
   * Park one parcel. Replaces an existing parcel for the key unless the new
   * one shows an OLDER frame instant (a racing loser). Sweeps the age ceiling,
   * then enforces the per-device bound and the node budget — evicting the
   * oldest of the offending scope, never refusing the new parcel.
   */
  park(deviceId: number, trackId: string, kind: ParkedFrameKind, frame: ParkedFrame): ParkVerdict {
    const nowMs = this.now()
    this.sweepExpired(nowMs)
    const key = keyOf(deviceId, trackId, kind)
    const existing = this.entries.get(key)
    if (existing !== undefined && frame.timestamp < existing.frame.timestamp) {
      return 'older-ignored'
    }
    if (existing !== undefined) this.remove(key)
    this.entries.set(key, { deviceId, trackId, kind, frame, parkedAt: nowMs })
    const deviceKeys = this.perDeviceKeys.get(deviceId)
    if (deviceKeys) deviceKeys.push(key)
    else this.perDeviceKeys.set(deviceId, [key])
    this.totalBytes += frame.jpeg.byteLength
    this.enforceDeviceBound(deviceId)
    this.enforceBudget()
    return existing === undefined ? 'stored' : 'replaced'
  }

  /** The parcel for a key, or `null` — never anything else, never by handle. */
  get(deviceId: number, trackId: string, kind: ParkedFrameKind): RetrievedParkedFrame | null {
    const entry = this.entries.get(keyOf(deviceId, trackId, kind))
    if (entry === undefined) return null
    if (this.now() - entry.parkedAt > this.maxAgeMs) {
      this.evict(keyOf(deviceId, trackId, kind), 'age')
      return null
    }
    return { ...entry.frame, parkedAt: entry.parkedAt }
  }

  /** Drop every parcel of a track (the hub closed it). Returns how many left. */
  release(deviceId: number, trackId: string): number {
    const keys = (this.perDeviceKeys.get(deviceId) ?? []).filter(
      (key) => this.entries.get(key)?.trackId === trackId,
    )
    for (const key of keys) this.remove(key)
    return keys.length
  }

  /** What one camera is costing right now. */
  statsByDevice(deviceId: number): { readonly parcels: number; readonly bytes: number } {
    const keys = this.perDeviceKeys.get(deviceId) ?? []
    let bytes = 0
    for (const key of keys) bytes += this.entries.get(key)?.frame.jpeg.byteLength ?? 0
    return { parcels: keys.length, bytes }
  }

  /** Drop everything (addon shutdown). */
  clear(): void {
    this.entries.clear()
    this.perDeviceKeys.clear()
    this.totalBytes = 0
  }

  /** Age sweep from the head — insertion order is park order, so it stops at
   *  the first parcel still inside the ceiling. */
  private sweepExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.parkedAt <= this.maxAgeMs) return
      this.evict(key, 'age')
    }
  }

  private enforceDeviceBound(deviceId: number): void {
    const deviceKeys = this.perDeviceKeys.get(deviceId)
    while (deviceKeys !== undefined && deviceKeys.length > this.perDeviceMax) {
      const oldest = deviceKeys[0]
      if (oldest === undefined) break
      this.evict(oldest, 'device-bound')
    }
  }

  /** Globally oldest first, whatever its device; always keeps ≥ 1. */
  private enforceBudget(): void {
    for (const key of [...this.entries.keys()]) {
      if (this.totalBytes <= this.budgetBytes || this.entries.size <= 1) return
      this.evict(key, 'node-budget')
    }
  }

  private evict(key: string, cause: ParkedFrameEvictCause): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.remove(key)
    this.onEvict?.({
      deviceId: entry.deviceId,
      trackId: entry.trackId,
      kind: entry.kind,
      cause,
    })
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.totalBytes -= entry.frame.jpeg.byteLength
    const deviceKeys = this.perDeviceKeys.get(entry.deviceId)
    if (deviceKeys) {
      const idx = deviceKeys.indexOf(key)
      if (idx >= 0) deviceKeys.splice(idx, 1)
      if (deviceKeys.length === 0) this.perDeviceKeys.delete(entry.deviceId)
    }
  }
}

/**
 * The key prefix the hub parks a face's SOURCE frame under (D644). The hub
 * owns the key; the runner reads only this prefix, to keep those parcels in
 * their own budget. Mirrors `FACE_SOURCE_PARK_PREFIX` in addon-post-analysis
 * (`runtime/face-source-park-port.ts`) — both specs pin the literal.
 */
export const FACE_SOURCE_PARCEL_PREFIX = 'face-src:'

/** Face source parcels per camera. A 4K frame is 1.5–2.5 MB. */
export const FACE_SOURCE_PARCELS_PER_DEVICE_MAX = 4

/** Node budget for face source parcels, MB — SEPARATE from the track budget. */
export const FACE_SOURCE_PARCEL_BUDGET_MB = 16

/** Is this key a face source parcel? */
export function isFaceSourceParcelKey(trackId: string): boolean {
  return trackId.startsWith(FACE_SOURCE_PARCEL_PREFIX)
}

/** What one camera's parcels cost. */
export interface ParkedDeviceStats {
  readonly parcels: number
  readonly bytes: number
}

/** Construction options of the partitioned store. */
export interface PartitionedParkedFrameStoreOptions {
  readonly track?: ParkedFrameStoreOptions
  readonly faceSource?: ParkedFrameStoreOptions
}

/**
 * Track parcels and face source parcels in TWO stores with two budgets (D644).
 *
 * A face source parcel is a full native frame parked on every held best face.
 * In the shared store its eviction took the GLOBALLY oldest parcel — a
 * track's `keyFrame` or `thumbnail` — so a busy face scene could cost a track
 * its best frame (D58: media a later pass depends on must land). Here a face
 * parcel can only ever evict another face parcel.
 */
export class PartitionedParkedFrameStore {
  private readonly track: ParkedFrameStore
  private readonly faceSource: ParkedFrameStore

  constructor(options: PartitionedParkedFrameStoreOptions = {}) {
    this.track = new ParkedFrameStore(options.track)
    this.faceSource = new ParkedFrameStore({
      budgetBytes: FACE_SOURCE_PARCEL_BUDGET_MB * 1024 * 1024,
      perDeviceMax: FACE_SOURCE_PARCELS_PER_DEVICE_MAX,
      ...options.faceSource,
    })
  }

  private storeFor(trackId: string): ParkedFrameStore {
    return isFaceSourceParcelKey(trackId) ? this.faceSource : this.track
  }

  get size(): number {
    return this.track.size + this.faceSource.size
  }

  get bytes(): number {
    return this.track.bytes + this.faceSource.bytes
  }

  park(deviceId: number, trackId: string, kind: ParkedFrameKind, frame: ParkedFrame): ParkVerdict {
    return this.storeFor(trackId).park(deviceId, trackId, kind, frame)
  }

  get(deviceId: number, trackId: string, kind: ParkedFrameKind): RetrievedParkedFrame | null {
    return this.storeFor(trackId).get(deviceId, trackId, kind)
  }

  release(deviceId: number, trackId: string): number {
    return this.storeFor(trackId).release(deviceId, trackId)
  }

  statsByDevice(deviceId: number): ParkedDeviceStats {
    const a = this.track.statsByDevice(deviceId)
    const b = this.faceSource.statsByDevice(deviceId)
    return { parcels: a.parcels + b.parcels, bytes: a.bytes + b.bytes }
  }

  clear(): void {
    this.track.clear()
    this.faceSource.clear()
  }
}
