/**
 * The forked runner's `ctx.settings` device methods (D870).
 *
 * A runner does not hold the settings door; it holds a tRPC client of the hub's
 * `settings-store` cap. This file adapts that client to the door slice the
 * per-device store needs and hands back the five view methods — the SAME module
 * hub-main's view uses, so a device's settings are one set of rows whichever
 * process asks. Before D870 the runner kept its own `<addonId>:addon-devices`
 * blob per device; a hub-side write to the rows was invisible to it.
 */
import {
  type DeviceSettingsDoor,
  type DeviceSettingsStore,
  createDeviceSettingsStore,
  readDeviceOrThrow,
} from '../device-settings-store.js'

/** The client calls the adapter uses. */
export interface RunnerSettingsClient {
  readonly query: { query: DeviceSettingsDoor['query'] }
  readonly transact: { mutate: DeviceSettingsDoor['transact'] }
  readonly deleteWhere: { mutate: DeviceSettingsDoor['deleteWhere'] }
}

/** The door slice the per-device store needs, over a tRPC client. */
export function doorOverClient(client: RunnerSettingsClient): DeviceSettingsDoor {
  return {
    query: (input) => client.query.query(input),
    transact: (input) => client.transact.mutate(input),
    deleteWhere: (input) => client.deleteWhere.mutate(input),
  }
}

/** The per-device methods of a runner's `ctx.settings`. */
export interface RunnerDeviceSettingsView {
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  readDeviceStoreBatch: DeviceSettingsStore['readBatch']
  listDeviceStoreIds: DeviceSettingsStore['listIds']
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  clearDeviceStore(deviceId: number): Promise<void>
}

/**
 * @param client the hub's `settingsStore` client, or `undefined` when the
 *   runner has none — every call then THROWS: a store that could not be asked
 *   is not an empty one.
 */
export function createRunnerDeviceSettings(
  client: RunnerSettingsClient | undefined,
  addonId: string,
): RunnerDeviceSettingsView {
  if (client === undefined) {
    const refuse = (): never => {
      throw new Error(`device settings of "${addonId}": settings store not wired`)
    }
    return {
      readDeviceStore: async () => refuse(),
      readDeviceStoreBatch: async () => refuse(),
      listDeviceStoreIds: async () => refuse(),
      writeDeviceStore: async () => refuse(),
      clearDeviceStore: async () => refuse(),
    }
  }
  const store = createDeviceSettingsStore(doorOverClient(client), addonId)
  return {
    readDeviceStore: (deviceId) => readDeviceOrThrow(store, deviceId),
    readDeviceStoreBatch: (ids) => store.readBatch(ids),
    listDeviceStoreIds: () => store.listIds(),
    writeDeviceStore: (deviceId, patch) => store.merge(deviceId, patch),
    clearDeviceStore: (deviceId) => store.clear(deviceId),
  }
}
