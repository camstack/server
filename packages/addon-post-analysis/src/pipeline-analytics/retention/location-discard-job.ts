/**
 * Events/media discard job: wipe `<camera>/events/` on the frozen location,
 * then drop DB rows stamped with that `locationId`, then cascade owners
 * that have NO remaining media on any other location.
 *
 * A track that still has blobs on the SSD is kept. Gallery/enrolled
 * owners are never cascaded. High/mid/low footage is not a code path
 * here — the FS half only names `events/`.
 *
 * Start returns immediately. Progress is the status snapshot; awaiting
 * the walk is how this door would hit the 60 s UDS deadline.
 */
import { randomUUID } from 'node:crypto'
import type { SettingsStoreClient } from '@camstack/types'
import { MEDIA_COLLECTION } from '../store/media-store.js'
import { OBJECT_EVENTS_COLLECTION } from '../store/event-store.js'
import { TRACKS_COLLECTION } from '../store/track-store.js'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import { wipeClassSubtrees } from './location-class-wipe.js'
import {
  assertDiscardAllowed,
  locationBasePath,
  type DiscardLocationRow,
} from './location-discard-policy.js'

export type DiscardPhase =
  | 'idle'
  | 'scanning'
  | 'wiping-fs'
  | 'wiping-db'
  | 'cascading'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface DiscardStatus {
  running: boolean
  locationId: string | null
  jobId: string | null
  phase: DiscardPhase
  camerasTotal: number
  camerasDone: number
  foldersRemoved: number
  dbRowsDeleted: number
  ownersCascaded: number
  detail: string
  startedAtMs: number | null
  finishedAtMs: number | null
  error: string | null
}

export const IDLE_DISCARD: DiscardStatus = {
  running: false,
  locationId: null,
  jobId: null,
  phase: 'idle',
  camerasTotal: 0,
  camerasDone: 0,
  foldersRemoved: 0,
  dbRowsDeleted: 0,
  ownersCascaded: 0,
  detail: '',
  startedAtMs: null,
  finishedAtMs: null,
  error: null,
}

const MEDIA_PAGE = 200
const CASCADE_KINDS = new Set(['track', 'event'])
const USB_PACE_MS = 80

export interface MediaOwnerRow {
  readonly key: string
  readonly ownerKind: string
  readonly ownerId: string
}

