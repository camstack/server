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
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { dispatchCapCall, readCapStatus } from './google-home/cap-dispatch.js'
import type { ExportableDeviceFacts } from './google-home/device-model.js'
import type { CapCall, CapStatusRead } from './google-home/trait-catalog.js'

export interface DeviceGateway {
  /** Live-registry facts for one device, or `null` when it is gone. */
  readonly loadFacts: (deviceId: number) => Promise<ExportableDeviceFacts | null>
  /** Raw cap `getStatus` payload. Callers parse it with the cap's own schema. */
  readonly readStatus: (read: CapStatusRead, deviceId: number) => Promise<unknown>
  /** Perform a resolved capability call. Rejects on provider failure. */
  readonly dispatch: (call: CapCall) => Promise<void>
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
        features: device.features,
        capNames: entries.map((entry) => entry.capName),
      }
    },
    readStatus: (read, deviceId) => readCapStatus(deps.api, read, deviceId),
    dispatch: (call) => dispatchCapCall(deps.api, call),
  }
}
