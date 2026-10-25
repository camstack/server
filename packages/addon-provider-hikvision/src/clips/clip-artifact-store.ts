/**
 * The playback scratch: `<dataDir>/clip-media/<deviceId>/<clipKey>.mp4`,
 * IMMUTABLE, per-device LRU.
 *
 * Deliberately outside the `eventMedia` storage class and outside the
 * post-analysis retention sweep (D549 13): these are derived artifacts of a
 * catalog whose retention is the CAMERA's own. A sweep that deleted them would
 * only make the surface re-fetch them, and one that kept them would hold
 * copies of recordings the camera has already rolled over.
 *
 * ## Why immutable
 *
 * A clip is a file and its bytes do not change, so a write to a key that
 * already exists is a bug, not an update. The store keeps what is there, which
 * also means two racing fetches cost one file.
 *
 * ## Why presence is a stat and not a memory of having written
 *
 * The claim has to survive a restart, a manual delete and a half-finished
 * write, so it is answered by the filesystem every time — and a zero-length
 * file is not a clip.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Per-device bounds.
 *
 * Ten files and 200 MB, the same shape the Reolink scratch uses — but a
 * Hikvision clip is the 4K MAIN copy and there is no sub twin to fall back to
 * (`clip-twins.ts`), so ten files here is up to ten 40 MB segments. The BYTE
 * bound is what really governs, and it is the one that bites first.
 */
export const CLIP_SCRATCH_MAX_FILES_PER_DEVICE = 10
export const CLIP_SCRATCH_MAX_BYTES_PER_DEVICE = 200 * 1024 * 1024

/**
 * Per-device bounds for the STILLS, which are a different artifact entirely.
 *
 * A still is ~30 KB against a clip's 40 MB, and it is the thing an operator
 * scrolls past sixty of. It therefore outlives the media it was cut from: the
 * clip scratch holds ten segments and rolls, and a camera whose stills lived
 * in the same directory would lose the picture of every clip but the last ten.
 * Two thousand files and 64 MiB — the same pair the Reolink store uses, and
 * the byte bound still governs.
 */
export const THUMB_MAX_FILES_PER_DEVICE = 2_000
export const THUMB_MAX_BYTES_PER_DEVICE = 64 * 1024 * 1024

export interface ClipArtifactStoreOptions {
  /** The addon's data dir. */
  readonly root: string
  /**
   * The subdirectory, and with it WHICH artifact this store holds.
   *
   * Parameterised rather than fixed so the media scratch and the still cache
   * are one algorithm with two sets of bounds. Two classes would be two places
   * for the immutability rule, the safe-key rule and the eviction order to
   * drift apart.
   */
  readonly kind?: string
  /** Including the dot. Only files carrying it are counted or evicted. */
  readonly extension?: string
  readonly maxFilesPerDevice?: number
  readonly maxBytesPerDevice?: number
}

interface Entry {
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
}

/** A clip key is a hex digest. Anything else is refused rather than joined. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/
export const CLIP_MEDIA_KIND = 'clip-media'
export const CLIP_MEDIA_EXTENSION = '.mp4'
export const CLIP_THUMB_KIND = 'clip-thumbs'
export const CLIP_THUMB_EXTENSION = '.jpg'

export class ClipArtifactStore {
  private readonly maxFiles: number
  private readonly maxBytes: number
  private readonly kind: string
  private readonly extension: string

  constructor(private readonly options: ClipArtifactStoreOptions) {
    this.maxFiles = options.maxFilesPerDevice ?? CLIP_SCRATCH_MAX_FILES_PER_DEVICE
    this.maxBytes = options.maxBytesPerDevice ?? CLIP_SCRATCH_MAX_BYTES_PER_DEVICE
    this.kind = options.kind ?? CLIP_MEDIA_KIND
    this.extension = options.extension ?? CLIP_MEDIA_EXTENSION
  }

  private dirFor(deviceId: number): string {
    return join(this.options.root, this.kind, String(deviceId))
  }

  pathFor(deviceId: number, clipKey: string): string {
    return join(this.dirFor(deviceId), `${clipKey}${this.extension}`)
  }

  /**
   * Is there really a file here?
   *
   * THE VOUCH. A provider says `thumbnail: <url>` only when this answered
   * true, because that field means "a still exists" and a URL that then
   * answers 204 is a request every tile makes and every tile loses (D549 5).
   */
  async has(deviceId: number, clipKey: string): Promise<boolean> {
    return (await this.pathIfPresent(deviceId, clipKey)) !== null
  }

  /** The bytes, or `null` — never a zero-length file dressed as a still. */
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
   * Write bytes under a key, immutably, and enforce the bounds.
   *
   * Temp-then-rename, so a crash never leaves a truncated file under the real
   * key — and a key already present WINS, so two racing mints cost one file.
   */
  async put(deviceId: number, clipKey: string, bytes: Buffer): Promise<string> {
    const existing = await this.pathIfPresent(deviceId, clipKey)
    if (existing !== null) return existing
    const temp = await this.reserve(deviceId, clipKey)
    await writeFile(temp, bytes)
    return await this.publish(deviceId, clipKey, temp)
  }

  /** A scratch path to mux INTO, with its directory made. */
  async reserve(deviceId: number, clipKey: string): Promise<string> {
    if (!SAFE_KEY.test(clipKey)) {
      throw new Error(`clip artifact store: refused key "${clipKey}" — not a safe artifact key`)
    }
    await mkdir(this.dirFor(deviceId), { recursive: true })
    return `${this.pathFor(deviceId, clipKey)}.${String(process.pid)}.part`
  }

  /** Present AND carrying bytes — never a memory of having written one. */
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

  /**
   * Publish a reserved path under its key and enforce the bounds.
   *
   * A key already present wins: artifacts are immutable, and the temp file is
   * removed rather than renamed over it.
   */
  async publish(deviceId: number, clipKey: string, tempPath: string): Promise<string> {
    const existing = await this.pathIfPresent(deviceId, clipKey)
    if (existing !== null) {
      await rm(tempPath, { force: true })
      return existing
    }
    const path = this.pathFor(deviceId, clipKey)
    await rename(tempPath, path)
    await this.enforceBounds(deviceId)
    return path
  }

  async forgetDevice(deviceId: number): Promise<void> {
    await rm(this.dirFor(deviceId), { recursive: true, force: true })
  }

  private async listEntries(deviceId: number): Promise<readonly Entry[]> {
    let names: string[]
    try {
      names = await readdir(this.dirFor(deviceId))
    } catch {
      return []
    }
    const out: Entry[] = []
    for (const name of names) {
      if (!name.endsWith(this.extension)) continue
      const path = join(this.dirFor(deviceId), name)
      try {
        const info = await stat(path)
        if (info.isFile()) out.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
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
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of entries) {
      if (files <= this.maxFiles && bytes <= this.maxBytes) break
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
