/**
 * Per-device raw windows live in the addon's standard per-device store (D865):
 * `rawDays` and `rawDiscreteDays`, a positive number of days. Anything else stored
 * under those keys (a cleared override is `null`) means the device follows the cluster.
 */
import type { RawDeviceOverride } from './retention.js'

interface DeviceStoreReader {
  listDeviceStoreIds(): Promise<readonly number[]>
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
}

/** The keys a device may override; `updateDeviceSettings` refuses every other. */
export const RAW_OVERRIDE_KEYS: readonly string[] = ['rawDays', 'rawDiscreteDays']

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function parseRawOverride(record: Readonly<Record<string, unknown>>): RawDeviceOverride {
  const rawDays = positive(record['rawDays'])
  const rawDiscreteDays = positive(record['rawDiscreteDays'])
  return {
    ...(rawDays === undefined ? {} : { rawDays }),
    ...(rawDiscreteDays === undefined ? {} : { rawDiscreteDays }),
  }
}

/** Every device with an override, one read for the ids and one batch for the values. Throws when the store cannot be asked. */
export async function readRawOverrides(
  settings: DeviceStoreReader,
): Promise<ReadonlyMap<number, RawDeviceOverride>> {
  const ids = await settings.listDeviceStoreIds()
  if (ids.length === 0) return new Map()
  const rows = await settings.readDeviceStoreBatch(ids)
  const out = new Map<number, RawDeviceOverride>()
  for (const [deviceId, record] of rows) {
    const parsed = parseRawOverride(record)
    if (parsed.rawDays !== undefined || parsed.rawDiscreteDays !== undefined)
      out.set(deviceId, parsed)
  }
  return out
}
