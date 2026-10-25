/**
 * An in-memory stand-in for the per-device settings an addon reaches through
 * `ctx.settings` (D870): one record per device, `undefined` in a patch removes
 * the field, a device with nothing left has no entry.
 */
import type { NcDeviceMuteSettings } from '../device-mute-store.js'

export interface FakeDeviceSettings extends NcDeviceMuteSettings {
  readonly rows: Map<number, Record<string, unknown>>
  /** Make every following call reject, as a store that cannot be asked. */
  failWith(error: Error | null): void
}

export function makeFakeDeviceSettings(): FakeDeviceSettings {
  const rows = new Map<number, Record<string, unknown>>()
  let failure: Error | null = null
  const guard = (): void => {
    if (failure !== null) throw failure
  }
  return {
    rows,
    failWith: (error) => {
      failure = error
    },
    readDeviceStoreBatch: async (ids) => {
      guard()
      return new Map(ids.map((id) => [id, { ...rows.get(id) }]))
    },
    listDeviceStoreIds: async () => {
      guard()
      return [...rows.keys()].toSorted((a, b) => a - b)
    },
    writeDeviceStore: async (deviceId, patch) => {
      guard()
      const next = { ...rows.get(deviceId), ...patch }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      if (Object.keys(next).length === 0) rows.delete(deviceId)
      else rows.set(deviceId, next)
    },
  }
}
