import type { RecordingIndex } from './recording-index.js'
import { segmentRelPath } from './segment-path.js'
import type { SegmentRow } from './types.js'

/** Structured extras for `SegmentStoreDeps.logger.warn` — carries the
 *  device-scoped `deviceId` tag (so per-device log filtering picks these
 *  entries up) alongside the underlying error. */
export interface SegmentStoreLogExtras {
  readonly tags?: { readonly deviceId?: number }
  readonly error?: unknown
}

/** Structured extras for `SegmentStoreDeps.logger.info` — counts only, so the
 *  addon can forward it to `IScopedLogger.info` without inspecting it. */
export interface SegmentStoreLogMeta {
  readonly meta: Record<string, unknown>
}

/**
 * Every segment file the hour DIRECTORY `(deviceId, profile, locationId, hour)`
 * holds, or `null` when it could not be read. Never `[]` for "unknown" — an
 * empty array here means the hour is genuinely empty, and the one caller turns
 * this answer into a recursive delete.
 */
export type HourDirectoryPaths = (
  deviceId: number,
  profile: string,
  locationId: string,
  hourStartMs: number,
) => Promise<readonly string[] | null>

export interface SegmentStoreDeps {
  readonly index: RecordingIndex
  readonly list: (input: { location: string; prefix?: string }) => Promise<readonly string[]>
  readonly deletePath: (input: { location: string; relativePath: string }) => Promise<void>
  readonly statBytes: (absPath: string) => Promise<number>
  readonly moveFile: (fromAbs: string, toAbs: string) => Promise<void>
  /**
   * Remove one hour-bucket DIRECTORY (location-relative
   * `<dev>/<profile>/Y/M/D/H`) recursively — the addon resolves the location
   * root and issues a raw `fs.rm(abs, { recursive: true, force: true })`
   * (mirrors how moveFile/statBytes already do node-fs I/O on absolute paths).
   * One rm replaces hundreds of per-file `storage.delete` calls when an entire
   * bucket is evicted (R4).
   */
  readonly removeDir: (location: string, relDir: string) => Promise<void>
  /**
   * A listing of the hour BUCKET this round is about to delete.
   *
   * The ONLY admissible answer to "does this round cover every segment the
   * bucket holds?", because {@link SegmentStore.evict}'s answer to that becomes
   * an `rm -rf` of that same directory — so the question is asked of the
   * directory itself (D523).
   *
   * It has been answered wrongly twice. From `RecordingIndex.bucketCounts`:
   * that index holds the live tail plus whatever a reader hydrated, so for a
   * closed hour BOTH sides — the count and the victims — shrank together, read
   * EQUAL, and the directory went with every file the round never enumerated.
   * Then from the hour ledger's `paths` column, which a writer torn down
   * mid-hour leaves short in exactly the same shape.
   *
   * `null` = the listing could not be had. The fast path is then REFUSED and
   * the round falls back to per-file deletes, which are slower and always
   * correct — never back to the index, whose failure direction here is a delete
   * computed from a fraction of the truth (D295).
   */
  readonly hourDirectoryPaths?: HourDirectoryPaths
  /**
   * Remove a directory ONLY if it is empty, so pruning an ancestor can never
   * take footage with it. Absent → ancestors are left behind (the old
   * behaviour), which is what filled the archive with day-shaped shells.
   */
  readonly removeDirIfEmpty?: (location: string, relDir: string) => Promise<void>
  /** Told what eviction removed, so a calendar cache does not keep drawing a
   *  bar over footage that is gone. */
  readonly onEvicted?: (deviceId: number, atMs: number) => void
  /** Told when a finalized segment lands in the index, with its resting
   *  absolute path — the mfra capture reads the file while it is still in
   *  page cache. Must not throw; fire-and-forget work belongs inside it. */
  readonly onIndexed?: (row: SegmentRow, absPath: string) => void
  /**
   * Told the rows whose files actually left disk in this eviction round.
   * The hour ledger drops those paths; it must not hear about rows the
   * delete skipped. Fire-and-forget.
   */
  readonly onDeindexed?: (rows: readonly SegmentRow[]) => void
  /** Injectable clock (ms) for the current-hour guard — defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Buckets handled between yields in {@link SegmentStore.evict}. An eviction
   * round after a staging recovery spans thousands of them; a loop that never
   * hands control back starves the write path and the cap UDS channel.
   */
  readonly evictChunkSize?: number
  /** Called between eviction chunks — defaults to a macrotask hop. */
  readonly yieldBetween?: () => Promise<void>
  /**
   * Delete one STAGING file (absolute path). Used only for a stub too small to
   * be a media segment, once it has been counted. Staging (`.rec-tmp`) is
   * outside every storage class's occupancy and invisible to eviction (D327,
   * D385), so a delete there moves no accounting; a quarantine directory would
   * be a new tree nothing evicts or sizes. Absent ⇒ stubs are left in place.
   */
  readonly removeStaged?: (absPath: string) => Promise<void>
  readonly logger: {
    readonly warn: (message: string, extras?: unknown) => void
    /** Per-stub detail (one line per stub, per device) — off the default level. */
    readonly debug?: (message: string, extras: SegmentStoreLogMeta & SegmentStoreLogExtras) => void
    /** A round that can take minutes says so, with its counts. Silence reads as
     *  "never happened" — this round said nothing for tens of minutes once. */
    readonly info: (message: string, extras: SegmentStoreLogMeta) => void
  }
}

