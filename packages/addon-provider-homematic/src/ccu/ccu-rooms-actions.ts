import type { HmDevice, HmRoom } from 'nodehomematic'
import type { z } from 'zod'
import type { CcuActionDeps } from './ccu-facade.js'
import { requireConfirmed, requireFacade } from './ccu-facade.js'
import type {
  CcuRoom,
  CcuRoomsResult,
  CreateRoomInputSchema,
  DeleteRoomInputSchema,
  IntegrationRefSchema,
  LinkEndpoint,
  OkResultSchema,
  RenameRoomInputSchema,
  RoomChannelsResultSchema,
  SetRoomChannelsInputSchema,
} from './ccu-schemas.js'
import { channelNameLookup } from './hm-channel-names.js'
import { hmName } from '../devices/hm-name.js'

type IntegrationRef = z.infer<typeof IntegrationRefSchema>
type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>
type RenameRoomInput = z.infer<typeof RenameRoomInputSchema>
type DeleteRoomInput = z.infer<typeof DeleteRoomInputSchema>
type SetRoomChannelsInput = z.infer<typeof SetRoomChannelsInputSchema>
type RoomChannelsResult = z.infer<typeof RoomChannelsResultSchema>
type OkResult = z.infer<typeof OkResultSchema>

function requireName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('A room needs a name')
  return trimmed
}

/** Every channel a room may hold: all but the maintenance channel (index 0). */
function roomCandidates(devices: readonly HmDevice[]): LinkEndpoint[] {
  return devices.flatMap((device) =>
    device.channels
      .filter((channel) => channel.index !== 0)
      .map((channel) => ({
        address: channel.address,
        name: hmName(channel.name),
        deviceName: hmName(device.name),
        deviceType: device.type,
      })),
  )
}

/** The Settings tab's rooms: list, create, rename, delete, and which channels each holds. */
export function buildCcuRoomHandlers(deps: CcuActionDeps) {
  const logWrite = (what: string, integrationId: string, extra: Record<string, unknown>): void => {
    deps.logger.info(`Homematic: room ${what}`, { meta: { integrationId, ...extra } })
  }

  const toRoom = (room: HmRoom, devices: readonly HmDevice[]): CcuRoom => {
    const names = channelNameLookup(devices)
    return {
      id: room.id,
      name: room.name,
      channels: room.channels.map((address) => {
        const found = names(address)
        return {
          address,
          name: found.channelName,
          deviceName: found.deviceName,
          deviceType: found.deviceType,
        }
      }),
    }
  }

  return {
    listCcuRooms: async (input: IntegrationRef): Promise<CcuRoomsResult> => {
      const facade = requireFacade(deps, input.integrationId)
      const devices = facade.devices()
      const rooms = await facade.listRooms()
      return {
        rooms: rooms.map((room) => toRoom(room, devices)),
        channels: roomCandidates(devices),
      }
    },

    createCcuRoom: async (input: CreateRoomInput): Promise<CcuRoom> => {
      requireConfirmed(input.confirmed)
      const name = requireName(input.name)
      const facade = requireFacade(deps, input.integrationId)
      const created = await facade.createRoom(name)
      logWrite('created', input.integrationId, { roomId: created.id, name: created.name })
      deps.ccuChanged(input.integrationId)
      return toRoom(created, facade.devices())
    },

    renameCcuRoom: async (input: RenameRoomInput): Promise<OkResult> => {
      requireConfirmed(input.confirmed)
      const name = requireName(input.name)
      const facade = requireFacade(deps, input.integrationId)
      await facade.renameRoom(input.id, name)
      logWrite('renamed', input.integrationId, { roomId: input.id, name })
      deps.ccuChanged(input.integrationId)
      return { ok: true }
    },

    deleteCcuRoom: async (input: DeleteRoomInput): Promise<OkResult> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      await facade.deleteRoom(input.id)
      logWrite('deleted', input.integrationId, { roomId: input.id })
      deps.ccuChanged(input.integrationId)
      return { ok: true }
    },

    setCcuRoomChannels: async (input: SetRoomChannelsInput): Promise<RoomChannelsResult> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      const room = (await facade.listRooms()).find((candidate) => candidate.id === input.id)
      if (room === undefined) throw new Error(`The CCU has no room ${input.id}`)
      const wanted = new Set(input.channels)
      const current = new Set(room.channels)
      const added = input.channels.filter((address) => !current.has(address))
      const removed = room.channels.filter((address) => !wanted.has(address))
      for (const address of added) await facade.addChannelToRoom(input.id, address)
      for (const address of removed) await facade.removeChannelFromRoom(input.id, address)
      logWrite('members changed', input.integrationId, {
        roomId: input.id,
        added: added.length,
        removed: removed.length,
      })
      if (added.length > 0 || removed.length > 0) deps.ccuChanged(input.integrationId)
      return { added, removed }
    },
  }
}
