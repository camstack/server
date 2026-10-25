/**
 * NcArtifactStore — the bytes behind a signed notification-artifact URL.
 *
 * A notification attachment is transient by nature: it exists to be fetched
 * once, by a notifier backend or the recipient's phone, within minutes of the
 * event. So this is a BOUNDED SCRATCH, not a media library — the durable copy
 * of an event's media already lives in the media store, and duplicating it here
 * permanently would grow without limit for no benefit.
 *
 * Two bounds, both enforced on every write (age first, then count): whichever
 * bites first, the oldest artifacts go. A sweep on boot clears whatever a crash
 * left behind — the directory is disposable by construction, so a lost file is
 * a 404 on one link, never a corrupt state.
 *
 * ## Where the bytes live (2026-09-04, D341)
 *
 * In the `artifacts` storage class — a SINGLETON location shared with the
 * recorder's exports tenant (`<root>/exports/<deviceId>/…`) — never the
 * addon's data dir. Sharing the location never means sharing a sweep: this
 * store walks only numeric camera buckets and only their `nc-artifacts`
 * subtrees, so the exports tenant is structurally out of reach of both the
 * bounds sweep and `clear()`. The operator's rule — *"le cartelle
 * addons non devono trasportare nulla"* — the addon data dir carries no
 * media: it is swept into every system backup (718 MB of artifacts were half
 * of one), it sits on the constrained appdata disk, and no storage-location
 * machinery can see it. Not a subtree of `eventMedia` either: an eventMedia
 * DRAIN moves media ROWS, and artifacts have none — the drain would be
 * incomplete by construction. Own class ⇒ own occupancy, own drain (stop →
 * copy → restart), own retention: the shelf bounds below ARE the class's
 * retention policy.
 *
 * `rootDir` is the RESOLVED root of the `artifacts` location (the
 * caller resolves it through the storage cap — never a hardcoded path; the
 * root differs per node and per deployment shape), and every artifact files
 * under
 *
 *   `<deviceId>/nc-artifacts/<id>.<ext>`          (scratch)
 *   `<deviceId>/nc-artifacts/kept/<id>.<ext>`     (retained shelf)
 *
 * Per-camera buckets, so occupancy counts device dirs and a camera's
 * artifacts are removable with the camera; the hourly index reconcile
 * (`NcArtifactIndex.prune`) already turns removed bytes into removed rows.
 * An artifact no caller can attribute to a camera goes to bucket `0` — the
 * repo's existing "not a camera" id (`PHOTO_ENROLL_DEVICE_ID`); a guessed
 * camera id would be worse than none.
 *
 * ## The retained shelf (`kept/`)
 *
 * Task #36 gave the viewer a browsable artifact index, and an index whose bytes
 * evaporate in six hours is an index of 404s. So a `put` may ask to be RETAINED:
 * the bytes then land on a second shelf with its OWN three bounds (age, count,
 * and — because a timelapse mp4 is megabytes — total BYTES). It is still a
 * scratch, just a longer one: the index row carries an `expiresAt` derived from
 * the same age bound, so "gone" is a state the viewer is told about rather than
 * a surprise 404.
 *
 * The shelf is a subdirectory ON PURPOSE. The scratch's listing skips
 * non-files, so the two shelves cannot sweep each other, and neither bound had
 * to learn about the other's entries. Both bounds are GLOBAL across camera
 * buckets — the shelf protects the disk, and a disk does not care which camera
 * the bytes belong to.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'

/**
 * The storage class the artifact shelf lives in: `artifacts`, SHARED with
 * the recorder's export MP4s (operator 2026-09-04: one generic class, not
 * one per producer). SINGLETON by declaration (`cardinality: 'single'` in
 * the manifest, declared identically by BOTH consuming addons — the registry
 * throws at kernel boot on a cardinality conflict): `upsertLocation` refuses
 * a second location of this type and the admin UI offers no "Add" — so there
 * is exactly one root, and the "which location do I write to" question does
 * not exist for this class. If that one location cannot be resolved, the
 * plane REFUSES to serve (bytes-only notifications, loud error) — it never
 * falls back to the addon data dir.
 */
export const ARTIFACTS_MEDIA_LOCATION = 'artifacts'

/** The artifact subtree name under `<deviceId>/`. */
export const NC_ARTIFACT_SUBTREE = 'nc-artifacts'

