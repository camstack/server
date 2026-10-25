/**
 * Where tracking tapes live, and the one sweep that removes them (D681, D341).
 *
 *   <artifacts>/<deviceId>/tracking-tapes/segments/<originMs>.jsonl.gz
 *   <artifacts>/<deviceId>/tracking-tapes/promoted/<tapeId>.jsonl.gz
 *
 * Device-first like every tenant of the class. The sweep walks numeric camera
 * buckets and ONLY their `segments/` directory, and keys on the origin in the
 * FILE NAME (never mtime — a copied file keeps its age). `promoted/` has no
 * age: a promotion lives until the operator deletes it.
 *
 * `ENOENT` on a `readdir`/`stat` here means "nothing has been written yet" —
 * a real answer, not a failure. Every OTHER errno (EACCES, EIO, an unmounted
 * disk, …) is a failure and is reported, never folded into "empty" (D393): a
 * warn log with the reason, and — for `sweep()` — an outcome a caller can
 * tell apart from "nothing to delete". See `roots.ts`'s `hydrateDevice`/
 * `hydrateWindow` and `location-class-wipe.ts`'s `wipeClassSubtrees` for the
 * same distinction made elsewhere in this repo.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { errMsg, type IScopedLogger } from '@camstack/types'

const TRACKING_TAPES_SUBTREE = 'tracking-tapes'
const SEGMENTS_DIR = 'segments'
const PROMOTED_DIR = 'promoted'
/** Operator decision (D681): one day on disk. */
const SEGMENT_RETENTION_MS = 24 * 3_600_000

const SEGMENT_NAME = /^(\d{13})\.jsonl\.gz$/
const TAPE_ID = /^[a-z0-9][a-z0-9-]{7,63}$/

export interface TapeSegmentFile {
  readonly deviceId: number
  readonly originMs: number
  readonly file: string
  readonly bytes: number
}

export interface TapeSweepCount {
  readonly files: number
  readonly bytes: number
}

/** A camera bucket that was found, but whose `segments/` could not be read
 *  or swept — never silently folded into "0 deleted" (D393). */
export interface TapeSweepFailure {
  readonly failed: true
  readonly reason: string
}

export interface TapeSweepReport {
  /** One entry per camera bucket that was actually walked: a delete count,
   *  or why its `segments/` directory could not even be read. A bucket with
   *  nothing old enough to delete has NO entry — that is the true "nothing
   *  to do here" case, distinct from both of the above. */
  readonly perDevice: ReadonlyMap<number, TapeSweepCount | TapeSweepFailure>
  /** Set when the shelf root itself could not be enumerated: no camera
   *  bucket could even be discovered, so `perDevice` is necessarily empty
   *  and MUST NOT be read as "nothing to sweep". `null` when the root was
   *  read fine (including "the root does not exist yet"). */
  readonly rootUnreadable: string | null
}

export interface TapeShelfOptions {
  /** The resolved root of the `artifacts` location. */
  readonly rootDir: string
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly retentionMs?: number
}

/** A listing of one camera's segments, or why it could not be produced.
 *  `unstatted` holds the origins (from the file NAME) of files the listing
 *  SAW but could not size — a listing with any is short, and a reader that
 *  sums bytes must say so (D393); a promotion places them as unreadable
 *  segments (Task 12 fix round, L4). */
export type TapeSegmentListing =
  | {
      readonly ok: true
      readonly segments: readonly TapeSegmentFile[]
      readonly unstatted: readonly number[]
    }
  | { readonly ok: false; readonly reason: string }

/** The set of numeric camera buckets under the shelf root, or why they could
 *  not be enumerated. */
type BucketListing =
  | { readonly ok: true; readonly deviceIds: readonly number[] }
  | { readonly ok: false; readonly reason: string }

/** The one place this file steps onto Node's errno-carrying `Error` shape —
 *  a documented type boundary, not a blanket cast. */
function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined
}

export class TapeShelf {
  private readonly rootDir: string
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly retentionMs: number

  constructor(options: TapeShelfOptions) {
    this.rootDir = options.rootDir
    this.logger = options.logger
    this.now = options.now ?? ((): number => Date.now())
    this.retentionMs = options.retentionMs ?? SEGMENT_RETENTION_MS
  }

  private tapesDir(deviceId: number): string {
    return path.join(this.rootDir, String(deviceId), TRACKING_TAPES_SUBTREE)
  }

  segmentFile(deviceId: number, originMs: number): string {
    return path.join(this.tapesDir(deviceId), SEGMENTS_DIR, `${String(originMs)}.jsonl.gz`)
  }

