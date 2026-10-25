/**
 * Recover `.rec-tmp` segments that a writer restart orphaned.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The segment watcher's ONLY record of what it still owes is ffmpeg's
 * `-segment_list live.m3u8`. ffmpeg opens that file in TRUNCATE mode on every
 * spawn, so a writer respawn destroys it. Every segment written but not yet
 * relocated at that instant becomes permanently unreachable:
 *
 *   - no playlist names it, so no watcher will ever finalize it;
 *   - `parseSegmentPath` cannot see it — staging is flat and dot-prefixed, kept
 *     deliberately out of the hydrate walk — so retention never counts it;
 *   - the one `.rec-tmp` sweep that exists (`sweepUnassignedStaging`) touches
 *     only locations with ZERO placement assignments, never the live one.
 *
 * So the footage is not deleted and not kept: it is stranded, and it accrues
 * for as long as the install runs.
 *
 * `segment-watcher.ts` carries a comment asserting the opposite — that the
 * playlist "is NOT cleared between runs", which is what its `stale-previous-run`
 * classification and its documented "that is the crash recovery" path are built
 * on. The live filesystem refutes it, and a leftover that describes the right
 * design reads as verification: on 2026-08-14 `/recordings/.rec-tmp/104/high/`
 * held a `live.m3u8` of 50 entries, every one named at or after that writer's
 * 20:28:31 start, beside **5 863 older `.m4s` files referenced by nobody** —
 * the oldest from 2026-07-04. Fleet total: 179 GB, on an array at 90% full.
 *
 * WHAT THIS DOES NOT DO
 * ─────────────────────
 * It never deletes. Recovery is the same `SegmentStore.onFinalized` the live
 * path uses — stat, relocate into the UTC bucket, index — so a recovered
 * segment is indistinguishable from one that was never orphaned, and a segment
 * it cannot place stays exactly where it is for the next attempt.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { nodeLoopPacer } from '../loop-pacer.js'
import { STAGING_DIR_NAME } from './recording-controller.js'
import { parseEpochStartMs, parseLivePlaylist } from './segment-watcher.js'

/** One staged segment this run did not write, with the duration we can defend. */
export interface StagingOrphan {
  /** Bare filename under the staging dir (`<epochSec>.m4s`). */
  readonly name: string
  readonly startMs: number
  readonly durMs: number
}

export interface StagingRecoveryInput {
  /** When the ffmpeg feeding the CURRENT playlist was spawned. */
  readonly writerStartedMs: number
  /** Configured segment length — the fallback duration, and the gap bound. */
  readonly segmentSeconds: number
}

export interface StagingRecoveryPlanInput extends StagingRecoveryInput {
  /** Raw directory listing of the staging dir. */
  readonly names: readonly string[]
  /** Segment names the CURRENT playlist still owns; the watcher will finalize
   *  those itself and must not be raced.
   *
   *  Since 2026-08-29 the playlist is bounded (`segmentListSize`), so this set
   *  is the last N entries rather than the writer's whole history. That does not
   *  weaken the plan: the gate that decides ownership is the file's NAME against
   *  the writer's start, and this set only keeps a recovery pass off the entries
   *  the live watcher is still holding — which are always at the tail. */
  readonly playlistNames?: ReadonlySet<string>
}

/**
 * How far before the writer's own start a segment may be named and still count
 * as belonging to THIS run.
 *
 * Mirrors `segment-watcher.PREVIOUS_RUN_SKEW_MS`, and for the same reason:
 * ffmpeg names segments with whole-second `%s`, so the first segment of a run
 * carries the second already in progress when the process spawned. Without the
 * tolerance a recovery pass would reach for the live writer's opening segment —
 * the one file in the directory that is still being written.
 */
const PREVIOUS_RUN_SKEW_MS = 1_000

/**
 * How much longer than nominal an inter-segment gap may be and still be read as
 * one segment's duration.
 *
 * ffmpeg cuts on keyframes, so a real segment overshoots `-segment_time` by up
 * to a GOP; a gap of twice nominal is still plausibly one segment. Anything
 * wider is a RUN BOUNDARY — the writer was down in between — and the honest
 * duration is the nominal one. Trusting the gap there would paint a solid
 * timeline bar across hours of footage that does not exist, which is a worse
 * failure than under-reporting by a few seconds.
 */
const MAX_GAP_FACTOR = 2

