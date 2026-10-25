/**
 * The reconcile half of `device-removal-hook` (D865), shared by every
 * implementer so the rule is written once.
 *
 * A hook call can miss an implementer that was down or restarting when the
 * device was deleted. At start (and every {@link REMOVAL_RECONCILE_INTERVAL_MS}
 * after) the implementer asks device-manager for the TOMBSTONES it may have
 * missed and runs its own idempotent removal for each.
 *
 * What it will never do: decide a device is gone because it is absent from a
 * device list. The only input is a tombstone — a recorded DELETE. A failed
 * read of the tombstones changes nothing (D49): it is logged and the next tick
 * asks again.
 */
import type {
  DeviceRemovedInput,
  DeviceRemovedResult,
} from '../capabilities/device-removal-hook.cap.js'
import { DEVICE_TOMBSTONE_RETENTION_MS } from '../capabilities/device-manager.cap.js'
import type { DeviceTombstone } from '../capabilities/device-manager.cap.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import { errMsg } from '../utils/err-msg.js'

/** How often an implementer re-asks for tombstones after its start-up pass. */
export const REMOVAL_RECONCILE_INTERVAL_MS: number = 6 * 60 * 60 * 1000

/** The slice of `ctx.api` the reconcile reads — narrower than the generated client. */
export interface TombstoneSource {
  readonly deviceManager: {
    readonly listDeletedSince: {
      query(input: { sinceMs: number }): Promise<readonly DeviceTombstone[]>
    }
  }
}

export interface RemovalReconcileOptions {
  readonly api: TombstoneSource | undefined
  readonly logger: IScopedLogger
  /** The implementer's own idempotent removal — the same one `onDeviceRemoved` runs. */
  readonly remove: (input: DeviceRemovedInput) => Promise<DeviceRemovedResult>
  readonly now?: () => number
}

export interface RemovalReconcileOutcome {
  /** `false` when the tombstones could not be read; nothing was touched. */
  readonly read: boolean
  readonly applied: number
  readonly failed: number
}

/** One reconcile pass over every tombstone inside the retention window. */
export async function reconcileRemovedDevices(
  opts: RemovalReconcileOptions,
): Promise<RemovalReconcileOutcome> {
  const now = opts.now ?? ((): number => Date.now())
  const api = opts.api
  if (api === undefined) {
    opts.logger.warn('device removal reconcile skipped — no device-manager api')
    return { read: false, applied: 0, failed: 0 }
  }
  let tombstones: readonly DeviceTombstone[]
  try {
    tombstones = await api.deviceManager.listDeletedSince.query({
      sinceMs: now() - DEVICE_TOMBSTONE_RETENTION_MS,
    })
  } catch (err: unknown) {
    opts.logger.warn('device removal reconcile skipped — tombstones unreadable, nothing deleted', {
      meta: { error: errMsg(err) },
    })
    return { read: false, applied: 0, failed: 0 }
  }
  let applied = 0
  let failed = 0
  for (const tombstone of tombstones) {
    try {
      const result = await opts.remove(tombstone)
      applied += 1
      const deleted = Object.values(result.counts).reduce((sum, n) => sum + n, 0)
      if (deleted > 0) {
        opts.logger.info('device removal reconcile cleaned a missed deletion', {
          tags: { deviceId: tombstone.deviceId },
          meta: { counts: result.counts, deletedAt: tombstone.deletedAt },
        })
      }
    } catch (err: unknown) {
      failed += 1
      opts.logger.warn('device removal reconcile failed for a device — retried next pass', {
        tags: { deviceId: tombstone.deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }
  return { read: true, applied, failed }
}

/**
 * Run the reconcile now and then periodically. Returns the disposer. The timer
 * is unref'd and a pass never overlaps the previous one.
 */
export function armRemovalReconcile(opts: RemovalReconcileOptions): () => void {
  let running = false
  const pass = (): void => {
    if (running) return
    running = true
    void reconcileRemovedDevices(opts)
      .catch((err: unknown) => {
        opts.logger.warn('device removal reconcile pass crashed', { meta: { error: errMsg(err) } })
      })
      .finally(() => {
        running = false
      })
  }
  pass()
  const timer = setInterval(pass, REMOVAL_RECONCILE_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