  promotedFile(deviceId: number, tapeId: string): string {
    if (!TAPE_ID.test(tapeId)) throw new Error(`unsafe tape id: ${tapeId}`)
    return path.join(this.tapesDir(deviceId), PROMOTED_DIR, `${tapeId}.jsonl.gz`)
  }

  /** One camera's segments, oldest first — or the reason they could not be
   *  listed, so `sweep()`, `debug.tape.status` and a promotion report it
   *  instead of reading it as "empty". There is deliberately no variant that
   *  folds a failure into an empty list (D393). */
  async readSegments(deviceId: number): Promise<TapeSegmentListing> {
    const dir = path.join(this.tapesDir(deviceId), SEGMENTS_DIR)
    let names: readonly string[]
    try {
      names = await fs.readdir(dir)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { ok: true, segments: [], unstatted: [] }
      const reason = errMsg(err)
      this.logger.warn('tracking tape segments directory could not be read', {
        tags: { deviceId },
        meta: { dir, error: reason },
      })
      return { ok: false, reason }
    }
    const out: TapeSegmentFile[] = []
    const unstatted: number[] = []
    for (const name of names) {
      const m = SEGMENT_NAME.exec(name)
      if (m === null) continue
      const file = path.join(dir, name)
      try {
        const st = await fs.stat(file)
        out.push({ deviceId, originMs: Number(m[1]), file, bytes: st.size })
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue // vanished between readdir and stat — the expected race
        unstatted.push(Number(m[1]))
        this.logger.warn('tracking tape segment could not be stat-ed', {
          tags: { deviceId },
          meta: { file, error: errMsg(err) },
        })
      }
    }
    return {
      ok: true,
      segments: out.toSorted((a, b) => a.originMs - b.originMs),
      unstatted: unstatted.toSorted((a, b) => a - b),
    }
  }

  private async cameraBuckets(): Promise<BucketListing> {
    try {
      const dirents = await fs.readdir(this.rootDir, { withFileTypes: true })
      return {
        ok: true,
        deviceIds: dirents
          .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
          .map((d) => Number(d.name)),
      }
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { ok: true, deviceIds: [] }
      const reason = errMsg(err)
      // No deviceId is in scope yet — the root itself could not be walked.
      this.logger.warn('tracking tapes shelf root could not be read', {
        meta: { rootDir: this.rootDir, error: reason },
      })
      return { ok: false, reason }
    }
  }

  async sweep(): Promise<TapeSweepReport> {
    const cutoff = this.now() - this.retentionMs
    const perDevice = new Map<number, TapeSweepCount | TapeSweepFailure>()
    const buckets = await this.cameraBuckets()
    if (!buckets.ok) return { perDevice, rootUnreadable: buckets.reason }
    for (const deviceId of buckets.deviceIds) {
      const listing = await this.readSegments(deviceId)
      if (!listing.ok) {
        perDevice.set(deviceId, { failed: true, reason: listing.reason })
        continue
      }
      let files = 0
      let bytes = 0
      for (const segment of listing.segments) {
        if (segment.originMs >= cutoff) continue
        try {
          await fs.rm(segment.file, { force: true })
          files += 1
          bytes += segment.bytes
        } catch (err) {
          this.logger.warn('tracking tape segment could not be deleted', {
            tags: { deviceId },
            meta: { file: segment.file, error: errMsg(err) },
          })
        }
      }
      if (files === 0) continue
      perDevice.set(deviceId, { files, bytes })
      this.logger.info('tracking tape segments swept', {
        tags: { deviceId },
        meta: { files, bytes, retentionHours: this.retentionMs / 3_600_000 },
      })
    }
    return { perDevice, rootUnreadable: null }
  }
}

/**
 * Log every refusal the sweep already measured (D391 / D681 follow-up).
 * `sweep()` itself never throws for `rootUnreadable` / per-camera `failed`:
 * those land on the report, and a caller that only `.catch`es would drop them
 * silently even when the shelf already warned at the `readdir` site. One
 * tagged line per refusal at the sweep boundary closes that gap.
 */
export function logTapeSweepReport(report: TapeSweepReport, logger: IScopedLogger): void {
  if (report.rootUnreadable !== null) {
    logger.warn('tracking tape sweep refused', {
      meta: { reason: report.rootUnreadable, scope: 'root' },
    })
  }
  for (const [deviceId, outcome] of report.perDevice) {
    if (!('failed' in outcome) || outcome.failed !== true) continue
    logger.warn('tracking tape sweep refused', {
      tags: { deviceId },
      meta: { reason: outcome.reason, scope: 'camera' },
    })
  }
}
