/**
 * The one sequence that turns an L2 decision into one track everywhere
 * (D683 §6.2). The rows are checked FIRST (review H3): nothing is touched for
 * a fusion that cannot complete. RAM next and synchronously — the frame that
 * surfaced the fusion upserts onto the survivor right after, so every RAM step
 * has run by the time `fuse` RETURNS its promise (no `await` precedes them).
 * Then the durable re-point, on a per-device serial queue, so the frame path
 * never waits on storage and two fusions of one camera never interleave.
 *
 * Which rows may fuse (a fusion never touches a closed track, review H4):
 *
 *  | survivor row      | absorbed row      | outcome                                    |
 *  | ----------------- | ----------------- | ------------------------------------------ |
 *  | closed / closing  | any               | refused; the tracker drops the chain       |
 *  | none              | active            | refused; the tracker drops the chain       |
 *  | active / none     | closed / closing  | refused; the chain is kept (an extra id)   |
 *  | active            | active            | full fusion, with the absorbed `end`       |
 *  | active / none     | none              | RAM + durable re-point, no `end`, no row   |
 *
 * "None" is a piece whose birth has not run (deferred by the gate): it never
 * had a `start`, so it gets no `end`; a provisional id may still own events or
 * media, and both durable steps are idempotent and cost nothing when empty.
 * A refused chain re-appears under a new id with a row of its own — extra ids
 * are preferred over mix-ups (operator decision, D683).
 */
import type { IScopedLogger } from '@camstack/types'
import type { TrackFusion } from './tracker-v2/index.js'
import {
  type FusionLeafReport,
  fuseTrackLeaves,
  type TrackFusibleStore,
  type TrackFusionLeafCount,
  type TrackFusionMediaPort,
} from './track-fusion-leaf.js'

export type BestShotSide = 'survivor' | 'absorbed'

/** A row as the fusion sees it. `closing` = `expireStale` is persisting it. */
export type FusionRowState = 'active' | 'closing' | 'closed' | 'none'

export type FusionRefusalReason = 'survivor-closed' | 'survivor-no-row' | 'absorbed-closed'

/** The survivor's per-track RAM state (`TrackResidentState`). */
export interface FusionResidentsPort {
  adopt(survivorId: string, absorbedId: string): FusionAdoptOutcome
  /** The survivor's best-shot media ids as its resident state holds them NOW (review 2 M2). */
  bestShotMediaIds(survivorId: string): ReadonlySet<number>
  /** The id whose CAPTURED best shot is current for the survivor (itself, or
   *  a piece it absorbed) — the sweep-up ranks every single-instance kind by
   *  this, never by the fusion-time verdict, which may be stale by close. */
  bestShotHolder(survivorId: string): string
}

export interface FusionAdoptOutcome {
  readonly bestShotFrom: BestShotSide
}

export interface FusionRecognizersPort {
  adoptFace(deviceId: number, survivorId: string, absorbedId: string): void
  adoptPlate(deviceId: number, survivorId: string, absorbedId: string): void
}

/** Detail dispatcher, overlay, active-id sets: forget the absorbed id. */
export interface FusionLiveStatePort {
  forget(deviceId: number, key: string, absorbedId: string): void
}

/** `phase: 'end'` for the absorbed id with `fusedIntoTrackId` — read its row BEFORE the merge. */
export interface FusionLifecyclePort {
  emitFusedEnd(deviceId: number, absorbedId: string, survivorId: string): void
  /**
   * D692: every RAM step of a NON-refused fusion has run — the notification centre
   * merges or re-keys a grouped-window member. Called with or without a row merge.
   */
  fused(deviceId: number, survivorId: string, absorbedId: string): void
}

/**
 * The track store — also the ONE registry of which ids a survivor absorbed
 * (`TrackStore.members`, fix round 1 M2): `adopt` records a merged row, and
 * `noteMember` records a piece that had no row to merge. Every close path the
 * store has (TTL, discard, operator delete, promotion drop, device clear)
 * already cleans it, so nothing here can outlive its survivor.
 */