/**
 * Decide which staged files belong to a previous run, and how long each ran.
 *
 * Pure — the caller does the I/O. The gate is the file's own name against the
 * writer's start: a segment named before this ffmpeg spawned cannot be one this
 * ffmpeg is writing, whatever the playlist says.
 */
export function planStagingRecovery(input: StagingRecoveryPlanInput): readonly StagingOrphan[] {
  const nominalMs = input.segmentSeconds * 1000
  const cutoffMs = input.writerStartedMs - PREVIOUS_RUN_SKEW_MS
  const owned = input.playlistNames

  const candidates: Array<{ name: string; startMs: number }> = []
  for (const name of input.names) {
    const startMs = parseEpochStartMs(name)
    if (startMs === null) continue // live.m3u8, dotfiles, anything not a segment
    if (startMs >= cutoffMs) continue // this run's — the watcher owns it
    if (owned?.has(name) === true) continue // still named by the live playlist
    candidates.push({ name, startMs })
  }
  candidates.sort((a, b) => a.startMs - b.startMs)

  const maxGapMs = nominalMs * MAX_GAP_FACTOR
  return candidates.map((c, i) => {
    const next = candidates[i + 1]
    const gapMs = next === undefined ? 0 : next.startMs - c.startMs
    const durMs = gapMs > 0 && gapMs <= maxGapMs ? gapMs : nominalMs
    return { name: c.name, startMs: c.startMs, durMs }
  })
}

export interface StagingRecoveryReport {
  /** Orphans the plan selected. */
  readonly found: number
  readonly recovered: number
  readonly failed: number
  /** True when shutdown cut the pass short — the remainder is still on disk. */
  readonly aborted: boolean
}

/** The logger surface a recovery pass needs. Already device-scoped by the
 *  caller, so every line it writes carries the `deviceId` tag. */
export type StagingRecoveryLogger = Pick<IScopedLogger, 'info' | 'warn' | 'debug'>

/**
 * The two reads a recovery pass makes against a staging dir.
 *
 * Injected rather than called directly, because the recorder controller's rule
 * is that tests stay process-free: a real `readdir` fired from the attach path
 * outlives the attach and makes every timer-based shutdown assertion
 * non-deterministic (measured — it broke the 5 s SIGTERM-grace test).
 * Production wiring is {@link nodeStagingIo}; nothing should hand-roll it.
 */
export interface StagingIo {
  readonly listDir: (dir: string) => Promise<readonly string[]>
  /** Current `live.m3u8` body, or null when it is absent/unreadable. */
  readonly readPlaylist: (dir: string) => Promise<string | null>
}

/** The real filesystem. The only production value of {@link StagingIo}. */
export const nodeStagingIo: StagingIo = {
  listDir: (dir) => fs.readdir(dir),
  readPlaylist: (dir) => fs.readFile(path.join(dir, 'live.m3u8'), 'utf8').catch(() => null),
}

export interface StagingRecoveryDeps extends StagingIo {
  /** Hand one orphan to the same finalize path a live segment takes. */
  readonly finalize: (orphan: StagingOrphan, absPath: string) => Promise<void>
  readonly logger: StagingRecoveryLogger
  /** Orphans handled between yields. */
  readonly chunkSize?: number
  /** Called between chunks — defaults to a macrotask hop. */
  readonly yieldBetween?: () => Promise<void>
  /**
   * Checked before EVERY segment, so a shutting-down controller abandons the
   * pass after at most one relocate rather than one chunk. Nothing is lost: a
   * moved segment leaves staging, so the next attach resumes exactly where this
   * one stopped.
   */
  readonly shouldStop?: () => boolean
}

/** The only `<deviceId>/` subdirectories of staging that hold segments. */
const KNOWN_PROFILES: ReadonlySet<string> = new Set(['high', 'mid', 'low'])

/** Default orphans per chunk. 104/high alone had 5 863 of them. */
const DEFAULT_CHUNK_SIZE = 100

/**
 * Orphans between progress lines.
 *
 * A directory of 5 863 files takes minutes over shfs and used to report only
 * when it finished, so "is it still going, and how far in" had no answer at
 * all — the exact shape of the blackout this pass was written to end.
 */
const PROGRESS_EVERY = 1_000

const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

