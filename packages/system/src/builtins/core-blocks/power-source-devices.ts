/**
 * The devices `power-source` acts on, reached over `ctx.api`: the linked switch is read,
 * set, and — when its provider declares a native power cycle — cycled in one call.
 */
import { type AddonApi, SWITCH_DEFAULT_OPTIONS, type SwitchOptions } from '@camstack/types'
import { type PowerSourceDevices, SwitchOptionsUnreadableError } from './power-source-service.js'

/**
 * Whether a failed `switch.getOptions` means the provider does not HAVE the method (an optional
 * method it never wrote, or a hub that predates it) — a plain on/off switch — rather than a read
 * that failed. Named by the routing layer: `NOT_IMPLEMENTED`, the forked child's
 * `CAP_METHOD_NOT_IMPLEMENTED`, or tRPC's unknown path.
 */
function isMethodAbsent(err: unknown): boolean {
  const data: unknown =
    typeof err === 'object' && err !== null ? Reflect.get(err, 'data') : undefined
  const code: unknown =
    typeof data === 'object' && data !== null ? Reflect.get(data, 'code') : undefined
  if (code === 'NOT_IMPLEMENTED') return true
  const message = err instanceof Error ? err.message : String(err)
  return /CAP_METHOD_NOT_IMPLEMENTED|does not implement|No procedure found on path/.test(message)
}

/** The switch's options; the defaults when its provider has no `getOptions`; throws typed when the read failed. */
async function switchOptionsOf(api: AddonApi, deviceId: number): Promise<SwitchOptions> {
  try {
    return await api.switch.getOptions.query({ deviceId })
  } catch (err: unknown) {
    if (isMethodAbsent(err)) return SWITCH_DEFAULT_OPTIONS
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