export interface FusionTrackStorePort {
  rowState(trackId: string): FusionRowState
  adopt(survivorId: string, absorbedId: string): boolean
  noteMember(deviceId: number, survivorId: string, absorbedId: string): void
  membersOf(survivorId: string): readonly string[]
}

export interface FusionAliasPort {
  record(deviceId: number, aliasId: string, trackId: string, fusedAt: number): Promise<void>
}

export interface TrackFusionServiceDeps {
  readonly logger: IScopedLogger
  readonly residents: FusionResidentsPort
  /** Review 2 M6: a refused fusion — L2 already emits the survivor's id for the
   *  absorbed piece's frames; without this, the next upsert would re-create an
   *  active row for a closed id. The processor drops the chain instead. */
  readonly onRefused: (deviceId: number, key: string, fusion: TrackFusion) => void
  readonly recognizers: FusionRecognizersPort
  readonly liveState: FusionLiveStatePort
  readonly lifecycle: FusionLifecyclePort
  readonly trackStore: FusionTrackStorePort
  readonly aliases: FusionAliasPort
  readonly leaves: () => readonly TrackFusibleStore[]
  readonly media: TrackFusionMediaPort
  /** Clock for the refusal sampler; defaults to `Date.now`. */
  readonly now?: () => number
}

/** One refusal line per camera per window; the rest are counted onto the next line. */
const FUSION_REFUSAL_LOG_WINDOW_MS = 60_000
/**
 * How long a survivor's close waits for its sweep-up (fix round 1 M3). The
 * closer is ONE sweep for every camera: a slow vector store or blob relocate
 * must not hold every other track's close. Past this the close goes on (WARN);
 * the re-point still finishes on the camera's queue, and the members are
 * closed to late writers with the survivor either way.
 */
export const SWEEP_UP_WAIT_MS = 10_000

interface RefusalWindow {
  readonly at: number
  readonly suppressed: number
}

export class TrackFusionService {
  private readonly queues = new Map<number, Promise<void>>()
  private readonly refusals = new Map<number, RefusalWindow>()
  private readonly now: () => number

