/**
 * The devices `power-source` acts on, reached over `ctx.api`: the linked switch is read,
 * set, and — when its provider declares a native power cycle — cycled in one call.
 */
import { type AddonApi, SWITCH_DEFAULT_OPTIONS } from '@camstack/types'
import type { PowerSourceDevices } from './power-source-service.js'

export function powerSourceDevicesOver(requireApi: () => AddonApi): PowerSourceDevices {
  return {
    find: async (ref) => {
      const rows = await requireApi().deviceManager.listAll.query({
        addonId: ref.addonId,
        projection: 'slim',
      })
      const row = rows.find((r) => r.stableId === ref.stableId)
      return row === undefined ? null : { id: row.id, name: row.name, online: row.online }
    },
    readOn: async (deviceId) => {
      const status = await requireApi().switch.getStatus.query({ deviceId })
      const on: unknown =
        status !== null && typeof status === 'object' ? Reflect.get(status, 'on') : undefined
      return typeof on === 'boolean' ? on : null
    },
    setOn: async (deviceId, on) => {
      await requireApi().switch.setState.mutate({ deviceId, on })
    },
    cycle: async (deviceId) => {
      const api = requireApi()
      // A provider that writes no `getOptions` (or is not redeployed yet) is a plain on/off switch.
      const options = await api.switch.getOptions
        .query({ deviceId })
        .catch(() => SWITCH_DEFAULT_OPTIONS)
      if (!options.supportsPowerCycle) return false
      await api.switch.powerCycle.mutate({ deviceId })
      return true
    },
  }
}
