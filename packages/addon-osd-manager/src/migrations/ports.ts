import type { MigrationApiV1 } from '@camstack/types'
import type { BindingsToTemplatesPorts } from './bindings-to-templates.js'

/** The part of the migration API the OSD catalogue uses. */
export type OsdMigrationApi = Pick<
  MigrationApiV1,
  'settings' | 'deviceSettings' | 'devices' | 'log'
>

function byDeviceId<T>(record: Readonly<Record<string, T>>): Map<number, T> {
  const out = new Map<number, T>()
  for (const [key, value] of Object.entries(record)) {
    const id = Number(key)
    if (Number.isInteger(id)) out.set(id, value)
  }
  return out
}

/**
 * The `osd-manager` migration ports, over the migration API and nothing else: the addon's own
 * cluster rows, its own per-device rows, the aliases of the devices a row names, and the log.
 */
export function osdMigrationPortsOver(api: OsdMigrationApi): BindingsToTemplatesPorts {
  return {
    readStored: async (keys) => {
      const { store } = await api.settings.read({})
      const found: Record<string, unknown> = {}
      for (const key of keys) if (key in store) found[key] = store[key]
      return found
    },
    listDeviceIds: async () => (await api.deviceSettings.listIds({})).deviceIds,
    readDeviceField: async (deviceIds, field) => {
      const { blobs } = await api.deviceSettings.read({ deviceIds: [...deviceIds] })
      const found = new Map<number, unknown>()
      for (const [deviceId, blob] of byDeviceId(blobs)) {
        if (field in blob) found.set(deviceId, blob[field])
      }
      return found
    },
    readAliases: async (deviceIds) =>
      byDeviceId((await api.devices.aliases({ deviceIds: [...deviceIds] })).aliases),
    note: (message, deviceId) => {
      void api.log
        .warn({
          message: `osd-manager: migration - ${message}`,
          ...(deviceId === undefined ? {} : { tags: { deviceId } }),
        })
        .catch(() => undefined)
    },
  }
}
