/**
 * The follow-recordings retention floor: the oldest footage the ARCHIVE holds
 * per camera, read from the recorder's durable hour ledger (D674).
 *
 * ## What it replaced
 *
 * `earliestFootageMs` asked `recording.getAvailability({ fromMs: 0, toMs: now })`
 * per camera, every ten minutes, from both pipeline-analytics runners — to learn
 * ONE number, the start of the first range. The recorder answered by walking
 * and caching every hour since 1970-01-01 (497,408 of them) for every camera:
 * 11.9 M Map keys, ~2.2 GB of heap, and the recorder's OOM of 2026-09-28 10:21.
 *
 * The number already exists, folded: `recordingArchive.getStorageUsage()`
 * reports `devices[].oldestMs` from the ledger's mirror, ONE call for every
 * camera, no I/O behind it (D418).
 *
 * ## The semantics moved — in the conservative direction
 *
 * The walk answered for the camera's SERVED profile (the availability pick).
 * The ledger's floor is the oldest segment across EVERY profile and every
 * location. Across-all is `<=` served-only, so the cutoff can only move EARLIER
 * — tracks are kept at least as long as before, never deleted sooner.
 *
 * ## A floor nobody could read is not "no footage" (D393)
 *
 * The walk's failure used to be folded into `null`, i.e. "no footage", and the
 * sweep fell back to the custom day window — which is MORE aggressive than
 * follow whenever the archive reaches back further than that window. Now an
 * unreadable answer skips that camera's sweep for the pass, and says so.
 */
import type { IScopedLogger, RecordingStorageUsage } from '@camstack/types'
import {
  resolveRetentionCutoffs,
  type DeviceRetentionCutoffs,
  type RetentionSettings,
} from '../retention-policy.js'

/** The bit of the addon api this module needs — structural, so the real
 *  `ctx.api` satisfies it and a test double can too. */
export interface ArchiveUsageApi {
  readonly recordingArchive: {
    readonly getStorageUsage: {
      query(input: Record<string, never>): Promise<RecordingStorageUsage>
    }
  }
}

/** What the archive says about one camera's oldest footage. */
export type FootageFloor =
  | {
      readonly kind: 'read'
      /** `null` = the archive holds no footage for this camera. */
      readonly oldestMs: number | null
    }
  | { readonly kind: 'unreadable'; readonly reason: string }

/**
 * How long one archive answer serves every camera. The ledger's floor moves
 * only when retention deletes an hour (minutes-to-days granularity), and the
 * sweep it feeds runs every 5 min — the same 10 min the walk was cached for.
 */
const FOOTAGE_FLOOR_TTL_MS = 10 * 60_000

/**
 * How long a FAILED read is reused before it is asked again. Short, so the
 * first sweep after the recorder answers is a real one; long enough that one
 * pass over ~24 cameras is one failed call, not twenty-four.
 */
export const FOOTAGE_FLOOR_RETRY_MS = 60_000

/** What a follow-recordings camera gets when its floor could not be read:
 *  retention OFF for this pass — nothing is deleted on a guess. */
export const UNREADABLE_FLOOR_CUTOFFS: DeviceRetentionCutoffs = {
  cutoffMs: null,
  effectiveMode: 'follow-recordings',
  floorUnreadable: true,
}

/** One archive answer, for every camera at once. */
type ArchiveAnswer =
  | { readonly atMs: number; readonly floors: ReadonlyMap<number, FootageFloor> }
  | { readonly atMs: number; readonly unreadable: string }

const NO_FOOTAGE: FootageFloor = { kind: 'read', oldestMs: null }

/**
 * Turn one `getStorageUsage` answer into per-camera floors — or say why it
 * cannot be.
 *
 *  - `devicesRead !== 'archive'`: the rows are UNKNOWN (`unavailable`: no
 *    ledger, a ledger not loaded yet, no location resolved) or come from a
 *    recorder predating D418, whose rows are RESIDENCY. No floor may be read.
 *  - `complete !== true`: the ledger load was cut at its row cap, or the
 *    recorder predates the field. A camera ABSENT from such an answer may hold
 *    footage, and a PRESENT row's `oldestMs` is the oldest of a fraction (the
 *    load keeps the newest hours) — too young, i.e. a delete. So the whole
 *    answer is unreadable, not only the absent cameras.
 *  - A row whose `oldestMs` is ABSENT comes from a recorder predating the
 *    field — unknown for that camera, never "no footage".
 *  - A camera with no row in a COMPLETE answer, or a row whose `oldestMs` is
 *    `null`: the archive holds no footage for it — the custom window applies.
 */
