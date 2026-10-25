/**
 * Builds the `recording-archive` cap provider (`IRecordingArchiveProvider`) on
 * the recorder core — OUR storage, our intent and our byte plane.
 *
 * The five per-camera COVERAGE reads left this file on 2026-09-24 (D625): they
 * are the `recording` device COLLECTION now, and live in
 * `recording-source-provider.ts`, which reuses {@link readRecordingCoverage}
 * and {@link readRecordingDays} from here so the batch and the singular answer
 * are literally the same body rather than aspirationally the same. NO ffmpeg / segment writing here — that arrives in B2/B3. This shell
 * answers reads from the v2 `RecordingIndex` (hydrated from `storage.list`),
 * persists per-device config via durable-state, and prunes footage through
 * `selectEvictions` + `SegmentStore.evict`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ConfigUISchemaWithValues,
  IRecordingArchiveProvider,
  IScopedLogger,
  LedgerWalkReport,
  LocateSegmentResult,
  OpsLogEntry,
  OpsLogReason,
  ReadGopBytesResult,
  ReadSegmentBytesResult,
  ReadWindowBytesResult,
  RecordingAvailability,
  RecordingAvailabilityForDevice,
  RecordingConfig,
  RecordingDaysForDevice,
  RecordingLocationUsage,
  RecordingManifest,
  RecordingRebalanceInput,
  RecordingRebalancePlan,
  RecordingStatus,
  RecordingStorageUsage,
  MoverClearanceAnswer,
  RelocateFootageInput,
  RelocateJob,
  RelocateResidue,
} from '@camstack/types'
import {
  errMsg,
  hydrateSchema,
  RECORDING_TIMELINE_BATCH_MAX,
  startMoverUnderClearance,
} from '@camstack/types'
import {
  type GopRange,
  type RangeReadable,
  readGopRange,
  readGopWindowRange,
  SCRUB_GOP_BUDGET_MAX_BYTES,
} from '../gop-range-read.js'
import type { HydrationState, RecordingIndex } from '../recording-index.js'
import type { SeededMfraTable } from '../segment-directory.js'
import type { Accounting, Range } from '../types.js'
import type { LocationCapacity } from './location-capacity.js'
import type { RecordingOpsLogSink } from './ops-log-store.js'

/** A {@link RangeReadable} that must be closed once the GOP answer is built. */
export interface ClosableRangeReadable extends RangeReadable {
  close(): Promise<void>
}

/** The slice of `CalendarIndex` the provider needs — kept structural so the
 *  provider stays unit-testable without a filesystem. */
export interface CalendarIndexLike {
  localDays(
    deviceId: number,
    fromMs: number,
    toMs: number,
    tzOffsetMinutes: number,
  ): Promise<number[]>
  dayRanges(deviceId: number, profile: string, utcDayMs: number): Promise<Range[]>
  rangesIn(deviceId: number, profile: string, fromMs: number, toMs: number): Promise<Range[]>
  availabilityProfileFor(deviceId: number): Promise<string | null>
  /** The profile to DESCRIBE: the one asked for when this camera records it,
   *  else the availability pick. Owns the fallback so it is never silent. */
  servedProfileFor(deviceId: number, requested?: string): Promise<string | null>
  /** Every profile that holds footage, across every root (D433). */
  profilesWithFootageFor(deviceId: number): Promise<readonly string[]>
}

import { codecStringFromFragment } from '../codec-probe.js'
import { distinctRecordingDays } from '../day-bucket.js'
import { selectEvictionsFromArchive } from '../evict-select.js'
import {
  buildMasterPlaylist,
  buildVariantPlaylist,
  type MasterVariant,
  type VariantSegment,
} from '../playlist.js'
import { buildRecordingDeviceSchema } from '../recording-device-settings.js'
import { type RelocateEngine, relocateScope } from '../relocate-engine.js'
import { segmentRelPath } from '../segment-path.js'
import type { SegmentStore } from '../segment-store.js'
import type { ArchiveDeviceUsage, FootageArchive, SegmentRow } from '../types.js'
import {
  activeModeForConfig,
  loadDeviceConfig,
  type RecordingConfigsState,
  saveDeviceConfig,
} from './config-store.js'
import { buildDeviceUsage, warnOnUsageMismatch } from './device-storage-usage.js'
import { physicalRootKey } from './eviction-domain.js'
import type { LedgerWalkReconciler } from './ledger-walk-reconcile.js'
import { locationMayBeWritten, requireReadableLocation } from './location-resolve.js'
import { planRebalance, type RebalanceHeadroom } from './rebalance-plan.js'
import type { RecordingsLocation } from './roots.js'
import { userError } from '@camstack/types'

/**
 * What the operator-armed rebalance weighs footage against: the placement plan
 * in force, and what each WRITE TARGET can still absorb. Both come from
 * `PlacementService` — deriving either one independently here is how the two
 * halves end up disagreeing.
 */
export interface PlacementSnapshot {
  /** `<deviceId>:<profile>` -> locationId. */
  readonly assignments: ReadonlyMap<string, string>
  readonly headroom: readonly RebalanceHeadroom[]
}

/** Bandwidth hint per profile for the master playlist (real bitrate is a later refinement). */
const PROFILE_BANDWIDTH: Record<string, number> = { high: 4_000_000, mid: 1_500_000, low: 500_000 }
const DEFAULT_BANDWIDTH = 1_000_000

/**
 * Max gap (ms) between consecutive segments still treated as ONE continuous
 * availability range. Absorbs the few-ms EXTINF-rounding jitter at every segment
 * boundary and a single dropped/late ~4s segment; a larger gap (recorder off,
 * multiple missing segments) splits the ranges so real discontinuities show.
 */
const RANGE_MERGE_GAP_MS = 5_000
/** Include the neighboring minute so a segment that starts in the previous
 * hour but covers the requested epoch is hydrated too. Recorder segments are
 * currently much shorter; the margin keeps this boundary future-safe. */
const LOCATE_HYDRATE_MARGIN_MS = 60_000

/**
 * Safety ceiling for one `readWindowBytes` answer — NOT the primary stop
 * condition (the requested `toMs` is; see `fragmentsInWindow` in
 * `mfra-index.ts`). Sized off `high`'s own bandwidth hint above
 * (`PROFILE_BANDWIDTH.high` = 4 Mbps = 500 000 B/s): a 30 s replay window at
 * that rate is ~15 MB, so 20 MB covers it with headroom while still bounding
 * a pathological request. A window this call actually truncates is reported
 * (`reachesRequestedEnd: false`) rather than silently shortened.
 */
const WINDOW_READ_MAX_BYTES = 20_000_000

/** Empty "no playback" manifest. */
/**
 * Start a footage move only while no single-location repoint holds an
 * overlapping physical root (the storage orchestrator owns that claim).
 */
function startFootageMover(
  deps: RecordingProviderDeps,
  engine: RelocateEngine,
  input: RelocateFootageInput,
): Promise<string> {
  const ask = deps.moverClearance
  if (ask === undefined) return Promise.resolve(engine.start(input))
  return startMoverUnderClearance({
    clearance: ask,
    start: () => engine.start(input),
    cancel: (jobId) => {
      engine.cancel(jobId)
    },
    locationIds: [input.fromLocationId, input.toLocationId],
  })
}

function noPlayback(deviceId: number): RecordingManifest {
  return { deviceId, localMasterPath: null, playbackUrl: null, playbackEndpoints: [] }
}

export type { LocationCapacity } from './location-capacity.js'