/** A flat segment that ffmpeg has just closed, awaiting stat + relocate + indexing. */
export interface FinalizedSegmentInput {
  readonly deviceId: number
  readonly profile: string
  /** Storage location the segment will live on (the `storage` cap location ref); stamped onto the row. */
  readonly locationId: string
  readonly locationRoot: string
  readonly flatAbsPath: string
  readonly startMs: number
  readonly durMs: number
}

/**
 * Below this a file cannot be a media segment: one fMP4 `moof` + `mdat`
 * carrying a single sample already exceeds this by an order of magnitude.
 * What it actually catches is the structural stub — ffmpeg opens the next
 * segment the instant it closes the previous one, so a killed writer always
 * leaves one just-opened file (observed: 28-byte bare `styp` boxes). The boot
 * recovery plans by NAME and would otherwise index it with a nominal duration,
 * painting the timeline over footage that decodes to nothing — the same
 * failure `MAX_GAP_FACTOR` in staging-reconcile exists to prevent via gaps.
 */
const MIN_INDEXABLE_SEGMENT_BYTES = 64

/** Stubs cleared since the last {@link SegmentStore.takeStubReport}. */
export interface StubReport {
  readonly count: number
  readonly bytes: number
}

export class SegmentStore {
  private stubCount = 0
  private stubBytes = 0

  constructor(private readonly deps: SegmentStoreDeps) {}

  /**
   * The stubs cleared since the last call, then reset. A recovery pass calls it
   * once and logs ONE line: ~530 stubs used to re-log at every boot because
   * each was warned about and left in staging forever.
   */
  takeStubReport(): StubReport {
    const report = { count: this.stubCount, bytes: this.stubBytes }
    this.stubCount = 0
    this.stubBytes = 0
    return report
  }

  async hydrate(deviceId: number, location: string): Promise<void> {
    const paths = await this.deps.list({ location, prefix: `${deviceId}/` })
    this.deps.index.hydrateDevice(deviceId, location, paths)
  }

  async onFinalized(input: FinalizedSegmentInput): Promise<SegmentRow | null> {
    let bytes: number
    try {
      bytes = await this.deps.statBytes(input.flatAbsPath)
    } catch (err: unknown) {
      this.deps.logger.warn('segment stat failed', {
        tags: { deviceId: input.deviceId },
        error: err,
      })
      return null
    }
    if (bytes < MIN_INDEXABLE_SEGMENT_BYTES) {
      // Not silent, and not forever: the stub is counted (the recovery pass
      // reports the total once), logged per device at debug, and removed — a
      // file left in staging was re-reported at every boot, indefinitely.
      this.deps.logger.debug?.('segment too small to index — clearing stub from staging', {
        tags: { deviceId: input.deviceId },
        meta: { bytes, path: input.flatAbsPath },
      })
      if (this.deps.removeStaged !== undefined) {
        try {
          await this.deps.removeStaged(input.flatAbsPath)
        } catch (err: unknown) {
          this.deps.logger.warn('segment stub could not be cleared from staging', {
            tags: { deviceId: input.deviceId },
            error: err,
            meta: { bytes, path: input.flatAbsPath },
          })
          return null
        }
        this.stubCount++
        this.stubBytes += bytes
      }
      return null
    }

    const relPath = segmentRelPath(input.deviceId, input.profile, input.startMs, input.durMs, bytes)
    const toAbs = `${input.locationRoot}/${relPath}`
    try {
      await this.deps.moveFile(input.flatAbsPath, toAbs)
    } catch (err: unknown) {
      this.deps.logger.warn('segment relocate failed', {
        tags: { deviceId: input.deviceId },
        error: err,
      })
      return null
    }

    const row: SegmentRow = {
      deviceId: input.deviceId,
      profile: input.profile,
      startMs: input.startMs,
      durMs: input.durMs,
      bytes,
      path: relPath,
      locationId: input.locationId,
    }
    this.deps.index.addSegment(row)
    this.deps.onIndexed?.(row, toAbs)
    return row
  }