function footageFloorsOf(usage: RecordingStorageUsage): ReadonlyMap<number, FootageFloor> | string {
  if (usage.devicesRead !== 'archive') {
    return `recordingArchive.getStorageUsage answered devicesRead=${usage.devicesRead ?? 'absent'} — the per-camera rows are not the archive`
  }
  if (usage.complete !== true) {
    return `recordingArchive.getStorageUsage answered complete=${String(usage.complete ?? 'absent')} — the per-camera rows may be a fraction of the archive`
  }
  const floors = new Map<number, FootageFloor>()
  for (const row of usage.devices) {
    floors.set(
      row.deviceId,
      row.oldestMs === undefined
        ? { kind: 'unreadable', reason: 'the recorder omitted oldestMs for this camera' }
        : { kind: 'read', oldestMs: row.oldestMs },
    )
  }
  return floors
}

export interface ArchiveFootageFloorsDeps {
  readonly api: ArchiveUsageApi
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/**
 * Per-camera floors, one archive call per {@link FOOTAGE_FLOOR_TTL_MS} for the
 * whole fleet, single-flight.
 */
export class ArchiveFootageFloors {
  private answer: ArchiveAnswer | null = null
  private inFlight: Promise<ArchiveAnswer> | null = null
  /** Cameras whose sweep is currently skipped — one line per episode, not per
   *  pass: two sweeps × every camera × every 5 min would be a flood. */
  private readonly skipped = new Set<number>()
  /** Is the archive currently unreadable? The read-failure line is said once
   *  per EPISODE (and its end once), not once per ~sweep per runner. */
  private readFailing = false

  constructor(private readonly deps: ArchiveFootageFloorsDeps) {}

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async floorOf(deviceId: number): Promise<FootageFloor> {
    const answer = await this.current()
    if ('unreadable' in answer) return { kind: 'unreadable', reason: answer.unreadable }
    return answer.floors.get(deviceId) ?? NO_FOOTAGE
  }

  /**
   * The per-device effective cutoffs (mode + footage → numbers). A follow
   * camera whose floor is unreadable is NOT swept this pass, and that is logged.
   */
  async cutoffsFor(
    deviceId: number,
    settings: RetentionSettings,
    nowMs: number,
  ): Promise<DeviceRetentionCutoffs> {
    if (settings.retentionMode !== 'follow-recordings') {
      return resolveRetentionCutoffs(settings, nowMs, null)
    }
    const floor = await this.floorOf(deviceId)
    if (floor.kind === 'unreadable') {
      if (!this.skipped.has(deviceId)) {
        this.skipped.add(deviceId)
        this.deps.logger.warn(
          'retention: follow-recordings floor unreadable — this camera is not swept until the archive answers',
          { tags: { deviceId }, meta: { reason: floor.reason } },
        )
      }
      return UNREADABLE_FLOOR_CUTOFFS
    }
    if (this.skipped.delete(deviceId)) {
      this.deps.logger.info('retention: follow-recordings floor readable again — sweeping', {
        tags: { deviceId },
        meta: { oldestMs: floor.oldestMs },
      })
    }
    return resolveRetentionCutoffs(settings, nowMs, floor.oldestMs)
  }

  private async current(): Promise<ArchiveAnswer> {
    const held = this.answer
    const now = this.nowMs()
    if (held !== null) {
      const ttl = 'unreadable' in held ? FOOTAGE_FLOOR_RETRY_MS : FOOTAGE_FLOOR_TTL_MS
      if (now - held.atMs < ttl) return held
    }
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async read(): Promise<ArchiveAnswer> {
    let answer: ArchiveAnswer
    try {
      const floors = footageFloorsOf(await this.deps.api.recordingArchive.getStorageUsage.query({}))
      answer =
        typeof floors === 'string'
          ? { atMs: this.nowMs(), unreadable: floors }
          : { atMs: this.nowMs(), floors }
    } catch (err: unknown) {
      answer = {
        atMs: this.nowMs(),
        unreadable: `recordingArchive.getStorageUsage failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if ('unreadable' in answer && !this.readFailing) {
      this.readFailing = true
      this.deps.logger.warn(
        'retention: the archive floor could not be read — follow-recordings cameras are not swept on a guess',
        { meta: { reason: answer.unreadable, retryMs: FOOTAGE_FLOOR_RETRY_MS } },
      )
    } else if (!('unreadable' in answer) && this.readFailing) {
      this.readFailing = false
      this.deps.logger.info('retention: the archive floor is readable again', {
        meta: { cameras: answer.floors.size },
      })
    }
    this.answer = answer
    return answer
  }
}
