/**
 * The addon's own artifact store — clip thumbnails and the playback scratch.
 *
 * `<dataDir>/<kind>/<deviceId>/<clipKey><ext>`, files IMMUTABLE, per-device
 * LRU. Deliberately OUTSIDE the `eventMedia` class and outside the
 * post-analysis retention sweep (D549 13): these are derived artifacts of a
 * catalog whose retention is the camera's own, so a sweep that deleted them
 * would only make the surface re-mint them, and a sweep that KEPT them would
 * hold pictures of recordings the camera has already rolled over.
 *
 * "As artifacts" was offered and declined: an artifact is an operator-authored
 * export with an id and an expiry, and a cache is neither.
 *
 * ## Why immutable
 *
 * A clip is a FILE. Its first frame does not change. So a write to a key that
 * already exists is a bug, not an update — and the store refuses it silently
 * rather than paying the I/O, which also means two racing mints cost one file.
 *
 * ## Why the vouch is a stat, not a memory of having written
 *
 * The provider emits `thumbnail` only for a JPEG really on disk. That claim
 * must survive a restart, a manual delete and a half-finished write, so it is
 * answered by the filesystem every time and a zero-length file is NOT a
 * thumbnail.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Per-device bounds for the thumbnail cache (D549 5/13). */
export const THUMB_MAX_FILES_PER_DEVICE = 2_000
export const THUMB_MAX_BYTES_PER_DEVICE = 64 * 1024 * 1024

/** Per-device bounds for the playback scratch (D549 6). */
export const CLIP_SCRATCH_MAX_FILES_PER_DEVICE = 10
export const CLIP_SCRATCH_MAX_BYTES_PER_DEVICE = 200 * 1024 * 1024

/**
 * A prefetch declines once the device's LRU is this full. A prefetch NEVER
 * evicts — eviction happens only on an interactive mint — so it can never push
 * out what the operator is about to open (D549 16).
 */
export const PREFETCH_HEADROOM_FRACTION = 0.1

export interface ClipArtifactStoreOptions {
  /** The addon's data dir. */
  readonly root: string
  /** Sub-directory: `clip-thumbs` | `clip-media`. */
  readonly kind: string
  readonly maxFilesPerDevice: number
  readonly maxBytesPerDevice: number
  /** Including the dot. */
  readonly extension: string
}

interface Entry {
  readonly key: string
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
}

/** A clip key is a hex digest. Anything else is refused rather than joined. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/

export class ClipArtifactStore {
  constructor(private readonly options: ClipArtifactStoreOptions) {}

  private assertKey(clipKey: string): void {
    if (!SAFE_KEY.test(clipKey)) {
      throw new Error(`clip artifact store: refused key "${clipKey}" — not a safe artifact key`)
    }
  }

  async deviceDir(deviceId: number): Promise<string> {
    const dir = join(this.options.root, this.options.kind, String(deviceId))
    await mkdir(dir, { recursive: true })
    return dir
  }

  private pathFor(deviceId: number, clipKey: string): string {
    return join(
      this.options.root,
      this.options.kind,
      String(deviceId),
      `${clipKey}${this.options.extension}`,
    )
  }

  /** The vouch: a file that exists AND carries bytes. */
  async has(deviceId: number, clipKey: string): Promise<boolean> {
    if (!SAFE_KEY.test(clipKey)) return false
    return (await this.pathIfPresent(deviceId, clipKey)) !== null
  }

  async pathIfPresent(deviceId: number, clipKey: string): Promise<string | null> {
    if (!SAFE_KEY.test(clipKey)) return null
    const path = this.pathFor(deviceId, clipKey)
    try {
      const info = await stat(path)
      return info.isFile() && info.size > 0 ? path : null
    } catch {
      return null
    }
  }

  async read(deviceId: number, clipKey: string): Promise<Buffer | null> {
    const path = await this.pathIfPresent(deviceId, clipKey)
    if (path === null) return null
    try {
      return await readFile(path)
    } catch {
      return null
    }
  }

  /**
   * Write an artifact and enforce the bounds. A key already present is left
   * exactly as it is — artifacts are immutable and two racing mints cost one
   * file. The write is atomic (temp + rename) so a crash never leaves a
   * truncated file the vouch would believe.
   */
  async put(deviceId: number, clipKey: string, bytes: Buffer): Promise<string> {
    this.assertKey(clipKey)
    const existing = await this.pathIfPresent(deviceId, clipKey)
    if (existing !== null) return existing
    const dir = await this.deviceDir(deviceId)
    const path = join(dir, `${clipKey}${this.options.extension}`)
    const temp = `${path}.${process.pid}.part`
    await writeFile(temp, bytes)
    await rename(temp, path)
    await this.enforceBounds(deviceId)
    return path
  }

  /** True while a PREFETCH may still mint into this device's cache. */
  async hasHeadroomForPrefetch(deviceId: number): Promise<boolean> {
    const entries = await this.listEntries(deviceId)
    const files = entries.length
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0)
    const fileHeadroom = 1 - files / this.options.maxFilesPerDevice
    const byteHeadroom = 1 - bytes / this.options.maxBytesPerDevice
    return Math.min(fileHeadroom, byteHeadroom) > PREFETCH_HEADROOM_FRACTION
  }

  async forgetDevice(deviceId: number): Promise<void> {
    await rm(join(this.options.root, this.options.kind, String(deviceId)), {
      recursive: true,
      force: true,
    })
  }

  private async listEntries(deviceId: number): Promise<readonly Entry[]> {
    const dir = join(this.options.root, this.options.kind, String(deviceId))
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out: Entry[] = []
    for (const name of names) {
      if (!name.endsWith(this.options.extension)) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (!info.isFile()) continue
        out.push({
          key: name.slice(0, -this.options.extension.length),
          path,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
        })
      } catch {
        // Raced with an eviction. Nothing to count.
      }
    }
    return out
  }

  /** Oldest-first eviction until BOTH bounds hold. */
  private async enforceBounds(deviceId: number): Promise<void> {
    const entries = [...(await this.listEntries(deviceId))].toSorted(
      (a, b) => a.mtimeMs - b.mtimeMs,
    )
    let files = entries.length
    let bytes = entries.reduce((sum, e) => sum + e.bytes, 0)
    for (const entry of entries) {
      if (files <= this.options.maxFilesPerDevice && bytes <= this.options.maxBytesPerDevice) break
      try {
        await rm(entry.path, { force: true })
        files -= 1
        bytes -= entry.bytes
      } catch {
        // A file we cannot remove still counts; the next write tries again.
      }
    }
  }
}
