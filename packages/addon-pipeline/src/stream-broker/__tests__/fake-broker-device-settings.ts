/**
 * An in-memory stand-in for the per-device settings the broker persists through
 * (`ctx.settings`, D870): one record per device, `undefined` in a patch removes
 * the field, a device with nothing left has no entry.
 */
import type { BrokerDeviceSettings } from '../broker-device-state.js'

export interface FakeBrokerDeviceSettings extends BrokerDeviceSettings {
  readonly rows: Map<number, Record<string, unknown>>
  /** Every device written, in order - to assert a diff write touches only what changed. */
  readonly writes: number[]
  /** Make reads reject, as a store that cannot be asked. */
  failReads(error: Error | null): void
}

export function makeFakeBrokerDeviceSettings(): FakeBrokerDeviceSettings {
  const rows = new Map<number, Record<string, unknown>>()
  const writes: number[] = []
  let readFailure: Error | null = null
  const guard = (): void => {
    if (readFailure !== null) throw readFailure
  }
  return {
    rows,
    writes,
    failReads: (error) => {
      readFailure = error
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
      writes.push(deviceId)
      const next = { ...rows.get(deviceId), ...patch }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      if (Object.keys(next).length === 0) rows.delete(deviceId)
      else rows.set(deviceId, next)
    },
  }
}
