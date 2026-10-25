/**
 * The last COMPOSED frame per grid, on disk, so it outlives the process.
 *
 * ## Why not `@camstack/system`'s SnapshotDurableStore
 *
 * Because the shape is right and the reach is not: that class lives under
 * `builtins/snapshot/` and `@camstack/system` does not export it — a builtin's
 * internals are not an addon-facing module, and an addon that reached into one
 * would be importing another addon, which this repo forbids outright. What is
 * shared is the REASONING, and it is worth restating rather than linking,
 * because the failure it prevents here is the same one measured on 2026-09-17:
 * the cache is RAM, three server updates emptied it, and a camera that cannot
 * be asked for a fresh frame showed the courtesy card all morning with nothing
 * broken.
 *
 * A grid is that camera by construction. It has no fresh frame whenever nobody
 * is watching it, which is most of the time and is the entire point of D519.
 *
 * ## Shape
 *
 * One file per device under `ctx.dataDir` — `<nodeDataDir>/addons-data/
 * camera-grid`, which this addon owns exclusively — overwritten rather than
 * appended: what is wanted is A recent frame, not a history. A history here
 * would grow without a reaper and compete with the recordings for the disk.
 *
 * Writes are THROTTLED. A composition emits 10 frames a second and a process
 * restarts a few times a week; persisting every frame buys nothing and costs a
 * write per frame.
 *
 * NOTHING here throws. The caller already has its picture; persistence is a
 * bonus for the NEXT boot, and a disk that refuses must never cost a snapshot
 * that succeeded. A frame that cannot be read is reported ABSENT — absent is
 * the truth, and the courtesy card is the correct answer to it.
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { errMsg } from '@camstack/types'
import type { GridLastFrameStore } from './grid-snapshot.js'
import type { GridStreamLogger } from './grid-stream-session.js'

/** One recent frame is the value; a newer one is not worth the disk. */
const DEFAULT_MIN_INTERVAL_MS = 60_000

/** Its own subdirectory, so the addon's other state is never mistaken for a frame. */
const SUBDIR = 'last-frame'

/**
 * How long the caller may be made to wait on the disk, for ANY of it.
 *
 * A bonus that costs a snapshot is not a bonus. One second is far more than a
 * healthy local write needs and far less than a viewer will sit through.
 */
const DEFAULT_DEADLINE_MS = 1_000

/**
 * Exactly the filesystem this store touches, so a caller can hand it a
 * different one and a spec can hand it a broken one.
 *
 * The four calls are `node:fs/promises`' own shapes, narrowed to the single
 * overload used here — that is what makes `promises` assignable to it with no
 * cast.
 */
export interface GridFrameFs {
  mkdir(dir: string, options: { readonly recursive: true }): Promise<string | undefined>
  writeFile(path: string, data: Buffer): Promise<void>
  rename(from: string, to: string): Promise<void>
  readFile(path: string): Promise<Buffer>
}

/** Whether one piece of disk work answered before its deadline, and with what. */
type DiskOutcome<T> = { readonly settled: true; readonly value: T } | { readonly settled: false }

export interface GridLastFrameFileStoreOptions {
  /** `ctx.dataDir` — the addon's exclusive directory. */
  readonly dataDir: string
  /** Where a dropped frame is named. A silent drop reads as "never happened". */
  readonly logger: GridStreamLogger
  readonly minIntervalMs?: number
  /** Injectable for tests; `Date.now` otherwise. */
  readonly now?: () => number
  /** Injectable for tests; `node:fs/promises` otherwise. */
  readonly fs?: GridFrameFs
  /** The bound on how long the caller waits on the disk. */
  readonly deadlineMs?: number
}

export class GridLastFrameFileStore implements GridLastFrameStore {
  private readonly dir: string
  private readonly minIntervalMs: number
  private readonly now: () => number
  private readonly fs: GridFrameFs
  private readonly deadlineMs: number
  private readonly logger: GridStreamLogger
  /** Last write per device, so the throttle survives without touching disk. */
  private readonly lastWriteMs = new Map<number, number>()

  constructor(options: GridLastFrameFileStoreOptions) {
    this.dir = join(options.dataDir, SUBDIR)
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
    this.fs = options.fs ?? nodeFs
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
    this.logger = options.logger
  }

  async put(deviceId: number, jpeg: Buffer): Promise<void> {
    if (jpeg.length === 0) return
    const at = this.now()
    const previous = this.lastWriteMs.get(deviceId)
    if (previous !== undefined && at - previous < this.minIntervalMs) return
    const kept = await this.bounded(deviceId, 'keep the composed frame', false, async () => {
      await this.fs.mkdir(this.dir, { recursive: true })
      // Written beside and renamed: a reader at the wrong moment must find the
      // old frame whole, never a half-written one.
      const target = this.pathFor(deviceId)
      const staging = `${target}.writing`
      await this.fs.writeFile(staging, jpeg)
      await this.fs.rename(staging, target)
      return true
    })
    if (kept) this.lastWriteMs.set(deviceId, at)
  }

  async get(deviceId: number): Promise<Buffer | null> {
    return this.bounded(deviceId, 'read the kept frame', null, async () => {
      const jpeg = await this.fs.readFile(this.pathFor(deviceId))
      return jpeg.length > 0 ? jpeg : null
    })
  }

  /**
   * Run one piece of disk work, and answer `fallback` whether it REFUSES or
   * never answers at all.
   *
   * The `try/catch` this replaces covered only the first of those. Measured on
   * the CI runner (Linux, root, in a container) 2026-09-20: `fs.mkdir` with
   * `recursive: true` under a parent that cannot hold a directory never
   * settles — procfs answers ENOENT and Node's recursive mkdir retries the
   * child forever — and `put` is AWAITED on the snapshot answer path, so the
   * grid's snapshot RPC never answered either. An exception is not the only
   * way the disk says no.
   */
  private async bounded<T>(
    deviceId: number,
    what: string,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    const expiry = new Promise<DiskOutcome<T>>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), this.deadlineMs)
      timer.unref()
    })
    try {
      const outcome = await Promise.race<DiskOutcome<T>>([
        work().then((value) => ({ settled: true, value })),
        expiry,
      ])
      if (!outcome.settled) {
        this.logger.warn(`camera grid: the disk did not ${what} within its deadline`, {
          tags: { deviceId },
          meta: { deadlineMs: this.deadlineMs },
        })
        return fallback
      }
      return outcome.value
    } catch (error) {
      // Persistence is a bonus for the next boot — never an error for this one,
      // and never silent either.
      this.logger.warn(`camera grid: the disk could not ${what}`, {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
      return fallback
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  private pathFor(deviceId: number): string {
    return join(this.dir, `${String(deviceId)}.jpg`)
  }
}