/** Dependencies the recorder recording provider composes over the v2 core. */
export interface RecordingProviderDeps {
  readonly index: RecordingIndex
  readonly segmentStore: SegmentStore
  readonly nodeId: string
  readonly logger: IScopedLogger
  /** Durable handle over the deviceId → RecordingConfig blob (one store key). */
  readonly configStore: RecordingConfigsState
  /** Snapshot of every resolved recordings location (id + root). */
  readonly locations: () => readonly RecordingsLocation[]
  /** Re-resolve + return locations (used by rescanStorage to pick up new disks). */
  readonly refreshLocations: () => Promise<readonly RecordingsLocation[]>
  /** Volume capacity for a location root, or null when unstattable. */
  readonly capacity: (root: string) => Promise<LocationCapacity>
  /**
   * Bytes / count / oldest / newest across a SET of location ids, as ONE
   * aggregation over the durable hour ledger. Absent (ledger unavailable) ⇒ the
   * per-volume row reports 0 used rather than a number counted from whichever
   * rows the in-RAM index happens to hold.
   */
  readonly archiveAccounting?: (locationIds: ReadonlySet<string>) => Promise<Accounting>
  /**
   * The ARCHIVE's per-CAMERA usage on a set of locations — bytes, segments and
   * the oldest archived start, folded from the ledger's always-resident hour
   * summary in ONE pass and no I/O (D418).
   *
   * `null` (or absent) means this node declared no hour ledger, and
   * `getStorageUsage` then REFUSES the per-camera table rather than answering
   * it from `deps.index`. That fallback is the defect: the index holds the
   * live tail plus whatever somebody hydrated, so it reported 60.5 GB and
   * "oldest: three hours ago" for an archive holding 1.9 TB and 3.3 days —
   * and a partial answer looks exactly like a complete one.
   */
  readonly archiveDeviceUsage?: (
    locationIds: ReadonlySet<string>,
  ) => ReadonlyMap<number, ArchiveDeviceUsage> | null
  /**
   * Whether an `archive` answer over these locations is WHOLE — see
   * `archiveUsageComplete`. Absent ⇒ never complete: a consumer must then
   * not read a camera's absence as "no footage" (D674).
   */
  readonly archiveUsageComplete?: (locationIds: ReadonlySet<string>) => boolean
  /**
   * The ARCHIVE — what the durable hour ledger says EXISTS, as opposed to what
   * `deps.index` happens to hold (D295).
   *
   * Absent means this node has no ledger. Every consumer here then REFUSES the
   * archive-wide operation rather than falling back to the resident index: a
   * retention prune that silently selects from a fraction of the archive is
   * exactly the defect this dependency exists to close, and the failure it
   * would cause is a delete.
   */
  readonly archive?: () => FootageArchive | null
  /** Storage cap surface for re-hydrating the index. */
  readonly hydrateDevice: (
    deviceId: number,
    locations: readonly RecordingsLocation[],
  ) => Promise<void>
  /**
   * After a disk walk, make the durable hour ledger match the index so a
   * restart cannot rehydrate ghost segments the walk just cleared.
   */
  readonly reconcileHourLedger?: (deviceId: number) => Promise<void>
  /**
   * Re-evaluate a device's recording attach/detach after its config changed.
   * Wired to the B2 `RecordingController`; optional so the B1 read-only shell
   * (and tests) can omit it. Failures here must not fail the config save (the
   * config is already persisted), so the caller swallows + logs them.
   */
  readonly onConfigChanged?: (deviceId: number) => Promise<void>
  /**
   * The value that was just PERSISTED for `deviceId` — handed to this addon's
   * own mirror of `recorder:recording-configs` (`config-mirror.ts`, D466).
   *
   * Separate from {@link onConfigChanged}, which re-evaluates the controller
   * and may fail: the mirror must be updated whether or not the re-evaluate
   * succeeds, and it must be updated BEFORE it, because `onConfigChanged`
   * reaches `evaluateDevice`, which reads the config back. Synchronous and
   * infallible by contract — it is a `Map.set`, and a write-through that could
   * throw would turn a successful save into a failed cap call.
   */
  readonly onConfigSaved?: (deviceId: number, config: RecordingConfig) => void
  /** Absolute addon data dir — playback playlists are written under `<dataDir>/playback`. */
  readonly dataDir: string
  /**
   * Base URL of the playback HTTP data-plane (`/addon/recorder/playback`), or
   * null until the addon has served it. `getPlaybackManifest` returns "no
   * playback" while null. Read lazily so the addon can serve the data-plane
   * AFTER the provider is built.
   */
  readonly playbackBaseUrl: () => string | null
  /**
   * Reads a segment file's raw bytes by absolute path. Injectable so the
   * provider is unit-testable without touching disk; defaults to
   * `fs.promises.readFile` in the real wiring.
   */
  readonly readFile?: (absPath: string) => Promise<Uint8Array | Buffer>
  /**
   * Reads at most `maxBytes` from the START of a file (the CODECS probe only
   * needs the fragment's leading moov, never the mdat). Injectable for tests;
   * defaults to a bounded `fs.open`/`read` so a probe never loads a whole
   * multi-MB segment into memory.
   */
  readonly readFilePrefix?: (absPath: string, maxBytes: number) => Promise<Uint8Array | Buffer>
  /**
   * Open a segment file for RANGED reads (the `readGopBytes` mfra path: tail +
   * head + one fragment, never the whole file). Injectable for tests; defaults
   * to one `fs.open` per call serving all three ranges. `size` comes from the
   * index row (`seg.bytes`), so no stat is needed on the read path.
   */
  readonly openRangeReadable?: (absPath: string, size: number) => Promise<ClosableRangeReadable>
  /** Finalize-time sync table for recent segments; avoids one random tail read
   *  on every playback/scrub GOP request. */
  readonly mfraFor?: (
    deviceId: number,
    profile: string,
    startMs: number,
  ) => SeededMfraTable | undefined
  /**
   * Existence check for ONE file. Injectable so a test can count the calls —
   * the count is the point: this used to run once per segment.
   */
  readonly statFile?: (absPath: string) => Promise<unknown>
  /**
   * Walk ONLY the hours a window spans, so a read of past footage does not have
   * to wait for the archive-wide hydrate (minutes). Optional: a caller that has
   * not wired it simply gets whatever the index already holds.
   */
  readonly hydrateWindow?: (
    deviceId: number,
    fromMs: number,
    toMs: number,
    /**
     * Consult the ARRAY for closed hours the ledger already answered for
     * (D445). The EXPORT path passes this; playback and scrub never do.
     *
     * The ledger row is written write-behind on finalized segments, so a
     * writer torn down mid-hour leaves segments no row mentions — and once the
     * hour closes nothing re-reads it. An export walks its window ONCE and is
     * the one read that can afford a `readdir` per hour to find out.
     */
    verifyClosedHours?: boolean,
  ) => Promise<void>
  /**
   * The calendar rungs. Absent → the old whole-index answers, which need the
   * archive-wide walk to have finished.
   */
  readonly calendar?: CalendarIndexLike
  /**
   * True when the device is a camera. Recording is a camera-only concern, so the
   * device-settings contribution returns null for non-cameras (no ghost
   * "Recording" tab on lights/switches/sensors). Optional — when omitted the
   * contribution is shown for every device (tests / legacy wiring).
   */
  readonly isCameraDevice?: (deviceId: number) => Promise<boolean>
  /**
   * Recordings ops-log sink — appended (best-effort) on every prune / rescan /
   * manual footprint delete, and read back by `listOpsLog`. Optional so the B1
   * read-only shell and unit tests can omit auditing entirely (then `listOpsLog`
   * returns []).
   */
  readonly opsLog?: RecordingOpsLogSink
  /** Footage relocation engine (Phase 4) — optional so the read-only shell
   *  and tests can omit it (methods then throw a clear 'unavailable'). */
  readonly relocate?: RelocateEngine
  /**
   * The ledger↔disk reconcile (D319). Absent means this node has no durable
   * hour ledger to reconcile, and the method answers `refused: 'no-ledger'`
   * rather than a report full of zeros that reads like a clean location.
   */
  readonly ledgerWalk?: LedgerWalkReconciler
  /**
   * The placement plan in force plus each write target's headroom — the two
   * halves of the operator-armed rebalance's arithmetic (D116). Supplied by the
   * addon from `PlacementService` so the rebalance weighs footage against
   * EXACTLY the pool and headroom the planner writes to. Absent → the rebalance
   * methods refuse loudly rather than planning against a guess.
   */
  readonly placementSnapshot?: () => Promise<PlacementSnapshot>
  readonly placementView?: () => Promise<{
    readonly assignments: ReadonlyArray<{ deviceId: number; profile: string; locationId: string }>
    readonly pins: ReadonlyArray<{ deviceId: number; locationId: string }>
    readonly defaultLocations: Readonly<Record<string, string>>
  }>
  readonly setDevicePlacement?: (deviceId: number, locationId: string | null) => Promise<void>
  /** Reversible storage-migration participant hooks. They deliberately do not
   * touch per-camera RecordingConfig state. */
  readonly pauseForStorageMigration?: (leaseId: string) => Promise<void>
  readonly resumeForStorageMigration?: (leaseId: string) => Promise<void>
  readonly refreshStorageLocationsForMigration?: (leaseId: string) => Promise<void>
  readonly assertStorageMigrationLease?: (leaseId: string) => void
  /** `storageMigration.moverClearance` — a footage move refuses while a
   *  single-location repoint holds an overlapping physical root. */
  readonly moverClearance?: (locationIds: readonly string[]) => Promise<MoverClearanceAnswer>
  /** One-shot GIF render around an instant (notification attachments). */
  readonly gifRender?: (input: {
    deviceId: number
    aroundMs: number
    preRollSec: number
    postRollSec: number
    maxWidth: number
    fps: number
  }) => Promise<{ gifBase64: string; fromMs: number; toMs: number }>
  /** One-shot MP4 clip render around an instant (notification attachments). */
  readonly clipRender?: (input: {
    deviceId: number
    aroundMs: number
    preRollSec: number
    postRollSec: number
    maxWidth: number
  }) => Promise<{
    clipBase64: string
    mime: string
    fromMs: number
    toMs: number
    bytes: number
  }>
}

