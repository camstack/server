/**
 * The last good frame per camera, on disk, so it outlives the process.
 *
 * ## Why
 *
 * The snapshot cache is RAM-only and says so: *"after a hub restart this
 * legitimately answers nothing and the generated card is the picture"*. That is
 * accurate and it is also the whole defect, because the cameras that most need
 * a cached frame are the ones that can never be asked for a fresh one. A
 * sleeping battery camera refuses every snapshot that does not carry `force`,
 * and the sentry deliberately never passes it — forcing would wake the very
 * camera the window exists so as not to disturb.
 *
 * Measured 2026-09-17: the baby monitor showed the courtesy card all morning.
 * Nothing was broken. Three server updates had emptied the cache, and the
 * camera had been asleep since.
 *
 * ## Shape
 *
 * One file per device under the addon's OWN private directory (`ctx.dataDir` —
 * `<nodeDataDir>/addons-data/<addonId>`, which the addon owns exclusively), and
 * it is overwritten rather than appended: what is wanted is A recent frame, not
 * a history. A history here would grow without a reaper and compete with the
 * recordings for the same disk.
 *
 * Writes are THROTTLED per device. Snapshots are captured far more often than a
 * process restarts, and persisting every one buys nothing — one recent frame is
 * the entire value.
 *
 * Nothing here throws. The caller already has its picture; persistence is a
 * bonus for the NEXT boot, and a disk that refuses must never cost a snapshot
 * that succeeded. A frame that cannot be read is reported ABSENT, never as an
 * error and never as an empty buffer — absent is the truth and the courtesy
 * card is the correct answer to it.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** One recent frame is the value; a newer one is not worth the disk. */
const DEFAULT_MIN_INTERVAL_MS = 60_000

/** Its own subdirectory, so the addon's other state is never mistaken for a frame. */
const SUBDIR = 'last-frame'

/** Monotonic within the process; with the pid it makes a staging name unique. */
let stagingSeq = 0
function nextStagingId(): number {
  stagingSeq += 1
  return stagingSeq
}

export interface SnapshotDurableStoreOptions {
  /** `ctx.dataDir` — the addon's exclusive directory. */
  readonly dataDir: string
  readonly minIntervalMs?: number
  /** Injectable for tests; `Date.now` otherwise. */
  readonly now?: () => number
  /** Where a refused write is reported. Absent only in unit tests. */
  readonly logger?: IScopedLogger
}

export class SnapshotDurableStore {
  private readonly dir: string
  private readonly minIntervalMs: number
  private readonly now: () => number
  private readonly logger: IScopedLogger | undefined
  /** Last write per device, so the throttle survives without touching disk. */
  private readonly lastWriteMs = new Map<number, number>()

  constructor(options: SnapshotDurableStoreOptions) {
    this.dir = join(options.dataDir, SUBDIR)
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  /** @returns whether the frame was written. `false` is throttled or refused. */
  async put(deviceId: number, jpeg: Buffer): Promise<boolean> {
    if (jpeg.length === 0) return false
    const at = this.now()
    const previous = this.lastWriteMs.get(deviceId)
    if (previous !== undefined && at - previous < this.minIntervalMs) return false
    try {
      await fs.mkdir(this.dir, { recursive: true })
      // Written beside and renamed: a reader at the wrong moment must find the
      // old frame whole, never a half-written one.
      const target = this.pathFor(deviceId)
      // The staging name is unique per writer. It used to be `<id>.jpg.writing`
      // — one name shared by every writer of that device — and the addon
      // writes fire-and-forget, so two captures of one camera overlap
      // routinely: the loser renamed a file the winner had already moved, got
      // ENOENT, and dropped the frame under a bare `catch`.
      const staging = `${target}.${String(process.pid)}.${String(nextStagingId())}.writing`
      try {
        await fs.writeFile(staging, jpeg)
        await fs.rename(staging, target)
      } catch (err) {
        await fs.rm(staging, { force: true }).catch(() => undefined)
        throw err
      }
      this.lastWriteMs.set(deviceId, at)
      return true
    } catch (err) {
      // A disk that refuses to keep the last frame is exactly the condition
      // this store exists to survive, and it must not be invisible.
      this.logger?.warn('durable last-frame write failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return false
    }
  }

  /** The frame from a previous process, or `null` — which is a real answer. */
  async get(deviceId: number): Promise<Buffer | null> {
    return (await this.getDated(deviceId))?.jpeg ?? null
  }

  /**
   * The frame WITH the moment it was captured.
   *
   * The age travels with it because everything downstream decides on age, and
   * a frame restored from disk that claims to be new is worse than no frame:
   * it would satisfy a freshness gate it has no right to pass. The file's own
   * mtime is the honest answer — it is when this frame was written.
   */
  async getDated(deviceId: number): Promise<{ jpeg: Buffer; capturedAtMs: number } | null> {
    try {
      const path = this.pathFor(deviceId)
      const [jpeg, stat] = await Promise.all([fs.readFile(path), fs.stat(path)])
      if (jpeg.length === 0) return null
      return { jpeg, capturedAtMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  private pathFor(deviceId: number): string {
    return join(this.dir, `${String(deviceId)}.jpg`)
  }
}
