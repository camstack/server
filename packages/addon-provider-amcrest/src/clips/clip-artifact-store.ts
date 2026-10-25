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
 * Sized from what this camera really produces rather than from a sibling's
 * numbers: ten measured clips ran **33.4–72.9 MiB**, so the ten-file bound the
 * Hikvision scratch uses would be up to 730 MiB per camera. The BYTE bound is
 * the one that governs, and 400 MiB is roughly the six most recent clips —
 * enough that a surface scrolling a morning does not re-fetch, small enough
 * that a fleet of these does not become a second archive of the camera's
 * archive.
 */
export const CLIP_SCRATCH_MAX_FILES_PER_DEVICE = 8
export const CLIP_SCRATCH_MAX_BYTES_PER_DEVICE = 400 * 1024 * 1024

/**
 * Per-device bounds for the STILLS, which are a different artifact entirely.
 *
 * A still measured 22.7–35.5 KB against a clip's 33–73 MiB, and it is the
 * thing an operator scrolls past sixty of. It therefore OUTLIVES the media
 * scratch: that one holds eight clips and rolls, and a camera whose stills
 * lived in the same directory would lose the picture of every clip but the
 * last eight — and each of those pictures costs the camera a replay to make
 * again. Two thousand files and 64 MiB, the pair the sibling providers use;
 * at the measured size the FILE bound is the one that governs here.
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

interface ClipArtifactEntry {
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
}

/**
 * A clip key is `<startSec>-<endSec>` (`clip-identity.ts`). Anything else is
 * REFUSED rather than joined: a key reaches this from a URL path segment, and
 * a `..` in it is a write outside the scratch.
 */
const SAFE_KEY = /^[0-9]{1,20}-[0-9]{1,20}$/
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

  /** Is this a key this store will touch at all? Exposed so a ROUTE can refuse
   *  a bad segment by name before it reaches the filesystem. */
  static isSafeKey(clipKey: string): boolean {
    return SAFE_KEY.test(clipKey)
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
   * answers 204 is a request every tile makes and every tile loses.
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

  /** A scratch path to write INTO, with its directory made. */
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

  private async listEntries(deviceId: number): Promise<readonly ClipArtifactEntry[]> {
    let names: readonly string[]
    try {
      names = await readdir(this.dirFor(deviceId))
    } catch {
      return []
    }
    const out: ClipArtifactEntry[] = []
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
