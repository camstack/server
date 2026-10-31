import type { CcuActionDeps } from './ccu-facade.js'
import { requireFacade } from './ccu-facade.js'
import { toCcuDeviceRow } from './ccu-device-rows.js'
import type { CcuDeviceRow } from './ccu-schemas.js'

/** The CCU device list: every device the CCU knows, with its radio and maintenance health. */
export function buildCcuDevicesHandlers(deps: CcuActionDeps) {
  return {
    listCcuDevices: async (input: {
      readonly integrationId: string
    }): Promise<{ devices: CcuDeviceRow[] }> => {
      const facade = requireFacade(deps, input.integrationId)
      return { devices: facade.devices().map(toCcuDeviceRow) }
    },
  }
}
