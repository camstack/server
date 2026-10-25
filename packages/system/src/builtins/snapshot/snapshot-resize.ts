/**
 * Downscaling a captured frame to a card-sized thumbnail.
 *
 * Applied AFTER capture rather than during it, and that is deliberate: the two
 * capture paths (the vendor's native HTTP snapshot and the ffmpeg keyframe
 * grab) produce a JPEG by different routes, and only one of them has an
 * ffmpeg filter chain to hook into. Resizing the finished bytes gives both the
 * same behaviour with one implementation.
 *
 * ── Why sharp and not ffmpeg (2026-08-11) ─────────────────────────────────
 * This used to `spawn('ffmpeg')` per resize. The snapshot wrapper is a system
 * builtin, so it loads in the hub's ROOT process: sampled on the live hub,
 * ~1.6 of those children were running at any instant, every one of them
 * parented by the root PID.
 *
 * Be precise about what that cost the root process, because it is easy to
 * overstate. The transcode itself ran in the CHILD and was charged to ffmpeg
 * (16 % + 13 % of a core in that same sample), not to the parent. What the
 * parent paid was the fork, the exec, the JPEG written into one pipe and read
 * back out of the other, and the base64 — real event-loop work, on the loop
 * that also serves the tRPC API, but NOT the 52 ms below.
 *
 * Benchmarked in that container, 2560×1440 → 640 wide, wall-clock per resize:
 *
 *     ffmpeg   52.0 ms   (fork + exec + pipe round-trip + teardown)
 *     sharp     4.8 ms   (in-process libvips, on its own threadpool)
 *
 * So this removes ~29 % of a core of container CPU and the per-resize process
 * churn from the root process. It was NOT verified to be the cause of that
 * process sitting at 90 % — nobody has profiled it.
 *
 * `sharp` is not a new dependency: it is already a host-external
 * (`HOST_EXTERNAL_SPECIFIERS`), already resolved from the framework closure at
 * runtime, and already used by the terminal frame renderer. The build preset
 * keeps it out of the bundle, so this import costs nothing at pack time.
 *
 * The cost is still one resize per (device, stream, width) per cache window —
 * not one per request. What changed is what a resize COSTS.
 */

import sharp from 'sharp'

/** Runs the resize. Injected so the caller is testable without a real ffmpeg. */
export type JpegResizer = (bytes: Buffer, width: number) => Promise<Buffer>

export const RESIZE_TIMEOUT_MS = 10_000

/**
 * Encode quality for a derived thumbnail. Matches what the ffmpeg path
 * produced (`-q:v 5` on the mjpeg encoder) closely enough that no card visibly
 * changes — this migration is about COST, not about re-tuning the picture.
 */
const JPEG_QUALITY = 82

/**
 * Scale to `width`, preserving aspect ratio.
 *
 * Rejects on failure or timeout. It NEVER falls back to the original silently —
 * a caller that quietly served the 4K frame when the resize failed would
 * reproduce exactly the bug this whole module exists to fix, and nobody would
 * see it. The caller decides, and logs.
 *
 * It DOES upscale a source narrower than `width`, and that is deliberate. A
 * `withoutEnlargement: true` was tried first — it is the obvious saving, since
 * upscaling pays encode cost for a blurrier, larger image. But the caller
 * stamps the response ETag from the width it asked for, and its resize-FAILURE
 * path already returns `width: undefined` specifically so a response can never
 * "claim a width the bytes do not have". Silently returning 320 px bytes for a
 * `w=640` request breaks that invariant on the SUCCESS path, where nobody is
 * looking. Honest output width beats a few saved pixels; revisit only together
 * with the ETag.
 */
