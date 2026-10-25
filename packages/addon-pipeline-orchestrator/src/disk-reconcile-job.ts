/**
 * In-memory disk-wins fleet job. The tRPC mutation starts this and returns
 * immediately; the walk runs in the addon process so a 60s UDS timeout cannot
 * abort it. Status is polled via getReconcileFromDiskStatus.
 */
import {
  reconcileFleetFromDisk,
  type FleetDiskReconcileCameraCounts,
  type FleetDiskReconcileDeps,
} from './disk-reconcile-fleet.js'

export type DiskReconcileJobState = 'idle' | 'running' | 'done' | 'error'

export interface DiskReconcileJob {
  readonly state: DiskReconcileJobState
  readonly total: number
  readonly completed: number
  readonly currentDeviceId: number | null
  readonly failed: readonly number[]
  readonly mediaDropped: number
  readonly tracks: number
  readonly events: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly error: string | null
}

export function idleDiskReconcileJob(): DiskReconcileJob {
  return {
    state: 'idle',
    total: 0,
    completed: 0,
    currentDeviceId: null,
    failed: [],
    mediaDropped: 0,
    tracks: 0,
    events: 0,
    startedAtMs: null,
    finishedAtMs: null,
    error: null,
  }
}

export interface DiskReconcileJobStartDeps extends FleetDiskReconcileDeps {
  log?(message: string, meta?: Record<string, unknown>): void
}

export interface DiskReconcileJobRunner {
  snapshot(): DiskReconcileJob
  start(deps: DiskReconcileJobStartDeps): DiskReconcileJob
}

function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /timed out/i.test(message)
}

async function withTimeoutRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!isTimeoutError(err)) throw err
    return await run()
  }
}

export function createDiskReconcileJobRunner(now: () => number = Date.now): DiskReconcileJobRunner {
  let job: DiskReconcileJob = idleDiskReconcileJob()
  let inFlight: Promise<void> | null = null

  const snapshot = (): DiskReconcileJob => job

  const start = (deps: DiskReconcileJobStartDeps): DiskReconcileJob => {
    if (job.state === 'running' && inFlight) return job
    job = {
      ...idleDiskReconcileJob(),
      state: 'running',
      startedAtMs: now(),
    }
    deps.log?.('pipeline disk reconcile started')
    inFlight = (async () => {
      try {
        const result = await reconcileFleetFromDisk({
          listDeviceIds: deps.listDeviceIds,
          rescanRecordings: (deviceId) => withTimeoutRetry(() => deps.rescanRecordings(deviceId)),
          reconcileAnalytics: (deviceId) =>
            withTimeoutRetry(() => deps.reconcileAnalytics(deviceId)),
          onProgress: (update) => {
            job = {
              ...job,
              total: update.total,
              completed: update.completed,
              currentDeviceId: update.deviceId,
              failed: update.failed,
              mediaDropped: update.mediaDropped,
              tracks: update.tracks,
              events: update.events,
            }
            deps.onProgress?.(update)
            deps.log?.('pipeline disk reconcile camera', {
              deviceId: update.deviceId,
              completed: update.completed,
              total: update.total,
              failed: update.failed.length,
              mediaDropped: update.mediaDropped,
              tracks: update.tracks,
              events: update.events,
            })
          },
        })
        job = {
          ...job,
          state: 'done',
          total: result.cameras + result.failed.length,
          completed: result.cameras + result.failed.length,
          currentDeviceId: null,
          failed: result.failed,
          mediaDropped: result.mediaDropped,
          tracks: result.tracks,
          events: result.events,
          finishedAtMs: now(),
          error: null,
        }
        deps.log?.('pipeline disk reconcile', {
          cameras: result.cameras,
          failed: result.failed,
          mediaDropped: result.mediaDropped,
          tracks: result.tracks,
          events: result.events,
        })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        job = {
          ...job,
          state: 'error',
          currentDeviceId: null,
          finishedAtMs: now(),
          error,
        }
        deps.log?.('pipeline disk reconcile failed', { error })
      } finally {
        inFlight = null
      }
    })()
    return job
  }

  return { snapshot, start }
}

export type { FleetDiskReconcileCameraCounts }
