/**
 * The images this hub has handed to Alexa (R2, D773), each behind a signed,
 * short-lived URL.
 *
 * Amazon's rules for a SnapshotProvider image URI (device-apis/
 * alexa-smartvision-snapshotprovider): HTTPS, NOT public — Alexa presents the
 * user's access token — valid about ten minutes, HTTP 410 once expired, no
 * redirects. So every image is minted for ONE linked user and ONE device, kept
 * in memory until it expires, and addressed by a random id whose URL carries an
 * HMAC over `(imageId, exp)`. A hub restart forgets them all; Alexa then gets a
 * 410 and asks for a new snapshot, which is the documented recovery.
 *
 * Bounded by count and by bytes: Alexa refreshes a tile at most every
 * `minRefreshIntervalInSeconds` per camera, so a few hundred kilobytes per
 * camera is the steady state; the bound is what keeps a misbehaving client from
 * turning this into a memory leak.
 */
import { randomUUID } from 'node:crypto'
import { signExpiringUrl, verifyExpiringUrl } from '@camstack/types/node'

/** How long a minted image URL is valid — Amazon recommends ten minutes. */
export const SNAPSHOT_URL_TTL_MS = 10 * 60_000

/** Bound on entries holding pixels (GetSnapshot images, loaded lazy ones). */
const MAX_IMAGES = 128
/**
 * Bound on lazy entries not yet fetched (D779 amendment). They hold no pixels — a closure
 * over (device, track) — so the bound only guards against a runaway. It must
 * cover ten minutes of events: at the measured ~15 events/min, two URIs each,
 * the shared 128 bound evicted a URI ~4 min after Alexa was handed it.
 */
const MAX_LAZY_IMAGES = 4_096
const MAX_TOTAL_BYTES = 24 * 1024 * 1024

/** Reads (and Alexa-encodes) an image only when Alexa fetches it — R4's
 *  object-detection images (D779). `null` = no image (answered 410). */
export type LazyImageLoader = () => Promise<Buffer | null>

export interface StoredSnapshot {
  readonly imageId: string
  readonly deviceId: number
  /** The linked hub user the URL was minted for. */
  readonly userId: string
  /** The image; EMPTY for a lazy entry until it is loaded (see `bytesOf`). */
  readonly bytes: Buffer
  /** Present on a lazy entry that has not been loaded yet. */
  readonly load?: LazyImageLoader
  readonly contentType: 'image/jpeg'
  readonly capturedAt: number
  readonly expiresAt: number
}

export interface MintedSnapshot {
  readonly imageId: string
  readonly path: string
  readonly expiresAt: number
}

/** Why a fetch of a minted URL is refused. Every one is a 410 to Alexa
 *  (Amazon: an invalid or expired URI is answered 410, and Alexa re-asks). */
export type SnapshotLookup =
  | { readonly kind: 'found'; readonly image: StoredSnapshot }
  | { readonly kind: 'gone'; readonly reason: 'bad-signature' | 'expired' | 'unknown-image' }

export class SnapshotStore {
  private readonly images = new Map<string, StoredSnapshot>()
  private readonly loading = new Map<string, Promise<Buffer | null>>()
  private totalBytes = 0

