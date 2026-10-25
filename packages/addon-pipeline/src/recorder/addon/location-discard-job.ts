/**
 * Footage discard job: wipe `<camera>/low/` (or `high/`+`mid/` for the
 * recordings class) on a frozen location, then forget the hour rows
 * stamped with that `locationId` and drop them from the RAM index.
 *
 * The class-subtree wipe is the load-bearing safety: `recordingsLow:default`
 * shares `/recordings` with `recordings:default`. This job never `rm`s the
 * location root. Profiles passed to the ledger forget are the class's own
 * (`low` vs `high`/`mid`) so a mis-stamped hour of the other class is not
 * dropped.
 *
 * Start returns immediately. Progress is the status snapshot.
 */
import { randomUUID } from 'node:crypto'
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

const USB_PACE_MS = 80
const FOOTAGE_TYPES = new Set(['recordings', 'recordingsLow'])

/**
 * The durable half of a discard, as this job needs it.
 *
 * `forgetScope` and NOT a walk of the segments: this job wipes the class
 * subtrees off the disk FIRST, so by the time the ledger is touched every hour
 * directory in the scope is gone — and since D523 nothing can name a segment
 * without listing its directory. A pass that tried would find nothing to forget
 * and leave the whole location accounted for, on every storage page, forever.
 *
 * It is also the one place the recorder deletes durable rows with no evidence
 * from the array at all, because the operator's own armed instruction is the
 * evidence.
 */
export interface FootageForget {
  forgetScope(scope: { locationId: string; profiles?: readonly string[] }): Promise<number>
  /** Every hour row held — so the RESIDENT index can be emptied for exactly the
   *  hours that were forgotten. */
  snapshot(): readonly {
    readonly deviceId: number
    readonly profile: string
    readonly locationId: string
    readonly hourStartMs: number
  }[]
}

export interface FootageDiscardDeps {
  readonly listLocations: () => Promise<readonly DiscardLocationRow[]>
  readonly localNodeId: string
  readonly index: {
    resetHour(
      deviceId: number,
      locationId: string,
      hourStartMs: number,
      relPaths: readonly string[],
    ): readonly string[]
  }
  readonly ledger: FootageForget | null
  readonly now: () => number
  readonly paceMs?: number
  readonly wipe?: typeof wipeClassSubtrees
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function profilesForType(type: string): readonly string[] {
  return type === 'recordingsLow' ? ['low'] : ['high', 'mid']
}

export function createFootageDiscardJob(deps: FootageDiscardDeps) {
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
      if (!FOOTAGE_TYPES.has(location.type)) {
        throw new Error(`discard refused: recorder handles footage, not ${location.type}`)
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
      report({
        phase: 'wiping-fs',
        detail: `wiping ${profilesForType(location.type).join('/')} under ${root}`,
      })
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
        detail: 'forgetting ledger hours',
      })
      const forgotten = await forgetLedger(location)
      if (cancelRequested) {
        report({
          running: false,
          phase: 'cancelled',
          dbRowsDeleted: forgotten,
          finishedAtMs: deps.now(),
          detail: 'cancelled',
        })
        return
      }
      report({
        running: false,
        phase: 'complete',
        dbRowsDeleted: forgotten,
        finishedAtMs: deps.now(),
        detail: `done — ${fsResult.foldersRemoved} folders, ${forgotten} ledger segments`,
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

  const forgetLedger = async (location: DiscardLocationRow): Promise<number> => {
    const ledger = deps.ledger
    if (ledger === null) return 0
    const profiles = profilesForType(location.type)
    const scope = { locationId: location.id, profiles }
    // The hours BEFORE the forget: afterwards there is no row left to say which
    // hours the resident index should be emptied of.
    const hours = ledger
      .snapshot()
      .filter((row) => row.locationId === location.id && profiles.includes(row.profile))
    const forgotten = await ledger.forgetScope(scope)
    for (const hour of hours) {
      deps.index.resetHour(hour.deviceId, hour.locationId, hour.hourStartMs, [])
    }
    report({ dbRowsDeleted: forgotten, detail: `forgot ${forgotten} ledger segments` })
    return forgotten
  }

  return { start, status, cancel, waitForIdle: () => inflight }
}

export type FootageDiscardJob = ReturnType<typeof createFootageDiscardJob>
