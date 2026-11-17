/**
 * The addon's whole dependency on the hub, named as one interface.
 *
 * The three intent handlers take a `DeviceGateway`, never `ctx.api`. That is
 * not ceremony: `AddonApi` is a generated tRPC router type wide enough that a
 * test fake for it is only constructible with casts, and this repo forbids
 * casts. With the gateway, `__tests__/*.spec.ts` builds a nine-line object and
 * the intent logic is exercised for real — including the branches that DROP a
 * device, which are the ones that matter.
 */
import { type AddonApi, type IScopedLogger, switchRefusesSetState } from '@camstack/types'
import { dispatchCapCall, readCapStatus, type GooglePrincipal } from './google-home/cap-dispatch.js'
import type { ExportableDeviceFacts } from './google-home/device-model.js'
import type { CapCall, CapStatusRead } from './google-home/trait-catalog.js'

export interface DeviceGateway {
  /** Live-registry facts for one device, or `null` when it is gone. */
  readonly loadFacts: (deviceId: number) => Promise<ExportableDeviceFacts | null>
  /** Raw cap `getStatus` payload. Callers parse it with the cap's own schema. */
  readonly readStatus: (read: CapStatusRead, deviceId: number) => Promise<unknown>
  /** Perform a resolved capability call. Rejects on provider failure. */
  readonly dispatch: (call: CapCall, principal?: GooglePrincipal) => Promise<void>
}

/** The shape `deviceManager.getBindings` returns, narrowed to what we read. */
interface BindingEntry {
  readonly capName: string
}

export interface ApiDeviceGatewayDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
}

/**
 * The caps Google may see for a device: its bound caps, minus `switch` when that
 * switch ANSWERED it cannot be set (`getOptions().supportsSetState: false`, a PoE
 * port seen only through an API key — D1058): an OnOff trait whose every EXECUTE
 * fails is a lie. A provider without `getOptions`, or a failed read, keeps the
 * switch (D315); the failure is logged against the device.
 */
export async function exportedCapNames(
  deviceId: number,
  bound: readonly string[],
  readSwitchOptions: () => Promise<unknown>,
  logger: Pick<IScopedLogger, 'debug'>,
): Promise<readonly string[]> {
  if (!bound.includes('switch')) return bound
  let answer: unknown
  try {
    answer = await readSwitchOptions()
  } catch (err: unknown) {
    logger.debug('export-google: switch options unread — exporting it as a plain OnOff switch', {
      tags: { deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return bound
  }
  if (!switchRefusesSetState(answer)) return bound
  logger.debug('export-google: switch only reports its state — no OnOff trait for it', {
    tags: { deviceId },
  })
  return bound.filter((cap) => cap !== 'switch')
}

/**
 * `DeviceGateway` over the real hub API.
 *
 * `loadFacts` swallows nothing: a device missing from the registry returns
 * `null` (a fact the caller logs and turns into `deviceNotFound`), while a
 * failing `getBindings` REJECTS. Those are different — an absent device is a
 * stale exposed entry, a failing read is a hub problem — and collapsing them
 * would report a healthy device as deleted.
 */
export function createApiDeviceGateway(deps: ApiDeviceGatewayDeps): DeviceGateway {
  return {
    loadFacts: async (deviceId) => {
      const device = await deps.api.deviceManager.getDevice.query({ deviceId })
      if (!device) return null
      const bindings = await deps.api.deviceManager.getBindings.query({ deviceId })
      const entries: readonly BindingEntry[] = bindings.entries
      return {
        deviceId: device.id,
        name: device.name,
        deviceType: device.type,
        role: device.role ?? null,
        features: device.features,
        capNames: await exportedCapNames(
          device.id,
          entries.map((entry) => entry.capName),
          () => deps.api.switch.getOptions.query({ deviceId: device.id }),
          deps.logger,
        ),
      }
    },
    readStatus: (read, deviceId) => readCapStatus(deps.api, read, deviceId),
    dispatch: (call, principal) => dispatchCapCall(deps.api, call, principal),
  }
}
