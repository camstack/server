/**
 * The devices `power-source` acts on, reached over `ctx.api`: the linked switch is read,
 * set, and — when its provider declares a native power cycle — cycled in one call.
 */
import { type AddonApi, SWITCH_DEFAULT_OPTIONS, type SwitchOptions } from '@camstack/types'
import { isCapMethodAbsent } from '@camstack/types/addon'
import { type PowerSourceDevices, SwitchOptionsUnreadableError } from './power-source-service.js'

/** The switch's options; the defaults when its provider has no `getOptions`; throws typed when the read failed. */
export async function switchOptionsOf(api: AddonApi, deviceId: number): Promise<SwitchOptions> {
  try {
    return await api.switch.getOptions.query({ deviceId })
  } catch (err: unknown) {
    if (isCapMethodAbsent(err)) return SWITCH_DEFAULT_OPTIONS
    throw new SwitchOptionsUnreadableError(deviceId, err)
  }
}

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
    options: (deviceId) => switchOptionsOf(requireApi(), deviceId),
    cycle: async (deviceId) => {
      const api = requireApi()
      // A provider that writes no `getOptions` (or is not redeployed yet) is a plain on/off switch;
      // a read that FAILED throws `SwitchOptionsUnreadableError` and the restart is refused.
      const options = await switchOptionsOf(api, deviceId)
      if (!options.supportsPowerCycle) return false
      await api.switch.powerCycle.mutate({ deviceId })
      return true
    },
  }
}
