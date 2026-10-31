import type { HmDevice, HmGroup } from 'nodehomematic'
import type { CcuActionDeps } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import {
  HEATING_GROUP_TYPES,
  type GroupCandidate,
  type HeatingGroup,
  type HeatingOverview,
} from './ccu-schemas.js'

/** Channel types that can sit in a heating group (HmIP and HomeMatic thermostats, wall thermostats, radiator valves). */
const HEATING_CHANNEL = /THERMOSTAT|CLIMATECONTROL|THERMALCONTROL/i

function deviceAddressOf(channelAddress: string): string {
  const colon = channelAddress.indexOf(':')
  return colon === -1 ? channelAddress : channelAddress.slice(0, colon)
}

function toGroup(group: HmGroup, names: ReadonlyMap<string, string | null>): HeatingGroup {
  return {
    id: group.id,
    name: group.name,
    type: group.type,
    typeLabel: group.typeLabel,
    deviceAddress: group.deviceAddress,
    forbidSingleOperation: group.forbidSingleOperation,
    members: group.members.map((member) => ({
      address: member.address,
      type: member.type,
      deviceName: names.get(deviceAddressOf(member.address)) ?? null,
    })),
  }
}

function candidatesOf(devices: readonly HmDevice[]): GroupCandidate[] {
  const out: GroupCandidate[] = []
  for (const device of devices) {
    for (const channel of device.channels) {
      if (channel.type !== undefined && HEATING_CHANNEL.test(channel.type)) {
        out.push({
          address: channel.address,
          type: channel.type,
          deviceName: device.name ?? null,
        })
      }
    }
  }
  return out
}

function isGroupType(value: string): value is (typeof HEATING_GROUP_TYPES)[number] {
  return HEATING_GROUP_TYPES.some((known) => known === value)
}

/** The Heating tab: thermostats and heating groups, and the group writes (create / edit / delete). */
export function buildCcuHeatingHandlers(deps: CcuActionDeps) {
  const logWrite = (what: string, integrationId: string, extra: Record<string, unknown>): void => {
    deps.logger.info(`Homematic: heating group ${what}`, { meta: { integrationId, ...extra } })
  }

  return {
    listHeatingGroups: async (input: { integrationId: string }): Promise<HeatingOverview> => {
      const facade = requireFacade(deps, input.integrationId)
      const devices = facade.devices()
      const names = new Map(devices.map((device) => [device.address, device.name ?? null]))
      let groups: HeatingGroup[] = []
      let groupsError: string | null = null
      try {
        groups = (await facade.groups()).map((group) => toGroup(group, names))
      } catch (err) {
        groupsError = errorText(err)
        deps.logger.warn('Homematic: heating groups unavailable', {
          meta: { integrationId: input.integrationId, error: groupsError },
        })
      }
      const thermostats = facade.customEntities().flatMap((entity) =>
        entity.kind === 'climate'
          ? [
              {
                device: entity.device,
                channel: entity.channel,
                name: names.get(entity.device) ?? null,
                currentTemperature: entity.currentTemperature,
                targetTemperature: entity.targetTemperature,
                mode: entity.mode,
                activity: entity.activity,
              },
            ]
          : [],
      )
      return { groups, groupsError, thermostats, candidates: candidatesOf(devices) }
    },

    createHeatingGroup: async (input: {
      integrationId: string
      name: string
      type: string
      members: string[]
      confirmed: boolean
    }): Promise<HeatingGroup> => {
      requireConfirmed(input.confirmed)
      const name = input.name.trim()
      if (name === '') throw new Error('A heating group needs a name')
      if (input.members.length === 0) throw new Error('A heating group needs at least one member')
      if (!isGroupType(input.type)) throw new Error(`Unknown heating group type ${input.type}`)
      const facade = requireFacade(deps, input.integrationId)
      const created = await facade.createGroup({ name, type: input.type, members: input.members })
      logWrite('created', input.integrationId, {
        groupId: created.id,
        members: input.members.length,
      })
      const names = new Map(facade.devices().map((device) => [device.address, device.name ?? null]))
      return toGroup(created, names)
    },

    updateHeatingGroup: async (input: {
      integrationId: string
      id: number
      name?: string
      members?: string[]
      confirmed: boolean
    }): Promise<HeatingGroup> => {
      requireConfirmed(input.confirmed)
      const name = input.name?.trim()
      if (name === undefined && input.members === undefined) {
        throw new Error('Nothing to change: give a new name or a member list')
      }
      if (name === '') throw new Error('A heating group needs a name')
      if (input.members?.length === 0) throw new Error('A heating group needs at least one member')
      const facade = requireFacade(deps, input.integrationId)
      const updated = await facade.updateGroup(input.id, {
        ...(name === undefined ? {} : { name }),
        ...(input.members === undefined ? {} : { members: input.members }),
      })
      logWrite('updated', input.integrationId, { groupId: input.id })
      const names = new Map(facade.devices().map((device) => [device.address, device.name ?? null]))
      return toGroup(updated, names)
    },

    deleteHeatingGroup: async (input: {
      integrationId: string
      id: number
      confirmed: boolean
    }): Promise<{ ok: true }> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      await facade.deleteGroup(input.id)
      logWrite('deleted', input.integrationId, { groupId: input.id })
      return { ok: true }
    },
  }
}