/**
 * The bucket for an artifact nobody can attribute to a camera — the same
 * "not a camera, the absence of one" id photo enrollment files gallery media
 * under (`PHOTO_ENROLL_DEVICE_ID`). Never a real device id.
 */
export const UNATTRIBUTED_DEVICE_BUCKET = 0

export interface NcArtifactStoreOptions {
  /**
   * The resolved root of the `artifacts` storage location (the
   * class's ONE location — it is a declared singleton). Resolved by the
   * caller through the storage cap — never a hardcoded path.
   */
  readonly rootDir: string
  readonly logger: IScopedLogger
  /** Scratch artifacts older than this are swept. Default 6 h. */
  readonly maxAgeMs?: number
  /** Hard cap on scratch artifacts. Default 500. */
  readonly maxEntries?: number
  /**
   * Retained artifacts older than this are swept. Default 14 days.
   *
   * `null` means no age bound at all — the operator's "keep forever". It is a
   * distinct value and not an omission, because omitting it means "use the
   * default", which is 14 days: the exact opposite. Since D485 this is the only
   * bound the retained shelf has, so `null` really does mean unbounded.
   */
  readonly keptMaxAgeMs?: number | null
  readonly now?: () => number
}

/** Per-write options. Absent ⇒ the six-hour scratch in the `0` bucket. */
export interface NcArtifactPutOptions {
  /** File on the retained shelf, so a viewer can still fetch it days later. */
  readonly retain?: boolean
  /**
   * The camera the artifact is about — decides which `<deviceId>/events/`
   * bucket the bytes land in. `null`/absent files under
   * {@link UNATTRIBUTED_DEVICE_BUCKET}.
   */
  readonly deviceId?: number | null
}

/** A stored artifact — what the URL builder and the route handler need. */
export interface NcArtifact {
  readonly id: string
  readonly mime: string
  readonly bytes: number
}

const DEFAULT_MAX_AGE_MS = 6 * 3600_000
const DEFAULT_MAX_ENTRIES = 500

/**
 * How long a browsable artifact stays fetchable. Fourteen days is the operator
 * answer to "how far back do I scroll" without turning a scratch into an
 * unbounded media library — the durable copy of an event's media still lives in
 * the media store, and a timelapse's own export retention is seven days.
 */
export const DEFAULT_KEPT_MAX_AGE_MS = 14 * 24 * 3600_000
/**
 * The retained shelf had two more bounds until 2026-09-13 — 2 000 rows and
 * 2 GiB, whichever bit first. They are REMOVED, not raised (D485).
 *
 * What that costs, stated rather than discovered later: `artifacts` is not a
 * class the storage evictor sweeps (it is absent from `STORAGE_CLASS_SUBTREES`),
 * so the age bound is now the only thing between this shelf and the disk.
 * Measured on the live hub the day this changed: 901 retained files, ~710 MB,
 * the busiest camera at 820 files / 580 MB — the age bound was what bit, and
 * the other two had never fired. At a 60-day window that one camera alone would
 * hold roughly 2.5 GB.
 */

/** The retained shelf's subdirectory name, inside each bucket's artifact dir. */
const KEPT_SUBDIR = 'kept'

/** `image/jpeg` → `jpg`, so a fetched link has a name a client will accept. */
function extensionFor(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'video/mp4') return 'mp4'
  if (mime === 'image/png') return 'png'
  return 'bin'
}

/** One file on a shelf, as the sweep and the reader see it. */
interface ShelfEntry {
  readonly id: string
  readonly file: string
  readonly mtimeMs: number
  readonly sizeBytes: number
}

export class NcArtifactStore {
  private readonly now: () => number
  private readonly logger: IScopedLogger
  private readonly maxAgeMs: number
  private readonly maxEntries: number
  private readonly keptMaxAgeMs: number | null
  /** The artifacts class root — the singleton location's basePath. */
  private readonly rootDir: string
  /** id → mime, so the route can answer with the right content-type without
   *  re-deriving it from the extension on every request. */
  private readonly mimeById = new Map<string, string>()

  constructor(options: NcArtifactStoreOptions) {
    this.now = options.now ?? ((): number => Date.now())
    this.logger = options.logger
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    // `??` would fold an explicit `null` into the default, which is the one
    // reading this option must never have: null is "forever", the default is
    // 14 days. Only ABSENCE means "use the default".
    this.keptMaxAgeMs =
      options.keptMaxAgeMs === undefined ? DEFAULT_KEPT_MAX_AGE_MS : options.keptMaxAgeMs
    this.rootDir = options.rootDir
  }

