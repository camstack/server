import type { z } from 'zod'
import type { CcuActionDeps } from './ccu-facade.js'
import { requireConfirmed, requireFacade } from './ccu-facade.js'
import type {
  DeviceRenameResult,
  NamedObjectSchema,
  RenameChannelInputSchema,
  RenameDeviceInputSchema,
} from './ccu-schemas.js'

type RenameDeviceInput = z.infer<typeof RenameDeviceInputSchema>
type RenameChannelInput = z.infer<typeof RenameChannelInputSchema>
type NamedObject = z.infer<typeof NamedObjectSchema>

function requireName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('A CCU name cannot be blank')
  return trimmed
}

/** Renaming a device (optionally with its channels) or one channel on the CCU. */
export function buildCcuRenameHandlers(deps: CcuActionDeps) {
  return {
    renameCcuDevice: async (input: RenameDeviceInput): Promise<DeviceRenameResult> => {
      requireConfirmed(input.confirmed)
      const name = requireName(input.name)
      const facade = requireFacade(deps, input.integrationId)
      const renamed = await facade.renameDevice(input.address, name, {
        renameChannels: input.renameChannels,
      })
      deps.logger.info('Homematic: device renamed on the CCU', {
        meta: {
          integrationId: input.integrationId,
          address: input.address,
          name: renamed.device.name,
          channels: renamed.channels.length,
        },
      })
      deps.ccuChanged(input.integrationId)
      return {
        device: { address: renamed.device.address, name: renamed.device.name },
        channels: renamed.channels.map((channel) => ({
          address: channel.address,
          name: channel.name,
        })),
      }
    },

    renameCcuChannel: async (input: RenameChannelInput): Promise<NamedObject> => {
      requireConfirmed(input.confirmed)
      const name = requireName(input.name)
      const facade = requireFacade(deps, input.integrationId)
      const renamed = await facade.renameChannel(input.address, name)
      deps.logger.info('Homematic: channel renamed on the CCU', {
        meta: { integrationId: input.integrationId, address: input.address, name: renamed.name },
      })
      deps.ccuChanged(input.integrationId)
      return { address: renamed.address, name: renamed.name }
    },
  }
}
