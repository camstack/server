/**
 * Which devices the notification centre holds rows for, per store (D870) - the
 * listing half of the `device-removal-hook` the pipeline-analytics addon
 * provides for it. The removal half is `device-removal.ts` (D871); both walk
 * the same `NC_DEVICE_ROW_KINDS`, so what is listed is what is removed, and
 * both read the record ENVELOPE's `deviceId`, which is what removal deletes by.
 */
import type { DeviceDataEntry } from '@camstack/types'
import type { DurableKindDeps } from '../durable/durable-wiring.js'
import { collectRecordPages } from '../durable/query-pages.js'
import { NC_DEVICE_ROW_KINDS } from './device-removal.js'

const LIST_LIMIT = 20_000

/** Which devices hold rows, and how many, per store. Throws when a read may be truncated. */
export async function listNcDeviceData(deps: DurableKindDeps): Promise<readonly DeviceDataEntry[]> {
  const out: DeviceDataEntry[] = []
  for (const { key, kind } of NC_DEVICE_ROW_KINDS) {
    const name = key.replace(/^nc-/, '')
    const { rows, truncated } = await collectRecordPages(deps.records.kind(kind), {}, LIST_LIMIT)
    if (truncated) {
      throw new Error(`notification-center ${name}: ${rows.length} rows - possibly truncated`)
    }
    const counts = new Map<number, number>()
    for (const row of rows) {
      const id = row.deviceId
      if (id !== null && Number.isInteger(id) && id > 0) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    for (const [deviceId, count] of counts) out.push({ store: name, deviceId, count })
  }
  return out
}