  /** How long a retained artifact stays fetchable — the index's `expiresAt`
   *  is derived from this, so the two can never disagree. */
  get retentionMs(): number | null {
    return this.keptMaxAgeMs
  }

  /** The scratch shelf of one camera bucket. */
  private scratchDirFor(bucket: number): string {
    return path.join(this.rootDir, String(bucket), NC_ARTIFACT_SUBTREE)
  }

  /** The retained shelf of one camera bucket. */
  private keptDirFor(bucket: number): string {
    return path.join(this.scratchDirFor(bucket), KEPT_SUBDIR)
  }

  /** Which bucket a put files under — a proven device id or the `0` bucket. */
  private bucketFor(deviceId: number | null | undefined): number {
    return typeof deviceId === 'number' && Number.isInteger(deviceId) && deviceId > 0
      ? deviceId
      : UNATTRIBUTED_DEVICE_BUCKET
  }

  /** Create the root and sweep whatever a previous run left behind. */
  async start(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true })
    await this.sweep()
  }

  /**
   * Persist bytes and return the artifact handle (never throws on sweep).
   *
   * Bucket directories are created LAZILY: a camera that never produces an
   * artifact never grows an `nc-artifacts` dir.
   */
  async put(
    bytes: Uint8Array,
    mime: string,
    options: NcArtifactPutOptions = {},
  ): Promise<NcArtifact> {
    const id = `${this.now()}-${randomUUID()}`
    const bucket = this.bucketFor(options.deviceId)
    const dir = options.retain === true ? this.keptDirFor(bucket) : this.scratchDirFor(bucket)
    const file = path.join(dir, `${id}.${extensionFor(mime)}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, bytes)
    this.mimeById.set(id, mime)
    await this.sweep()
    return { id, mime, bytes: bytes.byteLength }
  }

  /** Read an artifact's bytes + mime, or null when it is gone (expired/swept). */
  async read(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    // The id is attacker-supplied on a PUBLIC route: refuse anything that is
    // not the exact shape `put` mints, so no traversal can reach outside the
    // artifact subtrees even before the file lookup.
    if (!/^[0-9]+-[0-9a-f-]{36}$/i.test(id)) return null
    const entries = [...(await this.listScratch()), ...(await this.listKept())]
    const found = entries.find((e) => e.id === id)
    if (!found) return null
    try {
      const bytes = await fs.readFile(found.file)
      return {
        bytes,
        mime: this.mimeById.get(id) ?? mimeFromExtension(found.file),
      }
    } catch {
      return null
    }
  }

  /**
   * Unlink ONE artifact's file, from whichever shelf holds it.
   *
   * `false` when the file was not found or could not be removed — the caller
   * drops the index row either way, because the row is what LISTS the artefact
   * and a row kept for a failed unlink is a card that opens nothing. The file
   * then stays until the age sweep collects it, which is the backstop this
   * shelf already has and the index does not.
   *
   * The id is checked against the exact shape `put` mints, for the same reason
   * {@link read} checks it: it arrives from a caller.
   */
  async remove(id: string): Promise<boolean> {
    if (!/^[0-9]+-[0-9a-f-]{36}$/i.test(id)) return false
    const entries = [...(await this.listScratch()), ...(await this.listKept())]
    const found = entries.find((e) => e.id === id)
    if (!found) return false
    try {
      await fs.unlink(found.file)
    } catch (err) {
      this.logger.warn('artifact file could not be unlinked — the age sweep will collect it', {
        meta: { artifactId: id, error: String(err) },
      })
      return false
    }
    this.mimeById.delete(id)
    return true
  }

  /** The ids still on the retained shelf — what the index reconciles against. */
  async keptIds(): Promise<readonly string[]> {
    return (await this.listKept()).map((e) => e.id)
  }

  /**
   * Delete every artifact (operator cleanup / shutdown). Removes ONLY the
   * `nc-artifacts` subtrees — never the buckets or the root: an operator may
   * have pointed the location at a directory that carries other content, and
   * this store owns nothing outside its own subtrees.
   */
  async clear(): Promise<void> {
    for (const bucket of await this.listBuckets()) {
      await fs.rm(this.scratchDirFor(bucket), { recursive: true, force: true }).catch(() => {})
    }
    this.mimeById.clear()
  }

  /** Prune both shelves under their own bounds. Best-effort: a failed unlink is
   *  logged once and the rest of the sweep still runs. */
  async sweep(): Promise<void> {
    await this.sweepShelf(await this.listScratch(), {
      maxAgeMs: this.maxAgeMs,
      maxEntries: this.maxEntries,
    })
    // AGE ONLY, on the operator's instruction (D485). The count and byte
    // bounds are gone, not merely raised: a shelf that says "14 days" and then
    // cuts at 2 000 rows is a number that does not decide, and this repo has
    // shipped three of those already.
    const keptMaxAgeMs = this.keptMaxAgeMs
    if (keptMaxAgeMs !== null) {
      await this.sweepShelf(await this.listKept(), { maxAgeMs: keptMaxAgeMs })
    }
  }

  /**
   * Age first, then count, then total bytes — newest always survives.
   *
   * The newest entry is never swept by the byte bound even when it alone
   * exceeds it: a shelf that deletes what it has just written can serve
   * nothing, and the caller has already paid for the render.
   */
  private async sweepShelf(
    entries: readonly ShelfEntry[],
    bounds: { maxAgeMs: number; maxEntries?: number; maxBytes?: number },
  ): Promise<void> {
    const cutoff = this.now() - bounds.maxAgeMs
    const doomed = entries.filter((e) => e.mtimeMs < cutoff)
    const fresh = entries
      .filter((e) => e.mtimeMs >= cutoff)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    // `slice(undefined)` is a FULL COPY, not an empty one — reading an absent
    // count bound as "keep none" would condemn the entire shelf on the first
    // sweep, silently. An absent bound means there is no count bound.
    const maxEntries = bounds.maxEntries
    if (maxEntries !== undefined) {
      doomed.push(...fresh.slice(maxEntries))
    }
    const maxBytes = bounds.maxBytes
    if (maxBytes !== undefined) {
      let running = 0
      const underCount = maxEntries === undefined ? fresh : fresh.slice(0, maxEntries)
      for (const [i, e] of underCount.entries()) {
        running += e.sizeBytes
        if (running > maxBytes && i > 0) doomed.push(e)
      }
    }
    for (const e of doomed) {
      try {
        await fs.rm(e.file, { force: true })
        this.mimeById.delete(e.id)
      } catch (err) {
        this.logger.debug('artifact sweep failed to unlink', {
          meta: { file: e.file, error: String(err) },
        })
      }
    }
  }

  /**
   * The camera buckets that exist under the class root. Numeric directory
   * names only — the root is shared with `.camstack-location` markers and
   * whatever else a storage provider keeps there, and none of that is a
   * camera bucket.
   */
  private async listBuckets(): Promise<readonly number[]> {
    let dirents: readonly { name: string; isDirectory(): boolean }[]
    try {
      dirents = await fs.readdir(this.rootDir, { withFileTypes: true })
    } catch {
      return []
    }
    return dirents.filter((d) => d.isDirectory() && /^\d+$/.test(d.name)).map((d) => Number(d.name))
  }

  /** Every scratch entry across buckets. */
  private async listScratch(): Promise<readonly ShelfEntry[]> {
    const out: ShelfEntry[] = []
    for (const bucket of await this.listBuckets()) {
      out.push(...(await this.listDir(this.scratchDirFor(bucket))))
    }
    return out
  }

  /** Every retained entry across buckets. */
  private async listKept(): Promise<readonly ShelfEntry[]> {
    const out: ShelfEntry[] = []
    for (const bucket of await this.listBuckets()) {
      out.push(...(await this.listDir(this.keptDirFor(bucket))))
    }
    return out
  }

  private async listDir(dir: string): Promise<readonly ShelfEntry[]> {
    let names: readonly string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const out: ShelfEntry[] = []
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const st = await fs.stat(file)
        // Skips the retained shelf's own directory when listing the scratch.
        if (!st.isFile()) continue
        out.push({
          id: name.slice(0, name.lastIndexOf('.')),
          file,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        })
      } catch {
        /* vanished between readdir and stat — nothing to prune */
      }
    }
    return out
  }
}

function mimeFromExtension(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'jpg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'png') return 'image/png'
  return 'application/octet-stream'
}
