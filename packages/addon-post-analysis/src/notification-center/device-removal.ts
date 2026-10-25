/**
 * The notification centre's half of `device-removal-hook` (D865, D871): a
 * deleted device's DEVICE rows go with it — its liveness row, device alerts,
 * system-state rows, snooze counters, occupancy state, track groups and
 * artifact-library index rows. NODE rows (`node:*` liveness, node state) are
 * not about a device and stay.
 *
 * Every one of those is a records kind whose rows carry the camera on the
 * record envelope (`deviceId`), so one `deleteWhere({ deviceId })` per kind is
 * the whole removal: idempotent (a device with nothing left answers zero) and
 * served by the engine's built-in device index. The legacy tables are never
 * touched — a table dropped offline must not be the reason a removal throws.
 * The in-RAM mirrors are evicted by the same call so a deleted device is not
 * re-persisted by a later write-behind of a mirrored row.
 *
 * Snooze WINDOWS (`snoozes`) are not device rows — a window is a class/target
 * silence an operator opened, with no device — and are untouched; only the
 * suppression counters (which name a device) go. Artifact BYTES stay on the
 * retained shelf, whose own age/count/size bounds sweep them; only the
 * browsable index rows go.
 */
import type { DefinedRecordKind, IScopedLogger } from '@camstack/types'
import type { DurableLedgerBodySchema } from '../durable/durable-record-body.js'
import type { DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'

export interface NcDeviceRowKind {
  /** The key reported in the hook's counts. */
  readonly key: string
  readonly kind: DefinedRecordKind<typeof DurableLedgerBodySchema>
}

/** The kinds whose rows can be about a device. */
export const NC_DEVICE_ROW_KINDS: readonly NcDeviceRowKind[] = [
  { key: 'nc-liveness', kind: ncDurableRecordKinds.liveness },
  { key: 'nc-device-alerts', kind: ncDurableRecordKinds['device-alerts'] },
  { key: 'nc-system-state', kind: ncDurableRecordKinds['system-state'] },
  {
    key: 'nc-snooze-suppressed',
    kind: ncDurableRecordKinds['snooze-suppressed'],
  },
  { key: 'nc-occupancy', kind: ncDurableRecordKinds.occupancy },
  { key: 'nc-track-groups', kind: ncDurableRecordKinds['track-groups'] },
  { key: 'nc-artifacts', kind: ncDurableRecordKinds.artifacts },
]

export interface NcDeviceRemovalDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
  /** Drops the device from the in-RAM mirrors of the stores that keep one. */
  readonly evictMirrors: (deviceId: number) => void
}

/**
 * Delete every device row the centre keeps for `deviceId`. Every kind is
 * attempted; if any failed the first error is rethrown AFTER the rest ran, so
 * the hook's bounded retry (or the next reconcile) finishes the job.
 */
export async function removeNcDeviceRows(
  deps: NcDeviceRemovalDeps,
  deviceId: number,
): Promise<Record<string, number>> {
  deps.evictMirrors(deviceId)
  const counts: Record<string, number> = {}
  let failure: unknown
  for (const { key, kind } of NC_DEVICE_ROW_KINDS) {
    try {
      counts[key] = await deps.records.kind(kind).deleteWhere({ deviceId })
    } catch (err: unknown) {
      deps.logger.warn('notification-center device rows not removed', {
        tags: { deviceId },
        meta: {
          kind: kind.name,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      failure ??= err
    }
  }
  if (failure !== undefined) throw failure
  return counts
}
