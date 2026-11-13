import type { CcuActionDeps } from './ccu-facade.js'
import { requireFacade } from './ccu-facade.js'
import { keyChannelsForDevice, withKeyChannels } from './ccu-button-events.js'
import { toCcuDeviceRow } from './ccu-device-rows.js'
import type { CcuDeviceRow } from './ccu-schemas.js'

/** The CCU device list: every device the CCU knows, with its radio and maintenance health. */
export function buildCcuDevicesHandlers(deps: CcuActionDeps) {
  return {
    listCcuDevices: async (input: {
      readonly integrationId: string
    }): Promise<{ devices: CcuDeviceRow[] }> => {
      const facade = requireFacade(deps, input.integrationId)
      const adopted = await deps.adoptedAddresses(input.integrationId)
      const devices = await Promise.all(
        facade.devices().map(async (device) => {
          const links = await keyChannelsForDevice(deps, input.integrationId, device, adopted)
          return {
            ...withKeyChannels(toCcuDeviceRow(device), links),
            deviceId: adopted.get(device.address) ?? null,
          }
        }),
      )
      return { devices }
    },
  }
}