/**
 * Relocate every previous-run segment left in one staging dir.
 *
 * Chunked with a yield between batches: this runs alongside a live recorder and
 * a backlog is measured in thousands of files over shfs/FUSE — a single
 * uninterrupted loop is exactly the event-loop stall the recorder has already
 * paid for once (D128).
 *
 * A failure is per-segment and never aborts the pass: the file stays in staging
 * and the next attach retries it. Every drop is logged with the segment name —
 * silence reads as "never happened", and this whole class of loss went
 * unnoticed for six weeks precisely because nothing said anything.
 */
export async function recoverStagingOrphans(
  dir: string,
  input: StagingRecoveryInput,
  deps: StagingRecoveryDeps,
): Promise<StagingRecoveryReport> {
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE
  const yieldBetween = deps.yieldBetween ?? macrotask

  let names: readonly string[] | null = null
  try {
    names = await deps.listDir(dir)
  } catch (err: unknown) {
    // A fallible read never destroys work (D49) — and here it cannot: nothing
    // is removed, the backlog simply waits for the next attach.
    deps.logger.warn('recorder: staging recovery could not list the staging dir', {
      meta: { dir, error: err instanceof Error ? err.message : String(err) },
    })
  }
  // The listing is the expensive read in this function — one round-trip over
  // shfs, ~9.4 s on a cold share — so it is PACED whatever it returned, and
  // before the early exits. A pass that only yielded between segment chunks
  // hopped zero times across 58 directories because it found 25 orphans in
  // total, and reported an unpaced 547 s as an idle loop.
  await yieldBetween()
  if (names === null) return { found: 0, recovered: 0, failed: 0, aborted: false }

  let playlistNames: ReadonlySet<string> | undefined
  const body = await deps.readPlaylist(dir).catch(() => null)
  if (body !== null) {
    playlistNames = new Set(parseLivePlaylist(body).map((e) => e.segPath.replace(/^.*\//, '')))
  }

  const plan = planStagingRecovery({ ...input, names, playlistNames })
  if (plan.length === 0) return { found: 0, recovered: 0, failed: 0, aborted: false }

  // START, before a single rename. A pass that only speaks when it finishes is
  // indistinguishable from one that hung, and this one runs for minutes.
  deps.logger.info('recorder: staging recovery starting on a directory', {
    meta: {
      dir,
      found: plan.length,
      staged: names.length,
      oldestMs: plan[0]?.startMs,
      newestMs: plan[plan.length - 1]?.startMs,
    },
  })

  let recovered = 0
  let failed = 0
  let aborted = false

  for (let i = 0; i < plan.length; i++) {
    const orphan = plan[i]!
    if (deps.shouldStop?.() === true) {
      aborted = true
      deps.logger.warn('recorder: staging recovery stopped short by shutdown', {
        meta: { dir, recovered, failed, remaining: plan.length - i },
      })
      break
    }
    try {
      await deps.finalize(orphan, `${dir}/${orphan.name}`)
      recovered += 1
    } catch (err: unknown) {
      failed += 1
      deps.logger.warn('recorder: staging recovery could not relocate an orphaned segment', {
        meta: {
          dir,
          seg: orphan.name,
          startMs: orphan.startMs,
          durMs: orphan.durMs,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
    if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < plan.length) {
      deps.logger.info('recorder: staging recovery progress', {
        meta: { dir, done: i + 1, found: plan.length, recovered, failed },
      })
    }
    if ((i + 1) % chunkSize === 0 && i + 1 < plan.length) await yieldBetween()
  }

  deps.logger.info('recorder: recovered segments a writer restart had orphaned in staging', {
    meta: {
      dir,
      found: plan.length,
      recovered,
      failed,
      aborted,
      oldestMs: plan[0]?.startMs,
      newestMs: plan[plan.length - 1]?.startMs,
    },
  })
  return { found: plan.length, recovered, failed, aborted }
}

/** One recordings location a boot pass sweeps. */
export interface StagedLocation {
  readonly id: string
  readonly root: string
}

/** What the boot pass hands to `SegmentStore.onFinalized` for one orphan. */
export interface StagedFinalizeInput {
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly locationRoot: string
  readonly flatAbsPath: string
  readonly startMs: number
  readonly durMs: number
}

export interface StagingBootDeps extends StagingIo {
  readonly locations: () => readonly StagedLocation[]
  readonly finalize: (input: StagedFinalizeInput) => Promise<void>
  readonly logger: StagingRecoveryLogger
  /** Boot instant — the cutoff. Nothing named after it can be a previous run's. */
  readonly bootMs: number
  /**
   * Configured segment lengths, keyed by deviceId — asked for ONCE per pass.
   *
   * This was a per-device callback, and the implementation behind it re-read
   * and re-validated the recorder's whole 201 KB config blob through hub-main
   * on every call: measured as the ENTIRE `walkMs` (45–267 s across boots)
   * while the 62 directory listings themselves cost 16 ms. The map contract
   * makes that regression structurally impossible — there is nothing left to
   * call in the loop.
   */
  readonly segmentSecondsByDevice: () =>
    | Promise<ReadonlyMap<number, number>>
    | ReadonlyMap<number, number>
  /** Fallback for a device the map does not name. */
  readonly defaultSegmentSeconds: number
  readonly shouldStop?: () => boolean
  readonly chunkSize?: number
  readonly yieldBetween?: () => Promise<void>
}

export interface StagingBootReport {
  readonly dirs: number
  readonly found: number
  readonly recovered: number
  readonly failed: number
  readonly aborted: boolean
}

/** One `<deviceId>/<profile>` staging directory a boot pass recovers. */
interface StagingDirWork {
  readonly location: StagedLocation
  readonly deviceId: number
  readonly profile: string
  readonly dir: string
  readonly segmentSeconds: number
}

/**
 * Staging directories recovered at once in {@link recoverAllStagedOrphans}.
 * The pass is serial stat+mkdir+rename per segment over what is usually a
 * network/FUSE share (shfs): measured on the live hub at 40 454 ms for 46
 * files in 28 dirs — ~880 ms per file of pure round-trip latency, nothing
 * CPU-bound (2026-08-15). Dirs are independent by construction (each relocate
 * is a same-fs rename of a distinct file), so lanes are free; WITHIN a dir the
 * pass stays serial so the shutdown guard still stops after at most one
 * in-flight relocate per lane.
 */
const STAGING_BOOT_DIR_CONCURRENCY = 4

/**
 * Boot reconcile: relocate every previous-run segment stranded in staging, on
 * every location, for every camera — attached or not.
 *
 * WHY BOOT, AND NOT ATTACH
 * ────────────────────────
 * Orphans are created by a writer restart, so by construction they all predate
 * the runner that finds them; boot is when the whole backlog is visible at
 * once. Attach looked like the natural hook and is the wrong one twice over: it
 * only ever reaches cameras that are currently recording (device 1438 had a
 * staging backlog while attached to nothing), and it puts unbounded filesystem
 * work on the path that must start recording NOW — measured, it kept microtasks
 * in flight across `RecordingController.stop()` and made the runner's 5 s
 * SIGTERM-grace test fail under load.
 *
 * `bootMs` is the cutoff, and it is what makes this safe to run while writers
 * are spawning: a live writer's segments are all named after boot, so the plan
 * cannot select one. Nothing is deleted, and a segment that cannot be placed is
 * left exactly where it is for the next boot.
 */
export async function recoverAllStagedOrphans(deps: StagingBootDeps): Promise<StagingBootReport> {
  let dirs = 0
  let found = 0
  let recovered = 0
  let failed = 0
  let aborted = false
  const startedMs = Date.now()

  // The pass yields through this unless a test injects its own hop, so a
  // contended loop slows the RECOVERY down rather than the live write path.
  const injectedYield = deps.yieldBetween
  const pacer = injectedYield === undefined ? nodeLoopPacer() : null
  const yieldBetween =
    injectedYield ?? ((): Promise<void> => (pacer === null ? macrotask() : pacer.hop()))

  const locations = deps.locations()
  deps.logger.info('recorder: staging boot reconcile starting', {
    meta: { locations: locations.map((l) => l.id), bootMs: deps.bootMs },
  })

  /**
   * One directory listing on the walk, paced through the pass's own pacer.
   *
   * "A handful of listings" is what this walk was costed as, and on a WARM
   * share it is — 4.1 s for the whole thing. Cold, after a power-cycle, each
   * one is a ~9.4 s FUSE round-trip and 58 of them summed to 547 s with the
   * loop to themselves, while the controller re-pinned writers 118 times and
   * the first recording landed at t+714 s.
   *
   * Paced per LISTING and not per entry, because that is where the latency
   * is; and through the SAME `yieldBetween` the recovery uses, so there is one
   * pacer, one back-off state and one set of counters for the whole pass —
   * never a second scheduling authority (D167).
   */
  const listPaced = async (dir: string): Promise<readonly string[] | null> => {
    let entries: readonly string[] | null = null
    try {
      entries = await deps.listDir(dir)
    } catch {
      // No staging on this location/device — the normal case for a fresh root.
      // Not a failure, and nothing to say about it. The read still cost a
      // round-trip, so it is still paced.
      entries = null
    }
    await yieldBetween()
    return entries
  }

  // Walk first, recover second: the walk is the directory listings, the
  // recovery is the per-segment work the lanes below overlap.
  const walkStartedMs = Date.now()
  const segmentSecondsMap = await deps.segmentSecondsByDevice()
  const work: StagingDirWork[] = []
  for (const location of locations) {
    const stagingRoot = `${location.root}/${STAGING_DIR_NAME}`
    const deviceDirs = await listPaced(stagingRoot)
    if (deviceDirs === null) continue

    for (const deviceDir of deviceDirs) {
      const deviceId = Number(deviceDir)
      if (!Number.isInteger(deviceId) || deviceId <= 0) continue

      const profileDirs = await listPaced(`${stagingRoot}/${deviceDir}`)
      if (profileDirs === null) continue
      const segmentSeconds = segmentSecondsMap.get(deviceId) ?? deps.defaultSegmentSeconds

      for (const profile of profileDirs) {
        if (!KNOWN_PROFILES.has(profile)) continue
        work.push({
          location,
          deviceId,
          profile,
          dir: `${stagingRoot}/${deviceDir}/${profile}`,
          segmentSeconds,
        })
      }
    }
  }
  const walkMs = Date.now() - walkStartedMs

  const queue = [...work]
  const lane = async (): Promise<void> => {
    for (;;) {
      if (aborted || deps.shouldStop?.() === true) return
      const item = queue.shift()
      if (item === undefined) return
      dirs += 1
      const report = await recoverStagingOrphans(
        item.dir,
        { writerStartedMs: deps.bootMs, segmentSeconds: item.segmentSeconds },
        {
          listDir: deps.listDir,
          readPlaylist: deps.readPlaylist,
          finalize: (orphan, flatAbsPath) =>
            deps.finalize({
              deviceId: item.deviceId,
              profile: item.profile,
              locationId: item.location.id,
              locationRoot: item.location.root,
              flatAbsPath,
              startMs: orphan.startMs,
              durMs: orphan.durMs,
            }),
          // Device-scoped so every line carries `tags: { deviceId }` — a
          // recovery miss is asked per-camera like everything else here.
          logger: withDeviceTag(deps.logger, item.deviceId),
          chunkSize: deps.chunkSize,
          yieldBetween,
          shouldStop: deps.shouldStop,
        },
      )
      found += report.found
      recovered += report.recovered
      failed += report.failed
      if (report.aborted) aborted = true
    }
  }
  const lanes = Math.min(STAGING_BOOT_DIR_CONCURRENCY, Math.max(1, queue.length))
  await Promise.all(Array.from({ length: lanes }, lane))

  // ALWAYS, including the nothing-to-do case: "the pass ran and found zero" and
  // "the pass never got there" are different answers and only one of them is
  // reassuring. The pacer counters say whether the pass was standing back for
  // the live write path or had the loop to itself — they count the WALK too,
  // so `hops: 0` next to a six-figure `ms` can no longer read as "idle loop".
  // `walkMs` splits the total, because cold the walk IS the total.
  deps.logger.info('recorder: staging boot reconcile complete', {
    meta: {
      dirs,
      found,
      recovered,
      failed,
      aborted,
      ms: Date.now() - startedMs,
      walkMs,
      ...(pacer === null ? {} : { pacing: pacer.stats() }),
    },
  })
  return { dirs, found, recovered, failed, aborted }
}

/** Bind `tags: { deviceId }` onto every line a per-dir pass writes. */
function withDeviceTag(logger: StagingRecoveryLogger, deviceId: number): StagingRecoveryLogger {
  const tag = (extras?: unknown): Record<string, unknown> => ({
    ...(typeof extras === 'object' && extras !== null ? extras : {}),
    tags: { deviceId },
  })
  return {
    info: (message, extras) => logger.info(message, tag(extras)),
    warn: (message, extras) => logger.warn(message, tag(extras)),
    debug: (message, extras) => logger.debug(message, tag(extras)),
  }
}