  /**
   * Delete `rows` via the storage cap under `location` and de-index the ones that delete
   * successfully; returns the reclaimed byte total. Precondition: every row must belong to
   * `location` (`row.locationId === location`) — the caller guarantees this (e.g. the evictable
   * provider feeds rows from `segmentsOnLocation(location)`). Mixed-location rows would be deleted
   * against the wrong location.
   *
   * Bucket-granular fast path (R4): rows are grouped by their hour-bucket dir
   * (`<dev>/<profile>/Y/M/D/H`). When a group covers EVERY indexed segment of
   * its bucket — and the bucket's hour is fully in the past, so no relocate can
   * still land in it (in-flight staging lives in the separate `.rec-tmp`) — the
   * whole dir goes with ONE `removeDir` instead of hundreds of per-file
   * deletes. Partial buckets, current-hour buckets, and a failed removeDir fall
   * back to the per-file `storage.delete` loop.
   */
  async evict(location: string, rows: readonly SegmentRow[]): Promise<number> {
    let reclaimed = 0
    const removed: string[] = []
    const startedMs = this.deps.now?.() ?? Date.now()

    const byBucket = new Map<string, SegmentRow[]>()
    for (const r of rows) {
      const cut = r.path.lastIndexOf('/')
      const bucketDir = cut > 0 ? r.path.slice(0, cut) : ''
      const group = byBucket.get(bucketDir)
      if (group) group.push(r)
      else byBucket.set(bucketDir, [r])
    }

    const chunkSize = this.deps.evictChunkSize ?? SegmentStore.DEFAULT_EVICT_CHUNK
    const yieldBetween = this.deps.yieldBetween ?? macrotask
    let bucketsRemoved = 0
    let handled = 0

    for (const [bucketDir, bucketRows] of byBucket) {
      if (bucketDir !== '' && (await this.bucketFullyEvicted(bucketRows, location))) {
        try {
          await this.deps.removeDir(location, bucketDir)
          bucketsRemoved += 1
          for (const r of bucketRows) {
            removed.push(r.path)
            reclaimed += r.bytes
          }
          handled += 1
          if (handled % chunkSize === 0) await yieldBetween()
          continue
        } catch (err: unknown) {
          this.deps.logger.warn('bucket removeDir failed — falling back to per-file deletes', {
            tags: { deviceId: bucketRows[0]?.deviceId },
            error: err,
          })
        }
      }
      for (const r of bucketRows) {
        try {
          await this.deps.deletePath({ location, relativePath: r.path })
          removed.push(r.path)
          reclaimed += r.bytes
        } catch (err: unknown) {
          this.deps.logger.warn('segment delete failed', {
            tags: { deviceId: r.deviceId },
            error: err,
          })
        }
      }
      handled += 1
      if (handled % chunkSize === 0) await yieldBetween()
    }

    if (removed.length > 0) {
      this.deps.index.removeSegments(removed)
      this.notifyEvicted(rows)
      const gone = new Set(removed)
      this.deps.onDeindexed?.(rows.filter((r) => gone.has(r.path)))
    }
    await this.pruneEmptyAncestors(location, [...byBucket.keys()])
    this.deps.logger.info('recorder: eviction round complete', {
      meta: {
        location,
        rows: rows.length,
        buckets: byBucket.size,
        bucketsRemoved,
        removed: removed.length,
        reclaimed,
        ms: (this.deps.now?.() ?? Date.now()) - startedMs,
      },
    })
    return reclaimed
  }