  constructor(
    private readonly secret: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keep `bytes` for `userId`/`deviceId` and return the signed path to it. */
  mint(input: {
    readonly deviceId: number
    readonly userId: string
    readonly bytes: Buffer
    readonly capturedAt: number
  }): MintedSnapshot {
    this.prune()
    const imageId = randomUUID()
    const expiresAt = this.now() + SNAPSHOT_URL_TTL_MS
    const image: StoredSnapshot = {
      imageId,
      deviceId: input.deviceId,
      userId: input.userId,
      bytes: input.bytes,
      contentType: 'image/jpeg',
      capturedAt: input.capturedAt,
      expiresAt,
    }
    this.images.set(imageId, image)
    this.totalBytes += image.bytes.length
    this.evictOverBounds()
    const sig = signExpiringUrl(this.secret(), imageId, expiresAt)
    return {
      imageId,
      expiresAt,
      path: `/addon/export-alexa/snapshot/${imageId}.jpg?exp=${expiresAt}&sig=${sig}`,
    }
  }

  /**
   * Mint a URL whose pixels are read on the first authorised fetch (R4,
   * D779). Costs nothing until then, so a history page can carry twenty image
   * URIs without reading twenty images inside Alexa's response budget. Bounded
   * by count like every entry; by bytes once loaded.
   */
  mintLazy(input: {
    readonly deviceId: number
    readonly userId: string
    readonly capturedAt: number
    readonly load: LazyImageLoader
  }): MintedSnapshot {
    this.prune()
    const imageId = randomUUID()
    const expiresAt = this.now() + SNAPSHOT_URL_TTL_MS
    this.images.set(imageId, {
      imageId,
      deviceId: input.deviceId,
      userId: input.userId,
      bytes: Buffer.alloc(0),
      load: input.load,
      contentType: 'image/jpeg',
      capturedAt: input.capturedAt,
      expiresAt,
    })
    this.evictOverBounds()
    const sig = signExpiringUrl(this.secret(), imageId, expiresAt)
    return {
      imageId,
      expiresAt,
      path: `/addon/export-alexa/snapshot/${imageId}.jpg?exp=${expiresAt}&sig=${sig}`,
    }
  }

  /**
   * The bytes of a found image — loading a lazy one once (concurrent fetches
   * share the read). `null` when a lazy image has nothing to show.
   */
  async bytesOf(image: StoredSnapshot): Promise<Buffer | null> {
    if (image.load === undefined) return image.bytes
    let pending = this.loading.get(image.imageId)
    if (pending === undefined) {
      pending = image.load().catch(() => null)
      this.loading.set(image.imageId, pending)
    }
    const bytes = await pending
    this.loading.delete(image.imageId)
    if (bytes === null) return null
    const held = this.images.get(image.imageId)
    if (held !== undefined && held.load !== undefined) {
      this.images.set(image.imageId, { ...held, bytes, load: undefined })
      this.totalBytes += bytes.length
      this.evictOverBounds()
    }
    return bytes
  }

  /** Resolve a fetch of a minted URL. */
  lookup(imageId: string, exp: string | undefined, sig: string | undefined): SnapshotLookup {
    const now = this.now()
    const expMs = Number(exp)
    if (Number.isFinite(expMs) && expMs <= now) return { kind: 'gone', reason: 'expired' }
    if (!verifyExpiringUrl({ secret: this.secret(), id: imageId, exp, sig, nowMs: now })) {
      return { kind: 'gone', reason: 'bad-signature' }
    }
    const image = this.images.get(imageId)
    if (image === undefined || image.expiresAt <= now)
      return { kind: 'gone', reason: 'unknown-image' }
    return { kind: 'found', image }
  }

  /** Drop everything — the integration switch was turned off. */
  clear(): void {
    this.images.clear()
    this.loading.clear()
    this.totalBytes = 0
  }

  get size(): number {
    return this.images.size
  }

  private prune(): void {
    const now = this.now()
    for (const [id, image] of this.images) {
      if (image.expiresAt <= now) this.drop(id, image)
    }
  }

  private evictOverBounds(): void {
    let lazy = 0
    for (const image of this.images.values()) if (image.load !== undefined) lazy += 1
    let loaded = this.images.size - lazy
    // Map iteration order is insertion order: the oldest go first.
    for (const [id, image] of this.images) {
      const overLoaded = loaded > MAX_IMAGES || this.totalBytes > MAX_TOTAL_BYTES
      const overLazy = lazy > MAX_LAZY_IMAGES
      if (!overLoaded && !overLazy) return
      const isLazy = image.load !== undefined
      if (isLazy ? !overLazy : !overLoaded) continue
      this.drop(id, image)
      if (isLazy) lazy -= 1
      else loaded -= 1
    }
  }

  private drop(id: string, image: StoredSnapshot): void {
    this.images.delete(id)
    this.totalBytes -= image.bytes.length
  }
}