export function resizeJpeg(
  bytes: Buffer,
  width: number,
  timeoutMs: number = RESIZE_TIMEOUT_MS,
): Promise<Buffer> {
  const work = sharp(bytes)
    .resize({ width })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
    .toBuffer()
    .then((out) => {
      if (out.length === 0) throw new Error('snapshot resize produced no bytes')
      return out
    })

  // libvips runs off-thread and does not hang the way a child process can, but
  // the contract this replaced was bounded and callers rely on that — an
  // unbounded await here would strand a snapshot request forever on a
  // pathological input.
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`snapshot resize timed out after ${String(timeoutMs)}ms`)),
      timeoutMs,
    )
  })
  return Promise.race([work, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

interface VariantSlot {
  readonly bytes: Buffer
  /** `capturedAt` of the FRAME this was derived from — not when it was
   *  resized. A variant is only valid for the frame it came from. */
  readonly sourceTs: number
  readonly deviceId: number
  /** Last read, for LRU order under the byte budget. */
  lastAccessAt: number
}

/**
 * Resized frames, keyed by (device, stream, width, state treatment) AND
 * validated against the source frame's timestamp.
 *
 * The timestamp is the whole correctness argument: a variant outlives nothing.
 * When the underlying frame is recaptured its `capturedAt` moves, every variant
 * derived from the old one stops matching, and the next request re-derives.
 * Without that check a card would keep showing a thumbnail of a frame the
 * full-size view had already replaced.
 */
/**
 * Byte budget across every retained variant.
 *
 * Variants are small individually (a card-sized JPEG is tens of KB) but the key
 * space is a product — device × stream × width × state treatment — and the map
 * had no cap at all. 16 MiB is hundreds of thumbnails, far beyond any real
 * roster's working set, and turns an unbounded product into a ceiling.
 */
export const SNAPSHOT_VARIANT_CACHE_MAX_BYTES: number = 16 * 1024 * 1024

export interface SnapshotVariantCacheOptions {
  /** Total variant bytes retained. Default {@link SNAPSHOT_VARIANT_CACHE_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Injected clock, so LRU order is testable without real time passing. */
  readonly now?: () => number
}

export class SnapshotVariantCache {
  private readonly byKey = new Map<string, VariantSlot>()
  private readonly keysByDevice = new Map<number, Set<string>>()
  private readonly maxBytes: number
  private readonly now: () => number
  private totalBytes = 0

  constructor(options: SnapshotVariantCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? SNAPSHOT_VARIANT_CACHE_MAX_BYTES
    this.now = options.now ?? ((): number => Date.now())
  }

  private static key(
    deviceId: number,
    streamId: string | undefined,
    width: number,
    variantKey: string | undefined,
  ): string {
    return `${deviceId}:${streamId ?? 'auto'}:${width}:${variantKey ?? 'raw'}`
  }

  /** The variant for this exact frame, or undefined when it is missing or was
   *  derived from an older capture.
   *
   *  A superseded variant is DELETED here, not merely reported missing. It used
   *  to be left in the map: unreachable by every future read (its `sourceTs` can
   *  never match again) and removed by nothing, so every recapture added a dead
   *  key. Returning `undefined` while retaining the bytes is the leak. */
  get(
    deviceId: number,
    streamId: string | undefined,
    width: number,
    sourceTs: number,
    variantKey?: string,
  ): Buffer | undefined {
    const key = SnapshotVariantCache.key(deviceId, streamId, width, variantKey)
    const slot = this.byKey.get(key)
    if (slot === undefined) return undefined
    if (slot.sourceTs !== sourceTs) {
      this.forget(key)
      return undefined
    }
    slot.lastAccessAt = this.now()
    return slot.bytes
  }

  set(
    deviceId: number,
    streamId: string | undefined,
    width: number,
    sourceTs: number,
    bytes: Buffer,
    variantKey?: string,
  ): void {
    const key = SnapshotVariantCache.key(deviceId, streamId, width, variantKey)
    // Releases the previous payload's cost before adding the new one.
    this.forget(key)
    this.byKey.set(key, { bytes, sourceTs, deviceId, lastAccessAt: this.now() })
    this.totalBytes += bytes.byteLength
    const keys = this.keysByDevice.get(deviceId) ?? new Set<string>()
    keys.add(key)
    this.keysByDevice.set(deviceId, keys)
    this.enforceBudget(key)
  }

  /** Variant bytes currently retained. */
  sizeBytes(): number {
    return this.totalBytes
  }

  /** Variants currently retained — including any that are no longer readable.
   *  The number that used to only ever go up. */
  entryCount(): number {
    return this.byKey.size
  }

  /** Evict least-recently-accessed first until the budget holds. */
  private enforceBudget(protectedKey: string): void {
    if (this.totalBytes <= this.maxBytes) return
    const coldestFirst = [...this.byKey.entries()]
      .filter(([key]) => key !== protectedKey)
      .toSorted((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
    for (const [key] of coldestFirst) {
      if (this.totalBytes <= this.maxBytes) return
      this.forget(key)
    }
  }

  private forget(key: string): void {
    const slot = this.byKey.get(key)
    if (slot === undefined) return
    this.totalBytes -= slot.bytes.byteLength
    this.byKey.delete(key)
    const keys = this.keysByDevice.get(slot.deviceId)
    if (keys !== undefined) {
      keys.delete(key)
      if (keys.size === 0) this.keysByDevice.delete(slot.deviceId)
    }
  }

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