export interface DiscardJobDeps {
  readonly listLocations: () => Promise<readonly DiscardLocationRow[]>
  readonly localNodeId: string
  readonly store: SettingsStoreClient
  /**
   * The retrain-frame ledger — the SAME handle `RetrainFrameStore` reads
   * (`wireRetrainFrameLedger`): the `retrain-frames` records kind. The legacy
   * `pipeline-analytics:retrain-frames` table is undeclared and dropped
   * offline, so a direct store read of it fails forever.
   */
  readonly retrainFrameLedger: Pick<EventLedgerCollection, 'query' | 'deleteByIds'>
  readonly deleteTrackEvents: (trackId: string) => Promise<void>
  /** D683 (review H2): the alias leg — a track deleted here can itself be a
   *  fusion survivor, and its alias rows have nowhere else to go once its
   *  own row is gone. Optional so a version-skew/test caller keeps the
   *  previous behaviour. */
  readonly deleteTrackAliases?: (trackId: string) => Promise<void>
  readonly now: () => number
  readonly paceMs?: number
  readonly wipe?: typeof wipeClassSubtrees
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createDiscardJob(deps: DiscardJobDeps) {
  let state: DiscardStatus = { ...IDLE_DISCARD }
  let cancelRequested = false
  let inflight: Promise<void> | null = null

  const report = (patch: Partial<DiscardStatus>): void => {
    state = { ...state, ...patch }
  }

  const status = (): DiscardStatus => ({ ...state })

  const cancel = (): { requested: boolean } => {
    if (!state.running) return { requested: false }
    cancelRequested = true
    report({ detail: 'cancel requested — finishing current camera' })
    return { requested: true }
  }

  const start = async (input: {
    locationId: string
  }): Promise<{ started: boolean; alreadyRunning: boolean; jobId: string | null }> => {
    if (state.running) return { started: false, alreadyRunning: true, jobId: state.jobId }
    const jobId = randomUUID()
    cancelRequested = false
    // Reserve BEFORE the first await so a second click cannot start a
    // parallel wipe of the same USB spindle.
    report({
      ...IDLE_DISCARD,
      running: true,
      locationId: input.locationId,
      jobId,
      phase: 'scanning',
      startedAtMs: deps.now(),
      detail: 'starting',
    })
    try {
      const all = await deps.listLocations()
      const location = all.find((row) => row.id === input.locationId)
      if (!location) throw new Error(`discard refused: unknown location ${input.locationId}`)
      if (location.type !== 'eventMedia') {
        throw new Error(
          `discard refused: pipeline-analytics handles eventMedia, not ${location.type}`,
        )
      }
      assertDiscardAllowed(location, all, deps.localNodeId)
      const root = locationBasePath(location)
      report({ detail: `scanning ${root}` })
      inflight = run(location, root).finally(() => {
        inflight = null
      })
      return { started: true, alreadyRunning: false, jobId }
    } catch (err) {
      report({
        ...IDLE_DISCARD,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAtMs: deps.now(),
      })
      throw err
    }
  }

  const run = async (location: DiscardLocationRow, root: string): Promise<void> => {
    const wipe = deps.wipe ?? wipeClassSubtrees
    const paceMs = deps.paceMs ?? USB_PACE_MS
    try {
      report({ phase: 'wiping-fs', detail: `wiping events/ under ${root}` })
      const fsResult = await wipe({
        root,
        type: location.type,
        stop: () => cancelRequested,
        onProgress: (p) => {
          report({
            phase: 'wiping-fs',
            camerasTotal: p.camerasTotal,
            camerasDone: p.camerasDone,
            foldersRemoved: p.foldersRemoved,
            detail: `camera ${p.cameraId} (${p.camerasDone}/${p.camerasTotal})`,
          })
        },
        pace: () => sleep(paceMs),
      })
      if (fsResult.cancelled || cancelRequested) {
        report({
          running: false,
          phase: 'cancelled',
          camerasDone: fsResult.camerasDone,
          foldersRemoved: fsResult.foldersRemoved,
          finishedAtMs: deps.now(),
          detail: 'cancelled',
        })
        return
      }
      report({
        phase: 'wiping-db',
        camerasDone: fsResult.camerasDone,
        foldersRemoved: fsResult.foldersRemoved,
        detail: 'deleting media rows',
      })
      const owners = await deleteMediaRows(location.id)
      if (cancelRequested) {
        report({
          running: false,
          phase: 'cancelled',
          finishedAtMs: deps.now(),
          detail: 'cancelled',
        })
        return
      }
      report({ phase: 'cascading', detail: `cascading ${owners.size} owners` })
      const cascaded = await cascadeEmptyOwners(owners)
      report({
        running: false,
        phase: 'complete',
        ownersCascaded: cascaded,
        finishedAtMs: deps.now(),
        detail: `done — ${state.foldersRemoved} folders, ${state.dbRowsDeleted} rows`,
        error: null,
      })
    } catch (err) {
      report({
        running: false,
        phase: 'error',
        finishedAtMs: deps.now(),
        error: err instanceof Error ? err.message : String(err),
        detail: 'failed',
      })
    }
  }

  const deleteMediaRows = async (locationId: string): Promise<Map<string, MediaOwnerRow>> => {
    const owners = new Map<string, MediaOwnerRow>()
    let deleted = 0
    for (;;) {
      if (cancelRequested) return owners
      const rows = await deps.store.query.query({
        collection: MEDIA_COLLECTION,
        columns: ['id', 'ownerKind', 'ownerId'],
        filter: { where: { locationId }, limit: MEDIA_PAGE },
      })
      if (rows.length === 0) break
      for (const row of rows) {
        const ownerKind = String(row.data['ownerKind'] ?? '')
        const ownerId = String(row.data['ownerId'] ?? '')
        const key = row.id
        await deps.store.delete.mutate({ collection: MEDIA_COLLECTION, key })
        deleted += 1
        if (CASCADE_KINDS.has(ownerKind) && ownerId.length > 0) {
          owners.set(`${ownerKind}:${ownerId}`, { key, ownerKind, ownerId })
        }
      }
      report({ dbRowsDeleted: deleted, detail: `deleted ${deleted} media rows` })
      await sleep(0)
    }
    // The retrain dataset is operator-selected and small, and the records
    // `where` is equality-only over a mapped body: the rows are read whole and
    // matched here, exactly the predicate the legacy `where: { locationId }`
    // compiled to (an exact stored value; a NULL/absent location never matches).
    const retrainRows = await deps.retrainFrameLedger.query({})
    const retrainIds = retrainRows
      .filter((row) => row.data['locationId'] === locationId)
      .map((row) => row.id)
    for (let i = 0; i < retrainIds.length; i += MEDIA_PAGE) {
      if (cancelRequested) return owners
      const page = retrainIds.slice(i, i + MEDIA_PAGE)
      deleted += await deps.retrainFrameLedger.deleteByIds(page)
      report({ dbRowsDeleted: deleted, detail: `deleted ${deleted} media/retrain rows` })
      await sleep(0)
    }
    report({ dbRowsDeleted: deleted })
    return owners
  }

  const remainingMedia = async (ownerKind: string, ownerId: string): Promise<number> => {
    return deps.store.count.query({
      collection: MEDIA_COLLECTION,
      filter: { where: { ownerKind, ownerId } },
    })
  }

  const cascadeEmptyOwners = async (owners: Map<string, MediaOwnerRow>): Promise<number> => {
    let cascaded = 0
    for (const owner of owners.values()) {
      if (cancelRequested) return cascaded
      const left = await remainingMedia(owner.ownerKind, owner.ownerId)
      if (left > 0) continue
      if (owner.ownerKind === 'track') {
        await deps.deleteTrackEvents(owner.ownerId)
        await deps.deleteTrackAliases?.(owner.ownerId)
        await deps.store.delete.mutate({ collection: TRACKS_COLLECTION, key: owner.ownerId })
      } else if (owner.ownerKind === 'object') {
        // D476: only an OBJECT event is cascaded here — motion/audio are
        // trackless roots with their own age sweep, never this cascade
        // (D61), and this file imports no motion/audio collection.
        await deps.store.delete.mutate({ collection: OBJECT_EVENTS_COLLECTION, key: owner.ownerId })
      }
      cascaded += 1
      report({ ownersCascaded: cascaded, detail: `cascaded ${owner.ownerKind} ${owner.ownerId}` })
      await sleep(0)
    }
    return cascaded
  }

  return { start, status, cancel, waitForIdle: () => inflight }
}

export type DiscardJob = ReturnType<typeof createDiscardJob>