  constructor(private readonly deps: TrackFusionServiceDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Apply one fusion. Every RAM step has run when this returns; the durable
   * re-point is queued (`settled(deviceId)` awaits it). Never throws for a
   * refusal — a refused fusion is logged (sampled) and handed to `onRefused`.
   */
  async fuse(deviceId: number, key: string, fusion: TrackFusion): Promise<void> {
    const { survivorId, absorbedId } = fusion
    const survivorRow = this.deps.trackStore.rowState(survivorId)
    const absorbedRow = this.deps.trackStore.rowState(absorbedId)
    const refusal = refusalOf(survivorRow, absorbedRow)
    if (refusal !== undefined) {
      this.logRefusal(deviceId, fusion, refusal, survivorRow, absorbedRow)
      // An absorbed piece that already closed is history: the survivor's chain
      // is live and owns its row — only a survivor that cannot take the merge
      // ends the chain.
      if (refusal !== 'absorbed-closed') this.deps.onRefused(deviceId, key, fusion)
      return
    }
    const absorbedHadRow = absorbedRow === 'active'
    // Review L3: each RAM step is isolated — one that throws is a WARN and the
    // rest (the row merge above all) still run, never a half-fused state.
    const ram = (step: string, run: () => void): void => {
      try {
        run()
      } catch (err) {
        this.deps.logger.warn('track fusion: a RAM step failed — the fusion continues', {
          tags: { deviceId },
          meta: { step, survivorId, absorbedId, error: String(err) },
        })
      }
    }
    let bestShotFrom: BestShotSide = 'survivor'
    ram('residents', () => {
      bestShotFrom = this.deps.residents.adopt(survivorId, absorbedId).bestShotFrom
    })
    ram('face', () => this.deps.recognizers.adoptFace(deviceId, survivorId, absorbedId))
    ram('plate', () => this.deps.recognizers.adoptPlate(deviceId, survivorId, absorbedId))
    ram('live-state', () => this.deps.liveState.forget(deviceId, key, absorbedId))
    let rowMerged = false
    if (absorbedHadRow && survivorRow === 'active') {
      ram('lifecycle', () => this.deps.lifecycle.emitFusedEnd(deviceId, absorbedId, survivorId))
      rowMerged = this.deps.trackStore.adopt(survivorId, absorbedId)
      if (!rowMerged) {
        // Unreachable while the row check above runs in the same tick (carry
        // 5) — the store's own guard is the backstop, and a backstop that fires
        // is never silent.
        this.deps.logger.warn('track fusion: the row merge was refused by the store', {
          tags: { deviceId },
          meta: { survivorId, absorbedId },
        })
      }
    }
    // A piece with no row to merge is still a member: the survivor's close
    // sweeps it up and closes it to late writers (review M2, L1).
    if (!rowMerged) this.deps.trackStore.noteMember(deviceId, survivorId, absorbedId)
    // The notification centre's grouped windows (D692) — after the identity and row
    // steps, so a survivor's merged label is what the NC reads next.
    ram('nc', () => this.deps.lifecycle.fused(deviceId, survivorId, absorbedId))
    const fusedBestShot = bestShotFrom
    this.enqueue(deviceId, async () => {
      const aliasError = await this.recordAlias(deviceId, absorbedId, survivorId, fusion.t)
      const report = await this.repoint(deviceId, survivorId, absorbedId, fusedBestShot)
      this.deps.logger.info('track fused', {
        tags: { deviceId },
        meta: {
          key,
          survivorId,
          absorbedId,
          members: fusion.members,
          t: fusion.t,
          gapMs: fusion.gapMs,
          cost: Number(fusion.cost.toFixed(3)),
          bestShotFrom: fusedBestShot,
          absorbedHadRow,
          survivorHadRow: survivorRow === 'active',
          rowMerged,
          ...tally(report.counts),
          counts: report.counts,
          failures: report.failures,
          ...(aliasError !== undefined ? { aliasError } : {}),
        },
      })
    })
  }

  /**
   * Before the survivor's row is persisted: re-run the leaves for every piece
   * it absorbed, so writes that landed under an absorbed id AFTER the fusion
   * (a queued capture, a detail result, the embedding pass) move too (review
   * H4). From the survivor's close on, the store refuses them (`rowClosedAt`).
   *
   * Waits at most {@link SWEEP_UP_WAIT_MS} for the camera's queue (review M3):
   * the caller is the one closer sweep for every camera.
   */
  async sweepUp(deviceId: number, survivorId: string): Promise<void> {
    const members = this.deps.trackStore.membersOf(survivorId)
    if (members.length === 0) return
    // Review 2 M2: the ranking decided at fusion time may be stale by close —
    // the survivor's CURRENT best shot is pinned, and every single-instance
    // kind follows whoever holds that shot NOW.
    const keepMediaIds = this.deps.residents.bestShotMediaIds(survivorId)
    const holder = this.deps.residents.bestShotHolder(survivorId)
    this.enqueue(deviceId, async () => {
      const reports: FusionLeafReport[] = []
      for (const absorbedId of members) {
        const side: BestShotSide = holder === absorbedId ? 'absorbed' : 'survivor'
        reports.push(await this.repoint(deviceId, survivorId, absorbedId, side, keepMediaIds))
      }
      const counts = reports.flatMap((r) => r.counts)
      this.deps.logger.info('track fusion swept up', {
        tags: { deviceId },
        meta: {
          survivorId,
          members,
          bestShotHolder: holder,
          ...tally(counts),
          counts,
          failures: reports.flatMap((r) => r.failures),
        },
      })
    })
    const startedAt = this.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SWEEP_UP_WAIT_MS)
    })
    const outcome = await Promise.race([
      this.settled(deviceId).then(() => 'settled' as const),
      deadline,
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      this.deps.logger.warn(
        'track fusion sweep-up still running — the survivor closes without waiting for it',
        {
          tags: { deviceId },
          meta: { survivorId, members, waitedMs: this.now() - startedAt },
        },
      )
    }
  }

  settled(deviceId: number): Promise<void> {
    return this.queues.get(deviceId) ?? Promise.resolve()
  }

  /** Every device's queue — awaited on addon stop, before the stores close. */
  async settledAll(): Promise<void> {
    await Promise.all([...this.queues.values()])
  }

  /** The alias row, isolated: a failure is REPORTED on the fusion's line and
   *  the leaves still run — a missing alias costs a lookup, never a re-point. */
  private async recordAlias(
    deviceId: number,
    absorbedId: string,
    survivorId: string,
    fusedAt: number,
  ): Promise<string | undefined> {
    try {
      await this.deps.aliases.record(deviceId, absorbedId, survivorId, fusedAt)
      return undefined
    } catch (err) {
      return String(err)
    }
  }

  private repoint(
    deviceId: number,
    survivorId: string,
    absorbedId: string,
    bestShotFrom: BestShotSide,
    keepMediaIds?: ReadonlySet<number>,
  ): Promise<FusionLeafReport> {
    return fuseTrackLeaves(this.deps.leaves(), {
      deviceId,
      survivorId,
      absorbedId,
      bestShotFrom,
      ...(keepMediaIds !== undefined ? { keepMediaIds } : {}),
      media: this.deps.media,
    })
  }

  private logRefusal(
    deviceId: number,
    fusion: TrackFusion,
    reason: FusionRefusalReason,
    survivorRow: FusionRowState,
    absorbedRow: FusionRowState,
  ): void {
    const now = this.now()
    const window = this.refusals.get(deviceId)
    if (window !== undefined && now - window.at < FUSION_REFUSAL_LOG_WINDOW_MS) {
      this.refusals.set(deviceId, { at: window.at, suppressed: window.suppressed + 1 })
      return
    }
    this.refusals.set(deviceId, { at: now, suppressed: 0 })
    this.deps.logger.warn(
      reason === 'absorbed-closed'
        ? 'track fusion refused — the absorbed piece already closed (a fusion never touches a closed track); both ids stay'
        : 'track fusion refused — the survivor has no active row (a fusion never touches a closed track); the tracker drops the chain',
      {
        tags: { deviceId },
        meta: {
          reason,
          survivorId: fusion.survivorId,
          absorbedId: fusion.absorbedId,
          survivorRow,
          absorbedRow,
          members: fusion.members,
          t: fusion.t,
          suppressed: window?.suppressed ?? 0,
        },
      },
    )
  }

  private enqueue(deviceId: number, step: () => Promise<void>): void {
    const next = (this.queues.get(deviceId) ?? Promise.resolve())
      .then(step)
      .catch((err: unknown) => {
        this.deps.logger.warn('track fusion durable step failed', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
      })
    this.queues.set(deviceId, next)
  }
}

function refusalOf(
  survivor: FusionRowState,
  absorbed: FusionRowState,
): FusionRefusalReason | undefined {
  if (survivor === 'closed' || survivor === 'closing') return 'survivor-closed'
  if (absorbed === 'closed' || absorbed === 'closing') return 'absorbed-closed'
  if (survivor === 'none' && absorbed === 'active') return 'survivor-no-row'
  return undefined
}

/** A fusion's leaf report, summed across families. */
interface FusionTally {
  readonly moved: number
  readonly dropped: number
  /** Rows left under the absorbed id on purpose: an enrolled face/plate, or a
   *  media pair deferred because its winning blob could not be read. */
  readonly kept: number
}

/** The leaf report summed, for the one INFO line (carry 2: `kept` is a deferral). */
function tally(counts: readonly TrackFusionLeafCount[]): FusionTally {
  let moved = 0
  let dropped = 0
  let kept = 0
  for (const c of counts) {
    moved += c.moved
    dropped += c.dropped
    kept += c.kept ?? 0
  }
  return { moved, dropped, kept }
}
