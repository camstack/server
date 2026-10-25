/**
 * Re-pointing a SINGLE location, as one guarded operation.
 *
 * ## What went wrong (2026-10-20, ~8.6k event-media files lost)
 *
 * `homekitClips:default` shared `/recordings/recordings` with
 * `eventMedia:default`. Repointing it ran a tree move over the WHOLE shared root
 * and deleted the originals — every camera's `<cam>/events` included — while a
 * `pipelineAnalytics.relocateMedia` job of the other location was moving the very
 * same files. Nothing arbitrated between the two writers of one disk.
 *
 * ## The two rules
 *
 * 1. **Scope** — a repoint copies and deletes only its class's own subtree
 *    ({@link classifyPath}, D327). A foreign file is never even read.
 * 2. **One claim per physical root, owned here.** A repoint holds a claim on the
 *    realpath of the root it reads and the root it writes. It starts only when no
 *    mover (`relocateMedia`, `relocateFootage`, a migration drain) touches an
 *    overlapping root, and a mover asks {@link clearance} before it runs and
 *    refuses while a repoint holds the root. No timers and no retries (D3): the
 *    answer is "now" and a refusal is typed.
 *
 * ## Why it cannot race
 *
 * Both sides ANNOUNCE first, then look: the repoint takes its claim and then
 * lists the movers; a mover registers its job (so it appears in the list) and
 * then asks {@link clearance}. Whichever announces second sees the other. The
 * mover list is read fail-CLOSED here: this is the destructive side, and an
 * unreadable list is not "no movers" (the opposite of D49's rule for a one-shot
 * event, which this is not — a refusal costs the operator one retry).
 *
 * The claim is in memory and dies with the process. A crash in the middle of a
 * repoint leaves the bytes in the old root or a verified copy in the new one (see
 * `location-repoint-move.ts`), never a stale lock.
 */
import type { IScopedLogger, StorageLocation, StorageMigrationMover } from '@camstack/types'
import { classifyPath } from './location-class-paths.js'
import {
  moveLocationTree,
  type RepointMoveIo,
  type RepointMoveResult,
} from './location-repoint-move.js'

/** Why a repoint, or a mover, was turned away. Typed so callers can branch. */
export type RepointRefusalReason = 'mover-active' | 'repoint-active' | 'movers-unreadable'

export class RepointRefusedError extends Error {
  override readonly name = 'RepointRefusedError'
  constructor(
    readonly reason: RepointRefusalReason,
    message: string,
  ) {
    super(message)
  }
}

/** The answer a mover gets before it touches a root. */
export type RootClearance =
  | { readonly clear: true }
  | {
      readonly clear: false
      readonly reason: 'repoint-active'
      /** The location whose repoint holds the root. */
      readonly repointLocationId: string
    }

/** The row fields a repoint reads — `next` is the incoming upsert, not a stored row. */
export interface RepointTarget {
  readonly id: string
  readonly type: string
  readonly config: Readonly<Record<string, unknown>>
}

export interface LocationRepointerDeps {
  readonly logger: IScopedLogger
  /** The physical key of a path (realpath, or the resolved path when it does not exist yet). */
  readonly resolveKey: (basePath: string) => Promise<string>
  /** The CURRENT basePath of a stored location, or null when it has none / is unknown. */
  readonly locationBasePath: (locationId: string) => string | null
  readonly locationIdsOfType: (type: string) => readonly string[]
  /** Every mover in both lanes. A throw refuses the repoint. */
  readonly listMovers: () => Promise<readonly StorageMigrationMover[]>
  /** I/O over the source (stored) and destination (next) roots. */
  readonly ioFor: (stored: StorageLocation, next: RepointTarget) => Promise<RepointMoveIo>
}

interface Claim {
  readonly locationId: string
  readonly keys: readonly string[]
}

/** Does `a` equal `b`, or sit inside it, or contain it? Segment-wise, never by raw prefix. */
export function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const within = (inner: string, outer: string): boolean =>
    inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
  return within(a, b) || within(b, a)
}