/** Absolute dir the playback playlists for a device are written to (served root = `<dataDir>/playback`). */
function playbackDirFor(dataDir: string, deviceId: number): string {
  return path.join(dataDir, 'playback', String(deviceId))
}

/** Prefix window the CODECS probe reads — the fragment's moov (with its
 *  avcC/hvcC) leads the file and is ~1-2KB, so 64KB is a generous bound. */
const PROBE_PREFIX_BYTES = 65_536

/** Default bounded prefix reader: `fs.open` + one positioned `read`, never the
 *  whole file. */
async function readPrefixFromDisk(absPath: string, maxBytes: number): Promise<Uint8Array> {
  const fh = await fs.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Codec strings already probed, keyed `<deviceId>/<profile>`. Recording is
 *  passthrough (`-c:v copy`), so a profile's codec never changes while its
 *  camera config is stable — one probe per (device, profile) per addon life. */
type CodecCache = Map<string, string>

/**
 * RFC 6381 codec string for one variant: probe the first PRESENT fragment's
 * moov once and cache the result. Failures (unreadable file / unrecognized
 * bytes) return `undefined` — the playlist then omits `CODECS` for that
 * variant, exactly today's behaviour — and are NOT cached, so a later healthy
 * fragment can still populate it.
 */
async function probeVariantCodec(
  readPrefix: (absPath: string, maxBytes: number) => Promise<Uint8Array | Buffer>,
  cache: CodecCache,
  deviceId: number,
  profile: string,
  firstPresentAbs: string | null,
): Promise<string | undefined> {
  const key = `${deviceId}/${profile}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  if (firstPresentAbs === null) return undefined
  try {
    const prefix = await readPrefix(firstPresentAbs, PROBE_PREFIX_BYTES)
    const codec = codecStringFromFragment(
      prefix instanceof Uint8Array ? prefix : new Uint8Array(prefix),
    )
    if (codec !== undefined) cache.set(key, codec)
    return codec
  } catch {
    return undefined
  }
}

/**
 * How a collected segment's playlist URI is rendered.
 *
 * - `playback-relative` — relative to the device dir, resolved by the HTTP
 *   data-plane's ordered multi-root search (playlists live under
 *   `<dataDir>/playback`, segments under a location root: two different trees).
 * - `absolute` — the on-disk path, for consumers with NO multi-root search.
 *   ffmpeg resolves a playlist URI against the playlist's own directory, so an
 *   export fed a `playback-relative` playlist opens every segment under
 *   `<dataDir>/playback/...` and fails with ENOENT on all of them.
 */
export type SegmentUriMode = 'playback-relative' | 'absolute'

/** Segments of one (device, profile) range that are PRESENT on disk. */
export interface RangeSegments {
  readonly segments: readonly VariantSegment[]
  /** First fragment that passed the stat check — the CODECS probe target. */
  readonly firstPresentAbs: string | null
  /**
   * Whether the index had actually WALKED this window, independent of what it
   * found. An empty `segments` under `'unknown'` means "not looked at yet" and
   * must never be presented to an operator as "no footage".
   */
  readonly hydration: HydrationState
}

/**
 * Collect the segments of one (device, profile) overlapping `[fromMs, toMs)`
 * that are actually present on disk, as playlist entries in `uriMode`'s shape.
 *
 * Absolute resolution is the SAME idiom as the scrub path's
 * `resolveSegmentAbsPath`: `<root for the row's locationId>/<relative path>`.
 * A row whose location is unknown is skipped — it cannot be addressed at all.
 * Whether the FILES are verified depends on the caller: export ('absolute')
 * checks every one, playback does not. See the comment at the branch.
 */
export async function collectRangeSegments(
  deps: RecordingProviderDeps,
  deviceId: number,
  profile: string,
  fromMs: number,
  toMs: number,
  uriMode: SegmentUriMode,
): Promise<RangeSegments> {
  // Walk the hours this window needs before reading the index. The
  // archive-wide hydrate takes minutes; without this, every read during that
  // time answers from an empty index and the server reports "no footage" over
  // recordings that exist. Already-walked hours cost nothing, so a drag
  // crossing the same hour repeatedly pays once.
  // The skip lives HERE, at the read site, not only inside the walker: a drag
  // crosses the same hour many times and the contract must not depend on every
  // implementation of `hydrateWindow` remembering to check.
  //
  // EXPORT verifies the ledger against the array; PLAYBACK does not (D445).
  // The same asymmetry as the per-file `stat` below, and for the same reason:
  // an export walks its window ONCE and a wrong answer is a whole night
  // missing from a file, while the scrub re-walks per cursor position and a
  // `readdir` storm there is the stall the ledger exists to remove. `hydrated`
  // cannot short-circuit the verified read — a hydrated hour built from a
  // short ledger row is exactly the case it exists to catch.
  const verifyClosedHours = uriMode === 'absolute'
  if (verifyClosedHours || deps.index.hydrationOf(deviceId, fromMs, toMs) !== 'hydrated') {
    await deps.hydrateWindow?.(deviceId, fromMs, toMs, verifyClosedHours)
  }
  const hydration = deps.index.hydrationOf(deviceId, fromMs, toMs)

  const rootById = new Map(deps.locations().map((l) => [l.id, l.root]))
  // The window, sliced out of the live start-sorted view — not the archive
  // copied, filtered and re-sorted (it was already sorted) on every playback
  // and export call. `segmentsOverlapping` carries the same boundary rule the
  // filter had: straddling `fromMs` is IN, ending exactly at `fromMs` is OUT.
  const rows = deps.index.segmentsOverlapping(deviceId, profile, fromMs, toMs)

  // A row whose location is unknown cannot be addressed at all — drop it here
  // rather than emit a URI nothing can resolve.
  const candidates = rows.flatMap((s) => {
    const root = rootById.get(s.locationId)
    if (root === undefined) return []
    const rel = segmentRelPath(deviceId, profile, s.startMs, s.durMs, s.bytes)
    return [{ row: s, rel, abs: path.join(root, rel) }]
  })

  const statFile = deps.statFile ?? ((abs: string): Promise<unknown> => fs.stat(abs))
  const toSegment = (c: (typeof candidates)[number]): VariantSegment => ({
    // playback-relative drops the leading `<deviceId>/` so the URI is
    // relative to the device dir the master playlist is served from.
    uri: uriMode === 'absolute' ? c.abs : c.rel.split('/').slice(1).join('/'),
    startMs: c.row.startMs,
    durMs: c.row.durMs,
  })

  // EXPORT verifies every file; PLAYBACK does not.
  //
  // `RecordingIndex` already holds every row a device has — start, duration,
  // bytes, path — kept write-through on finalize AND on evict (SegmentStore
  // deletes the file, then calls `index.removeSegments`). For PLAYBACK the rows
  // are therefore authoritative enough: the existence check on top of them was
  // guarding a window at most one eviction pass wide, and it cost ONE SYSCALL
  // PER SEGMENT. A camera-day is ~2,700 of them; on a contended array that
  // measured ~4 SECONDS, sitting on the critical path of the first scrub. While
  // it ran, every cursor position of a drag waited on it and was superseded
  // before it could paint, so the drag painted nothing at all. Batching them
  // (the previous attempt) made them concurrent, not fewer.
  //
  // The trade was the wrong way round for playback: a segment deleted between
  // the index and the read yields a 404 on that ONE segment, which the
  // byte-range reader surfaces and can move past, while the storm was a
  // guaranteed multi-second stall on EVERY request.
  //
  // EXPORT is the opposite case and keeps the checks: ffmpeg is handed a
  // concat playlist and dies on the first missing file, so a skipped row there
  // is a failed render rather than one dropped frame.
  if (uriMode === 'absolute') {
    const present: boolean[] = Array.from({ length: candidates.length }, () => false)
    for (let i = 0; i < candidates.length; i += STAT_BATCH) {
      const batch = candidates.slice(i, i + STAT_BATCH)
      const results = await Promise.all(
        batch.map(async (c) => {
          try {
            await statFile(c.abs)
            return true
          } catch {
            return false
          }
        }),
      )
      for (let j = 0; j < results.length; j++) present[i + j] = results[j] ?? false
    }
    const segments: VariantSegment[] = []
    let firstPresentAbs: string | null = null
    for (let i = 0; i < candidates.length; i++) {
      if (!present[i]) continue
      const c = candidates[i]
      if (c === undefined) continue
      if (firstPresentAbs === null) firstPresentAbs = c.abs
      segments.push(toSegment(c))
    }
    return { segments, firstPresentAbs, hydration }
  }

  // Playback: one present file is still needed — the CODECS probe reads a
  // prefix of it — so the scan stops at the first hit, and gives up after a
  // bounded number of misses rather than becoming a storm of its own on a
  // device whose index rows outlive its files.
  let firstPresentAbs: string | null = null
  for (let i = 0; i < candidates.length && i < CODEC_PROBE_SCAN_LIMIT; i++) {
    const c = candidates[i]
    if (c === undefined) continue
    try {
      await statFile(c.abs)
      firstPresentAbs = c.abs
      break
    } catch {
      // keep looking, up to the bound
    }
  }
  return { segments: candidates.map(toSegment), firstPresentAbs, hydration }
}

/**
 * Build a master + per-profile variant HLS playlist on disk for the requested
 * window and return a RELATIVE playback URL through the hub's data-plane
 * reverse-proxy. Only segments actually present on disk are referenced (a
 * missing file would 404 mid-playlist). Returns "no playback" when the device
 * has no footage in range or the data-plane isn't served yet. Variant/segment
 * URIs are relative so the master + variants + segments form a self-contained
 * tree the player resolves against the master URL.
 */
/** How many segments to try before giving up on finding one present file for
 *  the CODECS probe. Bounded so a device whose index rows outlive its files
 *  cannot turn this back into a per-segment scan. */
const CODEC_PROBE_SCAN_LIMIT = 8

/** Concurrent `stat` fan-out width for the EXPORT path, which must verify every
 *  file. High enough to hide per-call latency on a contended array, low enough
 *  not to starve the recorder's own writes. */
const STAT_BATCH = 64

export async function buildPlaybackManifest(
  deps: RecordingProviderDeps,
  codecCache: CodecCache,
  deviceId: number,
  fromMs: number,
  toMs: number,
): Promise<RecordingManifest> {
  const base = deps.playbackBaseUrl()
  if (base === null) return noPlayback(deviceId)

  const readPrefix = deps.readFilePrefix ?? readPrefixFromDisk
  const playbackDir = playbackDirFor(deps.dataDir, deviceId)
  // Deriving the profile set is a READ, and it comes FIRST — so it walks the
  // window like every other read on this path. Reading the index bare here made
  // a cold index yield zero profiles, the loop below never run, and the manifest
  // come back empty over footage that exists: "no footage", one level above the
  // tri-state that exists to prevent exactly that (D167).
  if (deps.index.hydrationOf(deviceId, fromMs, toMs) !== 'hydrated') {
    await deps.hydrateWindow?.(deviceId, fromMs, toMs)
  }
  const profiles = [...new Set(deps.index.segments(deviceId).map((s) => s.profile))]
  const variants: MasterVariant[] = []

  for (const profile of profiles) {
    const { segments: variantSegments, firstPresentAbs } = await collectRangeSegments(
      deps,
      deviceId,
      profile,
      fromMs,
      toMs,
      'playback-relative',
    )
    if (variantSegments.length === 0) continue

    // One-time (cached) probe of the fragment's avcC/hvcC so the master
    // playlist advertises CODECS and hls.js can pre-drop variants the browser
    // can't decode (HEVC on Chrome/Android without hw support — F4).
    const codecs = await probeVariantCodec(
      readPrefix,
      codecCache,
      deviceId,
      profile,
      firstPresentAbs,
    )

    await fs.mkdir(playbackDir, { recursive: true })
    await fs.writeFile(
      path.join(playbackDir, `${profile}.m3u8`),
      buildVariantPlaylist(variantSegments),
      'utf8',
    )
    variants.push({
      profile,
      bandwidth: PROFILE_BANDWIDTH[profile] ?? DEFAULT_BANDWIDTH,
      uri: `${profile}.m3u8`,
      ...(codecs !== undefined ? { codecs } : {}),
    })
  }

  if (variants.length === 0) return noPlayback(deviceId)

  await fs.mkdir(playbackDir, { recursive: true })
  const masterPath = path.join(playbackDir, 'master.m3u8')
  await fs.writeFile(masterPath, buildMasterPlaylist(variants), 'utf8')
  // `?from=&to=` makes the URL distinct per window (the master file is rewritten
  // at a fixed path each request); the handler strips the query when serving.
  const playbackUrl = `${base}/${deviceId}/master.m3u8?from=${fromMs}&to=${toMs}`
  return { deviceId, localMasterPath: masterPath, playbackUrl, playbackEndpoints: [playbackUrl] }
}

/** Number of days in ms — for the retention floor returned by `pruneFootage`. */
const DAY_MS = 24 * 60 * 60 * 1000

function statusFor(
  deps: RecordingProviderDeps,
  deviceId: number,
  config: RecordingConfig,
): RecordingStatus {
  return {
    deviceId,
    enabled: config.enabled,
    activeMode: activeModeForConfig(config),
    nodeId: deps.nodeId,
    storageBytes: deps.index.accounting(deviceId).bytes,
  }
}

/** Group a device's segments by their storage location id. */
function segmentsByLocation(rows: readonly SegmentRow[]): Map<string, SegmentRow[]> {
  const out = new Map<string, SegmentRow[]>()
  for (const r of rows) {
    const list = out.get(r.locationId)
    if (list) list.push(r)
    else out.set(r.locationId, [r])
  }
  return out
}

/**
 * Evict a set of victim segments through the SegmentStore, grouped by their
 * storage location, and return the reclaimed bytes + deleted-bucket count.
 * Per-location isolated: one location's evict failure is logged and never aborts
 * the others. Shared by `pruneFootage` (retention) and `deleteFootprint`
 * (manual).
 */
export async function evictVictims(
  deps: RecordingProviderDeps,
  deviceId: number,
  victims: readonly SegmentRow[],
): Promise<{ reclaimedBytes: number; deletedBuckets: number }> {
  let reclaimedBytes = 0
  let deletedBuckets = 0
  for (const [locationId, locVictims] of segmentsByLocation(victims)) {
    try {
      const freed = await deps.segmentStore.evict(locationId, locVictims)
      reclaimedBytes += freed
      if (freed > 0) deletedBuckets += locVictims.length
    } catch (err: unknown) {
      deps.logger.warn('recorder evict failed for location', {
        tags: { deviceId },
        meta: { locationId, error: errMsg(err) },
      })
    }
  }
  return { reclaimedBytes, deletedBuckets }
}

/**
 * Resolve one indexed segment to its row + absolute path. Throws a clear error
 * when the segment or its location is unknown — shared by the whole-segment
 * and GOP byte-range reads so the two paths cannot drift on resolution.
 */
function resolveSegmentFile(
  deps: RecordingProviderDeps,
  deviceId: number,
  profile: string,
  startMs: number,
): { seg: SegmentRow; abs: string } {
  const seg = deps.index.segmentStartingAt(deviceId, profile, startMs)
  if (!seg) throw new Error(`recording: no segment at start ${startMs} for ${deviceId}/${profile}`)
  const loc = requireReadableLocation(deps.locations(), seg.locationId, 'recording')
  return { seg, abs: path.join(loc.root, seg.path) }
}

/**
 * The log line's `meta`, or null when `readGopBytes` served nothing worth a
 * line. Split out from the handler so the decision is testable against a
 * plain object — no real fMP4 bytes needed to prove a >1.5 MB fragment
 * triggers it.
 *
 * The single-fragment budget overshoot is the notable case, not the routine
 * one: a `high`/`mid` scrub goes through this path on every tick by design
 * (client-side `profile-degraded`, already logged once per drag on the
 * feeder), and logging every such call here would spam nothing new. A
 * fragment that alone exceeds the budget is different — it is never returned
 * empty (never-empty is {@link fragmentsWithinBudget}'s contract), but an
 * operator debugging a slow drag needs to know it happened.
 */
export function oversizeFragmentLogMeta(
  gop: Pick<GopRange, 'oversizeFragment' | 'data'>,
  args: { profile: string; startMs: number; epochMs: number },
): Record<string, unknown> | null {
  if (!gop.oversizeFragment) return null
  return {
    profile: args.profile,
    startMs: args.startMs,
    epochMs: args.epochMs,
    fragmentBytes: gop.data.length,
    maxBytes: SCRUB_GOP_BUDGET_MAX_BYTES,
  }
}

/** Default ranged opener: ONE `fs.open` per GOP answer serving all its reads. */
async function openRangeFromDisk(absPath: string, size: number): Promise<ClosableRangeReadable> {
  const handle = await fs.open(absPath, 'r')
  return {
    size,
    read: async (offset: number, length: number): Promise<Uint8Array> => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return Uint8Array.from(buf.subarray(0, bytesRead))
    },
    close: () => handle.close(),
  }
}

/** Bytes in one operator-facing gigabyte — the same decimal GB `maxUsedGb`
 *  uses, so two knobs on the same page never mean two different things. */
const BYTES_PER_GB = 1_000_000_000

/**
 * The operator-armed rebalance, both halves (D116, Phase 2).
 *
 * `arm: false` is the dry run the operator confirms; `arm: true` enqueues one
 * relocate job per planned move, FIFO behind the single-flight mover. The two
 * share this one body deliberately: what is confirmed is exactly what runs.
 *
 * Every refusal is LOGGED, per camera. A rebalance that quietly leaves half the
 * archive where it was is indistinguishable from one that had nothing to do,
 * and this repo has paid for that ambiguity twice.
 */
async function runRebalance(
  deps: RecordingProviderDeps,
  input: RecordingRebalanceInput,
  arm: boolean,
): Promise<RecordingRebalancePlan> {
  const relocate = deps.relocate
  if (!deps.placementSnapshot) throw new Error('placement is not active on this node')
  if (arm && !relocate) throw new Error('relocation unavailable on this node')
  const snapshot = await deps.placementSnapshot()
  const plan = planRebalance({
    assignments: snapshot.assignments,
    sources: deps.index.piles(),
    headroom: snapshot.headroom,
    ...(input.minMoveGb !== undefined ? { minMoveBytes: input.minMoveGb * BYTES_PER_GB } : {}),
  })

  for (const skip of plan.skipped) {
    deps.logger.info('recorder rebalance: footage left where it is', {
      tags: { deviceId: skip.deviceId },
      meta: {
        profile: skip.profile,
        from: skip.fromLocationId,
        to: skip.toLocationId,
        bytes: skip.bytes,
        reason: skip.reason,
      },
    })
  }

  const result: RecordingRebalancePlan = {
    moves: [...plan.moves],
    skipped: [...plan.skipped],
    bytesToMove: plan.bytesToMove,
    jobIds: [],
  }
  if (!arm || !relocate) return result

  const jobIds: string[] = []
  for (const move of plan.moves) {
    const jobId = relocate.start({
      fromLocationId: move.fromLocationId,
      toLocationId: move.toLocationId,
      deviceId: move.deviceId,
      profiles: [move.profile],
      ...(input.throttleMbps !== undefined ? { throttleMbps: input.throttleMbps } : {}),
    })
    jobIds.push(jobId)
    deps.logger.info('recorder rebalance: relocate job enqueued', {
      tags: { deviceId: move.deviceId },
      meta: {
        jobId,
        profile: move.profile,
        from: move.fromLocationId,
        to: move.toLocationId,
        bytes: move.bytes,
        files: move.files,
      },
    })
  }
  return { ...result, jobIds }
}

/**
 * What a COVERAGE read answers, before a caller says how the read WENT.
 *
 * The `read: 'read' | 'unreadable'` mark belongs to the answer's caller, not
 * to this body: the batch has carried it since the grid existed and the
 * singular collection answer gained it with D625. Keeping it out here is what
 * lets both call the same function and neither invent a second definition of
 * "no footage".
 */
export interface RecordingCoverage {
  readonly deviceId: number
  readonly ranges: readonly { profile: string; startMs: number; endMs: number }[]
  readonly profilesWithFootage: readonly string[]
}

/**
 * The per-camera availability read. ONE body, called by the singular method
 * and by the batch alike — the batch collapses the TRANSPORT, and sharing the
 * function is what makes that literally true instead of aspirational.
 */
export async function readRecordingCoverage(
  deps: RecordingProviderDeps,
  deviceId: number,
  fromMs: number,
  toMs: number,
  requestedProfile?: string,
): Promise<RecordingCoverage> {
  // The progressive timeline needs EXACT ranges: a real day on this archive
  // holds 88 gaps over a second, including one of 1,011 s, and the hour
  // containing seventeen missing minutes must not render solid.
  //
  // Read from the calendar rungs when they are wired: the segment
  // filenames already carry start and duration, so exactness costs one
  // directory read per hour and no file is opened — 25 reads for a cold
  // day (1,489 ms, 19 ms warm) against an archive walk of 258,449 files.
  // ONE profile: the timeline is a single bar, and enumerating all three
  // triples the reads for an identical answer.
  const calendar = deps.calendar
  if (calendar) {
    // What EXISTS, always — the answer may describe one profile but it must
    // not imply the others are absent (D433). Same shallow read the pick
    // already makes.
    const profilesWithFootage = await calendar.profilesWithFootageFor(deviceId)
    // What is DESCRIBED: the one asked for when this camera records it, else
    // the availability pick. `servedProfileFor` already owns that fallback.
    const profile = await calendar.servedProfileFor(deviceId, requestedProfile)
    if (profile === null)
      return { deviceId, ranges: [], profilesWithFootage: [...profilesWithFootage] }
    const ranges: RecordingAvailability['ranges'] = []
    for (const r of await calendar.rangesIn(deviceId, profile, fromMs, toMs)) {
      ranges.push({ profile, startMs: r.startMs, endMs: r.endMs })
    }
    return { deviceId, ranges, profilesWithFootage: [...profilesWithFootage] }
  }

  // Fallback while the calendar is unwired: the whole-index answer, which
  // needs the archive-wide walk to have completed.
  const profiles = new Set(deps.index.segments(deviceId).map((s) => s.profile))
  const asked = requestedProfile !== undefined && profiles.has(requestedProfile)
  const legacy = [...profiles]
    .filter((p) => !asked || p === requestedProfile)
    .flatMap((profile) =>
      deps.index
        .ranges(deviceId, profile, fromMs, toMs, RANGE_MERGE_GAP_MS)
        .map((r) => ({ profile, startMs: r.startMs, endMs: r.endMs })),
    )
  // The whole-index fallback already knows every profile; say so in the
  // same field the calendar path fills.
  return { deviceId, ranges: legacy, profilesWithFootage: [...profiles].sort() }
}

/** The per-camera day read. Same rule as {@link availabilityFor}: one body. */
export async function readRecordingDays(
  deps: RecordingProviderDeps,
  deviceId: number,
  fromMs: number,
  toMs: number,
  tzOffsetMinutes: number,
): Promise<readonly number[]> {
  // The cheapest question in the product, answered at its own rung: one
  // directory read per day instead of walking 258,449 files.
  const calendar = deps.calendar
  if (calendar) {
    return await calendar.localDays(deviceId, fromMs, toMs, tzOffsetMinutes)
  }
  const starts = deps.index.segments(deviceId).map((s) => s.startMs)
  return distinctRecordingDays(starts, fromMs, toMs, tzOffsetMinutes)
}

export function buildRecordingProvider(deps: RecordingProviderDeps): IRecordingArchiveProvider {
  const readFile = deps.readFile ?? ((absPath: string): Promise<Buffer> => fs.readFile(absPath))

  const availabilityFor = async (
    deviceId: number,
    fromMs: number,
    toMs: number,
    requestedProfile?: string,
  ): Promise<RecordingCoverage> =>
    await readRecordingCoverage(deps, deviceId, fromMs, toMs, requestedProfile)

  const daysWithRecordingsFor = async (
    deviceId: number,
    fromMs: number,
    toMs: number,
    tzOffsetMinutes: number,
  ): Promise<readonly number[]> =>
    await readRecordingDays(deps, deviceId, fromMs, toMs, tzOffsetMinutes)

  /**
   * Refuse an over-cap ask. NEVER truncate: a caller that asked for 300 cameras
   * and silently got 200 rows cannot tell the difference from a complete
   * answer, and would render an empty timeline for the hundred it never learned
   * were dropped. The tRPC route refuses the same ask at the schema; this is
   * the same refusal for an in-process caller.
   */
  const refuseOverCap = (method: string, count: number): void => {
    if (count <= RECORDING_TIMELINE_BATCH_MAX) return
    throw new Error(
      `${method}: ${count} deviceIds exceeds the ${RECORDING_TIMELINE_BATCH_MAX} cap — split the ask into ${Math.ceil(count / RECORDING_TIMELINE_BATCH_MAX)} calls`,
    )
  }

  return {
    getStatus: async ({ deviceId }): Promise<RecordingStatus | null> => {
      const config = await loadDeviceConfig(deps.configStore, deviceId)
      return statusFor(deps, deviceId, config)
    },

    /**
     * `getAvailability` for a SET of cameras. Same body per camera, run
     * concurrently; only the transport collapses.
     *
     * Every requested id gets a row. A camera whose calendar rung throws is
     * marked `'unreadable'` and SAID SO, per camera — an empty `ranges` on an
     * unreadable row means nothing, and a timeline that renders it as "no
     * footage" tells the operator something nobody established.
     */
    getAvailabilityBatch: async ({
      deviceIds,
      fromMs,
      toMs,
    }): Promise<readonly RecordingAvailabilityForDevice[]> => {
      refuseOverCap('getAvailabilityBatch', deviceIds.length)
      return Promise.all(
        deviceIds.map(async (deviceId): Promise<RecordingAvailabilityForDevice> => {
          try {
            const { ranges, profilesWithFootage } = await availabilityFor(deviceId, fromMs, toMs)
            // The batch answers exactly what the singular one does, field for
            // field — a row that dropped `profilesWithFootage` would tell a
            // grid caller the archive holds one profile (D433).
            return { deviceId, read: 'read', ranges, profilesWithFootage }
          } catch (err: unknown) {
            deps.logger.warn('recording availability could not be read', {
              tags: { deviceId },
              meta: { error: String(err), fromMs, toMs },
            })
            return { deviceId, read: 'unreadable', ranges: [], profilesWithFootage: [] }
          }
        }),
      )
    },

    /**
     * `getDaysWithRecordings` for a SET of cameras. Same rule as
     * `getAvailabilityBatch`: one row per requested id, and a camera nobody
     * could read is marked, never given an empty day list.
     */
    getDaysWithRecordingsBatch: async ({
      deviceIds,
      fromMs,
      toMs,
      tzOffsetMinutes,
    }): Promise<readonly RecordingDaysForDevice[]> => {
      refuseOverCap('getDaysWithRecordingsBatch', deviceIds.length)
      return Promise.all(
        deviceIds.map(async (deviceId): Promise<RecordingDaysForDevice> => {
          try {
            const days = await daysWithRecordingsFor(deviceId, fromMs, toMs, tzOffsetMinutes)
            return { deviceId, read: 'read', days }
          } catch (err: unknown) {
            deps.logger.warn('recording days could not be read', {
              tags: { deviceId },
              meta: { error: String(err), fromMs, toMs },
            })
            return { deviceId, read: 'unreadable', days: [] }
          }
        }),
      )
    },

    getStorageUsage: async (): Promise<RecordingStorageUsage> => {
      const locations = deps.locations()
      const locationIds = new Set(locations.map((l) => l.id))
      // The per-camera rows are an ARCHIVE answer (D418): the ledger's own fold
      // over its hour summary, ONE call for every camera, never
      // `index.accounting` per camera — that one answers about RESIDENCY, and
      // reporting it as "used" and "oldest footage" is what cost a day on
      // 2026-09-09.
      const deviceUsage = buildDeviceUsage({
        locationIds,
        archive: deps.archiveDeviceUsage?.(locationIds) ?? null,
        resident: (deviceId) => deps.index.accounting(deviceId),
        logger: deps.logger,
      })
      const devices = deviceUsage.devices
      const totalUsedBytes = deviceUsage.totalUsedBytes
      // ONE row per PHYSICAL volume: locations aliasing a root (recordings +
      // recordingsLow on one disk) previously produced two identical "disks"
      // whose used split was an artifact of hydrate ordering (the last-walked
      // alias owned every hydrated row). Group by the same physical-root key
      // the eviction domain uses and account the DOMAIN.
      const byPhysical = new Map<string, RecordingsLocation[]>()
      for (const loc of locations) {
        const key = physicalRootKey(loc.root)
        const group = byPhysical.get(key)
        if (group) group.push(loc)
        else byPhysical.set(key, [loc])
      }
      const locationUsages: RecordingLocationUsage[] = await Promise.all(
        [...byPhysical.values()].map(async (group): Promise<RecordingLocationUsage> => {
          const first = group[0]!
          const writable = group.some((l) => locationMayBeWritten(l))
          const cap = writable
            ? await deps.capacity(first.root)
            : { availableBytes: null, totalBytes: null }
          const ids = group.map((l) => l.id)
          // A volume that would not answer degrades to null capacity — and SAYS
          // so. Without this line a network root that stopped responding is
          // indistinguishable from a filesystem with no capacity notion, and
          // the UI's "capacity unknown" is the only trace it ever leaves.
          if (cap.error !== undefined) {
            deps.logger.warn('recorder: volume capacity unavailable (statfs failed)', {
              meta: { locationId: first.id, root: first.root, error: cap.error },
            })
          }
          return {
            locationId: first.id,
            locationIds: ids,
            root: first.root,
            usedBytes: (await deps.archiveAccounting?.(new Set(ids)))?.bytes ?? 0,
            availableBytes: cap.availableBytes,
            totalBytes: cap.totalBytes,
          }
        }),
      )
      // The two numbers are the SAME hour rows counted two ways — folded per
      // camera and summed in SQL. A gap means one read saw a fraction of the
      // archive, and a page that shows both without comparing them is how a
      // 97% gap reads as a fact about the disks (D418).
      warnOnUsageMismatch(
        deps.logger,
        totalUsedBytes,
        locationUsages.reduce((sum, l) => sum + l.usedBytes, 0),
        deviceUsage.read,
      )
      return {
        nodeId: deps.nodeId,
        totalUsedBytes,
        // The cap's `z.array` infers a mutable array; the rows themselves are
        // never touched after `buildDeviceUsage` produced them.
        devices: [...devices],
        devicesRead: deviceUsage.read,
        complete:
          deviceUsage.read === 'archive' && (deps.archiveUsageComplete?.(locationIds) ?? false),
        locations: locationUsages,
      }
    },

    getDeviceConfig: async ({ deviceId }): Promise<RecordingConfig> =>
      loadDeviceConfig(deps.configStore, deviceId),

    // Locate footage at a wall-clock instant: the covering segment's window, or
    // a gap carrying the forward nearest covered edge (null past the end) plus
    // the backward covered edge (`prevEndMs` — lets the feeder's backward
    // frame-step hop the ~11-17 ms inter-segment cracks). Lets a feeder in
    // another process seek recorded footage over tRPC.
    locateSegment: async ({ deviceId, profile, epochMs }): Promise<LocateSegmentResult> => {
      // The live hour is write-through via addSegment but never marked
      // hydrated (one finalize ≠ a walked hour). Scrub used to readdir that
      // hour on every tick anyway, queued behind calendar FUSE, and missed
      // its 8 s budget (`segment read timeout` on 104/low, 2026-08-22).
      // If RAM already covers the instant, disk has nothing to add.
      const covering = deps.index.segmentAt(deviceId, profile, epochMs)
      if (covering) {
        return {
          kind: 'segment',
          startMs: covering.startMs,
          durMs: covering.durMs,
          bytes: covering.bytes,
        }
      }
      const hydrateFromMs = Math.max(0, epochMs - LOCATE_HYDRATE_MARGIN_MS)
      const hydrateToMs = epochMs + LOCATE_HYDRATE_MARGIN_MS
      if (deps.index.hydrationOf(deviceId, hydrateFromMs, hydrateToMs) !== 'hydrated') {
        await deps.hydrateWindow?.(deviceId, hydrateFromMs, hydrateToMs)
      }
      const seg = deps.index.segmentAt(deviceId, profile, epochMs)
      if (seg) return { kind: 'segment', startMs: seg.startMs, durMs: seg.durMs, bytes: seg.bytes }
      return {
        kind: 'gap',
        nearestEdgeMs: deps.index.nearestCoveredEdge(deviceId, profile, epochMs),
        prevEndMs: deps.index.coveredEdgeBefore(deviceId, profile, epochMs),
      }
    },

    // Read one finalized segment's raw bytes by its exact startMs, resolving its
    // absolute path from the matching location root. Throws a clear error when the
    // segment or its location is unknown.
    readSegmentBytes: async ({ deviceId, profile, startMs }): Promise<ReadSegmentBytesResult> => {
      const { abs } = resolveSegmentFile(deps, deviceId, profile, startMs)
      const data = await readFile(abs)
      // Normalize to a Uint8Array backed by a plain ArrayBuffer — `fs.readFile`
      // yields a Buffer<ArrayBufferLike>, which the result schema's
      // `z.instanceof(Uint8Array)` (Uint8Array<ArrayBuffer>) won't accept directly.
      return { data: Uint8Array.from(data) }
    },

    // The scrub-granular read (D31's letter on the D42 feeder path): resolve
    // the fragment(s) covering `epochMs` through the segment's own mfra and
    // read ONLY their byte range (tail + moov head + as many CONSECUTIVE
    // moof/mdat fragments as fit `SCRUB_GOP_BUDGET_MAX_BYTES` — segments-60s
    // Task 1: a byte budget over `tfra` converts into a set of fragments
    // without reading the payload). A segment whose index will not parse
    // degrades INSIDE the mechanism to the whole file — a worse read, not
    // another path — and that fallback logs: a silent downgrade here would
    // look exactly like the byte-range design working.
    readGopBytes: async ({ deviceId, profile, startMs, epochMs }): Promise<ReadGopBytesResult> => {
      const { abs, seg } = resolveSegmentFile(deps, deviceId, profile, startMs)
      const openRange = deps.openRangeReadable ?? openRangeFromDisk
      const file = await openRange(abs, seg.bytes)
      try {
        const gop = await readGopRange(file, {
          segmentStartMs: seg.startMs,
          segmentDurMs: seg.durMs,
          epochMs,
          seededIndex: deps.mfraFor?.(deviceId, profile, startMs),
          maxBytes: SCRUB_GOP_BUDGET_MAX_BYTES,
        })
        if (gop !== null) {
          const oversizeMeta = oversizeFragmentLogMeta(gop, { profile, startMs, epochMs })
          if (oversizeMeta !== null) {
            deps.logger.warn(
              'recording: readGopBytes served one fragment that alone exceeds the scrub budget',
              { tags: { deviceId }, meta: oversizeMeta },
            )
          }
          return { data: gop.data, gopStartMs: gop.gopStartMs, gopDurMs: gop.gopDurMs }
        }
      } finally {
        await file.close()
      }
      deps.logger.warn(
        'recording: readGopBytes fell back to the WHOLE segment (mfra/moov unparseable)',
        {
          tags: { deviceId },
          meta: { profile, startMs },
        },
      )
      const data = await readFile(abs)
      return { data: Uint8Array.from(data), gopStartMs: seg.startMs, gopDurMs: seg.durMs }
    },

    // The replay clip's window read (docs/design/plans/2026-08-26-clip-replay-on-pipeline.md):
    // resolve the fragments covering `[fromMs, toMs)` through the segment's
    // own mfra, by byte range — the multi-GOP twin of `readGopBytes` above.
    // REFUSES rather than degrading when the window runs past the covering
    // segment: stitching bytes from a second segment file (its own
    // `ftyp`+`moov`) is not a standalone-demuxable stream, so this asks the
    // caller for a shorter or better-aligned window instead of handing back
    // spliced bytes nothing has proven decodable.
    readWindowBytes: async ({
      deviceId,
      profile,
      startMs,
      fromMs,
      toMs,
    }): Promise<ReadWindowBytesResult> => {
      const { abs, seg } = resolveSegmentFile(deps, deviceId, profile, startMs)
      const segmentEndMs = seg.startMs + seg.durMs
      if (toMs > segmentEndMs) {
        deps.logger.warn(
          'recording: readWindowBytes refused — window runs past this segment, not silently clipped',
          { tags: { deviceId }, meta: { profile, startMs, fromMs, toMs, segmentEndMs } },
        )
        return { kind: 'spans-multiple-segments', segmentEndMs }
      }
      const openRange = deps.openRangeReadable ?? openRangeFromDisk
      const file = await openRange(abs, seg.bytes)
      try {
        const gop = await readGopWindowRange(file, {
          segmentStartMs: seg.startMs,
          segmentDurMs: seg.durMs,
          fromMs,
          toMs,
          seededIndex: deps.mfraFor?.(deviceId, profile, startMs),
          maxBytes: WINDOW_READ_MAX_BYTES,
        })
        if (gop !== null) {
          if (gop.reachesWindowEnd !== true) {
            deps.logger.warn(
              'recording: readWindowBytes truncated by its safety byte cap before covering the requested window',
              {
                tags: { deviceId },
                meta: {
                  profile,
                  startMs,
                  fromMs,
                  toMs,
                  bytes: gop.data.length,
                  WINDOW_READ_MAX_BYTES,
                },
              },
            )
          }
          return {
            kind: 'ok',
            data: gop.data,
            gopStartMs: gop.gopStartMs,
            gopDurMs: gop.gopDurMs,
            reachesRequestedEnd: gop.reachesWindowEnd === true,
          }
        }
      } finally {
        await file.close()
      }
      deps.logger.warn(
        'recording: readWindowBytes fell back to the WHOLE segment (mfra/moov unparseable)',
        { tags: { deviceId }, meta: { profile, startMs, fromMs, toMs } },
      )
      const data = await readFile(abs)
      return {
        kind: 'ok',
        data: Uint8Array.from(data),
        gopStartMs: seg.startMs,
        gopDurMs: seg.durMs,
        reachesRequestedEnd: true,
      }
    },

    // Validate + persist the config, then (B2) re-evaluate the band controller
    // so a changed continuous band attaches/detaches ffmpeg immediately. The
    // config is already persisted before the re-evaluate runs; a re-evaluate
    // failure (e.g. broker not ready) is logged but does NOT fail the save — the
    // readiness queue / periodic tick retries the attach.
    setDeviceConfig: async ({ deviceId, config }): Promise<RecordingConfig> => {
      const saved = await saveDeviceConfig(deps.configStore, deviceId, config)
      // BEFORE the re-evaluate: `onConfigChanged` reaches `evaluateDevice`,
      // which reads the config straight back. A mirror updated after it would
      // hand the operator's own edit a decision made against the old value.
      deps.onConfigSaved?.(deviceId, saved)
      if (deps.onConfigChanged) {
        try {
          await deps.onConfigChanged(deviceId)
        } catch (err: unknown) {
          deps.logger.warn('recorder: re-evaluate after setDeviceConfig failed', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
        }
      }
      return saved
    },

    rescanStorage: async ({ deviceId }): Promise<RecordingStatus> => {
      const locations = await deps.refreshLocations()
      await deps.hydrateDevice(deviceId, locations)
      await deps.reconcileHourLedger?.(deviceId)
      const config = await loadDeviceConfig(deps.configStore, deviceId)
      await deps.opsLog?.append({
        op: 'rescan',
        reason: 'operator',
        deviceId,
        itemsAffected: deps.index.segments(deviceId).length,
        bytesReclaimed: 0,
        detail: 'rescanned footage from disk',
      })
      return statusFor(deps, deviceId, config)
    },

    pruneFootage: async ({
      deviceId,
      reason,
    }): Promise<{ floorMs: number | null; deletedBuckets: number; reclaimedBytes: number }> => {
      const config = await loadDeviceConfig(deps.configStore, deviceId)
      const retention = config.retention
      const nowMs = Date.now()
      // Retention selects from the ARCHIVE, never from the resident index
      // (D295). `deps.index.segments(deviceId)` used to feed this, and since
      // D287 it answers with the live tail plus whatever an operator looked
      // at — a policy prune over it deletes a fraction of what expired and
      // returns a floor computed from that same fraction, which is
      // indistinguishable from a correct prune. §P4 named this; nobody could
      // see it because no device declares a policy yet.
      const archive = deps.archive?.() ?? null
      if (archive === null) {
        deps.logger.warn(
          'recorder: retention prune SKIPPED — no durable hour ledger on this node, and the resident index is not the archive',
          { tags: { deviceId }, meta: { reason: reason ?? 'retention' } },
        )
        return { floorMs: null, deletedBuckets: 0, reclaimedBytes: 0 }
      }
      const plan = await selectEvictionsFromArchive(archive, deviceId, {
        maxAgeDays: retention?.maxAgeDays,
        maxSizeGb: retention?.maxSizeGb,
        nowMs,
      })
      if (retention?.maxSizeGb != null && retention.maxSizeGb > 0 && !plan.sizeLimitApplied) {
        deps.logger.warn(
          'recorder: retention SIZE limit not enforced this pass — the archive could not report the camera total, and a size prune without it would delete on a guess',
          { tags: { deviceId }, meta: { maxSizeGb: retention.maxSizeGb } },
        )
      }
      const { reclaimedBytes, deletedBuckets } = await evictVictims(deps, deviceId, plan.victims)
      // N of M, every pass — the number a silent under-prune cannot survive.
      deps.logger.info('recorder: retention prune pass', {
        tags: { deviceId },
        meta: {
          reason: reason ?? 'retention',
          archiveSegments: plan.archiveSegments,
          seen: plan.seen,
          selected: plan.victims.length,
          deletedBuckets,
          reclaimedBytes,
          boundedByPassCap: plan.bounded,
        },
      })
      if (plan.bounded) {
        deps.logger.warn(
          'recorder: retention prune stopped at its per-pass cap — footage past the cutoff is STILL on disk and the next sweep continues from here',
          { tags: { deviceId }, meta: { selected: plan.victims.length } },
        )
      }
      // Retention floor: oldest surviving footage start, or null when none
      // left. Asked of the archive AFTER the delete, for the same reason the
      // selection was: the resident index's oldest is the oldest row it
      // happens to hold, which on a cold camera is minutes ago.
      const survivingOldest = (await archive.census({ deviceId }))?.oldestMs ?? null
      const floorMs =
        survivingOldest ?? (retention?.maxAgeDays ? nowMs - retention.maxAgeDays * DAY_MS : null)
      // Best-effort audit — never fails the prune it records. `reason` defaults to
      // 'retention' (the policy-driven prune); the disk-pressure path passes 'quota'.
      const opReason: OpsLogReason = reason ?? 'retention'
      await deps.opsLog?.append({
        op: 'prune',
        reason: opReason,
        deviceId,
        itemsAffected: deletedBuckets,
        bytesReclaimed: reclaimedBytes,
        detail: floorMs === null ? 'no footage remaining' : `floor moved to ${floorMs}`,
      })
      return { floorMs, deletedBuckets, reclaimedBytes }
    },

    deleteFootprint: async ({
      deviceId,
      fromMs,
      toMs,
    }): Promise<{ deletedBuckets: number; reclaimedBytes: number }> => {
      // Whole footprint when neither bound is given; otherwise every segment
      // overlapping [fromMs, toMs). A segment [startMs, startMs+durMs) overlaps
      // the window iff it starts before the window ends AND ends after it starts.
      const lo = fromMs ?? Number.NEGATIVE_INFINITY
      const hi = toMs ?? Number.POSITIVE_INFINITY
      const victims = deps.index
        .segments(deviceId)
        .filter((s) => s.startMs < hi && s.startMs + s.durMs > lo)
      const { reclaimedBytes, deletedBuckets } = await evictVictims(deps, deviceId, victims)
      const windowed = fromMs !== undefined || toMs !== undefined
      await deps.opsLog?.append({
        op: 'manual-delete',
        reason: 'manual',
        deviceId,
        itemsAffected: deletedBuckets,
        bytesReclaimed: reclaimedBytes,
        detail: windowed
          ? `deleted footage in [${fromMs ?? '−∞'}, ${toMs ?? '+∞'})`
          : 'deleted all footage',
      })
      return { deletedBuckets, reclaimedBytes }
    },

    listOpsLog: async ({ deviceId, limit }): Promise<readonly OpsLogEntry[]> =>
      (await deps.opsLog?.list({ deviceId, limit })) ?? [],

    renderClip: async (input) => {
      if (!deps.clipRender)
        throw userError(
          'recording.clip-render-unavailable',
          undefined,
          'clip rendering unavailable on this node',
        )
      return deps.clipRender(input)
    },
    renderGif: async (input) => {
      if (!deps.gifRender) throw new Error('gif rendering unavailable on this node')
      return deps.gifRender(input)
    },
    pauseForStorageMigration: async ({ leaseId }) => {
      if (!deps.pauseForStorageMigration) throw new Error('storage migration pause unavailable')
      await deps.pauseForStorageMigration(leaseId)
      return { paused: true }
    },
    resumeForStorageMigration: async ({ leaseId }) => {
      if (!deps.resumeForStorageMigration) throw new Error('storage migration resume unavailable')
      await deps.resumeForStorageMigration(leaseId)
      return { resumed: true }
    },
    refreshStorageLocationsForMigration: async ({ leaseId }) => {
      if (!deps.refreshStorageLocationsForMigration)
        throw new Error('storage migration location refresh unavailable')
      await deps.refreshStorageLocationsForMigration(leaseId)
      return { refreshed: true }
    },
    startStorageMigrationMove: async (input) => {
      if (!deps.relocate) throw new Error('relocation unavailable on this node')
      deps.assertStorageMigrationLease?.(input.leaseId)
      return { jobId: await startFootageMover(deps, deps.relocate, input) }
    },
    getStorageMigrationMoveStatus: async ({ jobId }) =>
      deps.relocate?.list().find((job) => job.jobId === jobId) ?? null,
    cancelStorageMigrationMove: async ({ jobId }) => ({
      cancelled: deps.relocate?.cancel(jobId) ?? false,
    }),

    // ── Operator-armed relocation + rebalance (D116, Phase 2) ─────────────
    relocateFootage: async (input): Promise<{ jobId: string }> => {
      if (!deps.relocate) throw new Error('relocation unavailable on this node')
      const jobId = await startFootageMover(deps, deps.relocate, input)
      deps.logger.info('recorder: relocate job enqueued', {
        ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
        meta: {
          jobId,
          from: input.fromLocationId,
          to: input.toLocationId,
          profiles: input.profiles ?? null,
        },
      })
      return { jobId }
    },
    listRelocateJobs: async (): Promise<readonly RelocateJob[]> => deps.relocate?.list() ?? [],
    /**
     * What `fromLocationId` STILL holds for this class — the number a "drain
     * remaining" action is allowed to be built on.
     *
     * It is a ledger census over EXACTLY the scope a relocation of this shape
     * would move (`relocateScope`, the same derivation the mover's own work
     * list and `filesTotal` use), so a residue can never disagree with the
     * drain that acts on it. `null` for "the archive could not be asked" — a
     * node with no ledger, or a failed aggregate — and never `0`, which would
     * read as "the source is empty" and hide the whole problem (D295).
     */
    getRelocateResidue: async ({ fromLocationId, footageClass }): Promise<RelocateResidue> => {
      const archive = deps.archive?.() ?? null
      if (archive === null) {
        deps.logger.warn(
          'recorder: relocate residue UNKNOWN — no durable hour ledger on this node, and the resident index is not the archive',
          { meta: { fromLocationId, footageClass: footageClass ?? null } },
        )
        return null
      }
      const scope = relocateScope({ fromLocationId, ...(footageClass ? { footageClass } : {}) })
      // A scope that selects nothing is not an unanswerable read: this class
      // owns no profile on this location, so the honest residue is zero.
      if (scope === null) return { segments: 0, bytes: 0 }
      const census = await archive.census(scope)
      return census === null ? null : { segments: census.segments, bytes: census.bytes }
    },
    /**
     * Walk one location's claimed hours and diff them against the disk (D319).
     *
     * Refuses rather than guessing when the reconciler is not wired on this
     * node: a report whose numbers came from nowhere is worse than no report,
     * and `location-unknown` is the honest shape for "nothing here can answer".
     */
    reconcileLedgerAgainstDisk: async (input): Promise<LedgerWalkReport> => {
      const reconciler = deps.ledgerWalk
      if (reconciler === undefined) {
        deps.logger.warn(
          'recorder: ledger walk unavailable on this node — no durable hour ledger is wired here',
          { meta: { locationId: input.locationId } },
        )
        return {
          locationId: input.locationId,
          applied: input.apply === true,
          refused: 'no-ledger',
          archiveSegments: null,
          archiveBytes: null,
          hoursClaimed: 0,
          hoursWalked: 0,
          hoursMissing: 0,
          listings: 0,
          segmentsClaimed: 0,
          ghostSegments: 0,
          ghostBytes: 0,
          ghostHoursWhole: 0,
          forgottenSegments: 0,
          forgottenBytes: 0,
          orphanFiles: 0,
          orphanSample: [],
          hoursSkipped: 0,
          skippedByReason: {
            'live-tail': 0,
            'listing-error': 0,
            'path-mismatch': 0,
            'durable-refused': 0,
          },
          bounded: false,
          byDevice: [],
        }
      }
      return reconciler.run({
        locationId: input.locationId,
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(input.profiles !== undefined ? { profiles: input.profiles } : {}),
      })
    },
    cancelRelocateJob: async ({ jobId }): Promise<{ cancelled: boolean }> => ({
      cancelled: deps.relocate?.cancel(jobId) ?? false,
    }),
    planStorageRebalance: (input): Promise<RecordingRebalancePlan> =>
      runRebalance(deps, input, false),
    startStorageRebalance: (input): Promise<RecordingRebalancePlan> =>
      runRebalance(deps, input, true),
    getPlacement: async () => {
      if (!deps.placementView) throw new Error('placement is not active on this node')
      const view = await deps.placementView()
      // The cap's output type is generated from its zod schema and is MUTABLE;
      // the internal view is readonly by construction, which is the right shape
      // for everything upstream of here. Copy at the boundary rather than
      // widening the internal contract (it would lose the guarantee everywhere)
      // or casting (this repo does not). The arrays are built fresh per call and
      // hold one row per camera-profile, so the copy is not a cost.
      return {
        assignments: [...view.assignments],
        pins: [...view.pins],
        defaultLocations: { ...view.defaultLocations },
      }
    },
    setDevicePlacement: async ({ deviceId, locationId }) => {
      if (!deps.setDevicePlacement) throw new Error('placement is not active on this node')
      await deps.setDevicePlacement(deviceId, locationId)
      return { ok: true as const }
    },
    // ── exposesDeviceSettings trio (device-details recording widget) ──────
    // Camera-only: recording is meaningless on non-camera devices, so the
    // "Recording" card/tab must not appear for them.
    getDeviceSettingsContribution: async ({
      deviceId,
    }): Promise<ConfigUISchemaWithValues | null> => {
      if (deps.isCameraDevice && !(await deps.isCameraDevice(deviceId))) return null
      return hydrateSchema(buildRecordingDeviceSchema(), {})
    },
    getDeviceLiveContribution: async (): Promise<ConfigUISchemaWithValues | null> => null,
    applyDeviceSettingsPatch: async ({ deviceId, patch }): Promise<{ success: true }> => {
      const keys = Object.keys(patch ?? {})
      if (keys.length > 0) {
        deps.logger.debug('recorder: ignoring legacy settings patch (widget owns settings)', {
          tags: { deviceId },
          meta: { keys },
        })
      }
      return { success: true }
    },
  }
}