  /**
   * Tell the calendar cache what went, ONCE PER (device, UTC day).
   *
   * `CalendarIndex.invalidate` drops a whole UTC day, so a per-ROW call repeats
   * the same work for every segment of that day — and its hour-list sweep is
   * O(cached hours), in one uninterrupted synchronous block with no await in
   * it. Measured over a 122 400-row round with 5 000 cached hours: 15 285 ms of
   * frozen event loop, scaling linearly with how long the session has been
   * scrubbing. Deduped it is ~190 calls and unmeasurable.
   */
  private notifyEvicted(rows: readonly SegmentRow[]): void {
    const notify = this.deps.onEvicted
    if (!notify) return
    const seen = new Set<string>()
    for (const r of rows) {
      const key = `${r.deviceId}:${Math.floor(r.startMs / SegmentStore.DAY_MS)}`
      if (seen.has(key)) continue
      seen.add(key)
      notify(r.deviceId, r.startMs)
    }
  }

  /**
   * Walk up from each emptied hour directory removing ancestors that are now
   * empty, so that **a directory's existence means footage**.
   *
   * Hours were already removed when fully evicted; days were not. Measured on
   * the live archive: 15 of 28 day directories held nothing at all, while only
   * 1 of 261 hour directories did. Those shells are why the date selector could
   * not simply read `.../YYYY/MM/` and answer — the cheapest possible question
   * needed a confirming read inside every day.
   *
   * Only ever `rmdir`, never a recursive delete: an ancestor that still holds
   * anything must survive, and the failure of a non-empty `rmdir` IS the guard.
   * Stops at the profile level — `<deviceId>/<profile>/` are structural.
   */
  private async pruneEmptyAncestors(
    location: string,
    bucketDirs: readonly string[],
  ): Promise<void> {
    const prune = this.deps.removeDirIfEmpty
    if (!prune) return
    const seen = new Set<string>()
    for (const bucket of bucketDirs) {
      if (bucket === '') continue
      // `<deviceId>/<profile>/YYYY/MM/DD/HH` → try DD, then MM, then YYYY.
      const parts = bucket.split('/')
      for (let depth = parts.length - 1; depth > 2; depth--) {
        const dir = parts.slice(0, depth).join('/')
        if (seen.has(dir)) break
        seen.add(dir)
        try {
          await prune(location, dir)
        } catch {
          // Not empty (the common case: a sibling day still has footage), or
          // raced with a writer. Either way the ancestors above it stay too.
          break
        }
      }
    }
  }

  /** Hour of one UTC hour-bucket in ms. */
  private static readonly HOUR_MS = 3_600_000
  private static readonly DAY_MS = 86_400_000
  /** Buckets between yields. Small enough that one chunk is milliseconds of
   *  work now the per-bucket archive scan is gone. */
  private static readonly DEFAULT_EVICT_CHUNK = 25

  /**
   * True when `victims` cover EVERY segment the bucket DIRECTORY holds, AND the
   * bucket's hour has fully elapsed.
   *
   * The current-hour guard matters because `onFinalized` relocates new segments
   * INTO the current bucket concurrently — an rm racing that rename would
   * orphan a just-indexed segment.
   *
   * The cover test is a listing of the directory the `rm -rf` is about to take,
   * never `RecordingIndex` and never a durable row (D523). A bucketDir is
   * `<dev>/<profile>/Y/M/D/H`, so one listing answers exactly the question the
   * delete asks. Asked of the resident index it read EQUAL whenever the hour was
   * partly resident — both sides short by the same rows — and the directory went
   * with every file the round never named.
   *
   * An unanswerable listing returns `false`: per-file deletes are slower and
   * always correct, and the alternative is a recursive delete computed from a
   * fraction of the truth.
   */
  private async bucketFullyEvicted(
    victims: readonly SegmentRow[],
    location: string,
  ): Promise<boolean> {
    const first = victims[0]
    if (!first) return false
    const bucketStartMs = Math.floor(first.startMs / SegmentStore.HOUR_MS) * SegmentStore.HOUR_MS
    const nowMs = this.deps.now?.() ?? Date.now()
    if (nowMs < bucketStartMs + SegmentStore.HOUR_MS) return false // bucket still live

    const ask = this.deps.hourDirectoryPaths
    if (ask === undefined) return false
    const held = await ask(first.deviceId, first.profile, location, bucketStartMs)
    // `null` = could not list. `[]` = the directory is empty, and an empty
    // cover would make `every` vacuously true on a directory this round may
    // never have enumerated.
    if (held === null || held.length === 0) return false
    const doomed = new Set(victims.map((v) => v.path))
    return held.every((p) => doomed.has(p))
  }
}

const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