function basePathOf(config: Readonly<Record<string, unknown>>): string | null {
  const raw = config['basePath']
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

export class LocationRepointer {
  private readonly claims = new Set<Claim>()

  constructor(private readonly deps: LocationRepointerDeps) {}

  /**
   * Move `stored`'s own subtree to `next`'s root, then run `commit` (the row
   * save) while the claim is still held. Throws {@link RepointRefusedError}
   * with NOTHING copied or deleted when a mover is on the root.
   */
  async run<T>(
    stored: StorageLocation,
    next: RepointTarget,
    commit: () => T | Promise<T>,
  ): Promise<T> {
    const claim = await this.claim(stored, next)
    try {
      await this.refuseWhileMovers(claim, stored)
      const io = await this.deps.ioFor(stored, next)
      const moved = await moveLocationTree(io, (path) => classifyPath(stored.type, path))
      this.logMoved(stored, next, moved)
      return await commit()
    } finally {
      this.claims.delete(claim)
    }
  }

  /**
   * May a mover that touches `locationIds` run? Refuses while a repoint holds
   * an overlapping root. Called by the owning addon AFTER its job is
   * registered, so the repoint's mover listing and this check cannot both miss.
   */
  async clearance(locationIds: readonly string[]): Promise<RootClearance> {
    const keys = await this.keysOf(locationIds)
    for (const claim of this.claims) {
      if (claim.keys.some((held) => keys.some((key) => rootsOverlap(held, key)))) {
        return {
          clear: false,
          reason: 'repoint-active',
          repointLocationId: claim.locationId,
        }
      }
    }
    return { clear: true }
  }

  private async claim(stored: StorageLocation, next: RepointTarget): Promise<Claim> {
    const paths = [basePathOf(stored.config), basePathOf(next.config)].filter(
      (path): path is string => path !== null,
    )
    const keys = await Promise.all(paths.map((path) => this.deps.resolveKey(path)))
    for (const other of this.claims) {
      if (other.keys.some((held) => keys.some((key) => rootsOverlap(held, key)))) {
        this.refuse(
          stored,
          'repoint-active',
          `a repoint of "${other.locationId}" holds the same root`,
        )
      }
    }
    const claim: Claim = { locationId: stored.id, keys }
    this.claims.add(claim)
    return claim
  }

  private async refuseWhileMovers(claim: Claim, stored: StorageLocation): Promise<void> {
    let movers: readonly StorageMigrationMover[]
    try {
      movers = await this.deps.listMovers()
    } catch (err: unknown) {
      this.claims.delete(claim)
      this.refuse(
        stored,
        'movers-unreadable',
        `the active movers could not be listed (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    for (const mover of movers) {
      if (mover.job.state !== 'queued' && mover.job.state !== 'running') continue
      const touched = await this.keysOf(this.locationsTouchedBy(mover))
      if (claim.keys.some((held) => touched.some((key) => rootsOverlap(held, key)))) {
        this.claims.delete(claim)
        this.refuse(
          stored,
          'mover-active',
          `${mover.lane} mover ${mover.job.jobId} (${mover.job.fromLocationId} -> ` +
            `${mover.job.toLocationId}) touches the same physical root`,
          { jobId: mover.job.jobId, lane: mover.lane },
        )
      }
    }
  }

  private locationsTouchedBy(mover: StorageMigrationMover): readonly string[] {
    return [mover.job.fromLocationId, mover.job.toLocationId]
  }

  /** `*` is the media mover's "from wherever the rows are": every eventMedia location. */
  private async keysOf(locationIds: readonly string[]): Promise<readonly string[]> {
    const expanded = locationIds.flatMap((id) =>
      id === '*' ? this.deps.locationIdsOfType('eventMedia') : [id],
    )
    const paths = expanded
      .map((id) => this.deps.locationBasePath(id))
      .filter((path): path is string => path !== null)
    return Promise.all(paths.map((path) => this.deps.resolveKey(path)))
  }

  private refuse(
    stored: StorageLocation,
    reason: RepointRefusalReason,
    detail: string,
    meta: Readonly<Record<string, unknown>> = {},
  ): never {
    this.deps.logger.warn(
      'storage-orchestrator: REFUSING to re-point a location — nothing was moved',
      {
        meta: { id: stored.id, type: stored.type, reason, detail, ...meta },
      },
    )
    throw new RepointRefusedError(
      reason,
      `re-point of "${stored.id}" refused (${reason}): ${detail}`,
    )
  }

  private logMoved(stored: StorageLocation, next: RepointTarget, moved: RepointMoveResult): void {
    this.deps.logger.info(
      'storage-orchestrator: singleton location re-pointed — its data was carried over',
      {
        meta: {
          id: stored.id,
          type: stored.type,
          from: basePathOf(stored.config),
          to: basePathOf(next.config),
          ...moved,
        },
      },
    )
  }
}
