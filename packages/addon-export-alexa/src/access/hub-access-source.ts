/**
 * The production wiring of the S1 gate: user grants from the hub's user store,
 * device metadata from the device registry — the two authorities that own them.
 * Kept out of the addon class so the class stays a composition root.
 */
import type { AddonContext } from '@camstack/types'
import { AlexaAccessGate } from './access-gate.js'

export function createHubAccessGate(ctx: AddonContext): AlexaAccessGate {
  return new AlexaAccessGate({
    logger: ctx.logger,
    listUserGrants: async () => {
      const users = await ctx.api.userManagement.listUsers.query()
      return users.map((u) => ({ userId: u.id, isAdmin: u.isAdmin, scopes: u.scopes }))
    },
    getDeviceMeta: async (deviceId) => {
      const device = await ctx.api.deviceManager.getDevice.query({ deviceId })
      if (device === null) return null
      return {
        id: device.id,
        type: String(device.type),
        location: device.location,
        parentDeviceId: device.parentDeviceId,
      }
    },
  })
}
