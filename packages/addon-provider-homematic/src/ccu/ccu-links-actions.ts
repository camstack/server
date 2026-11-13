import type { HmDevice, HmLink, HmLinkProfile } from 'nodehomematic'
import type { z } from 'zod'
import type { CcuActionDeps, CcuFacade } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import type {
  CcuLink,
  CcuLinksResult,
  IntegrationRefSchema,
  LinkEndpoint,
  LinkProfile,
  LinkProfileInputSchema,
  LinkReadFailure,
  LinkRefInputSchema,
  OkResultSchema,
} from './ccu-schemas.js'
import { channelNameLookup } from './hm-channel-names.js'
import { hmName } from '../devices/hm-name.js'

/** The channel roles a link the page creates may join: a key, then a switch actuator. */
const SENDER_TYPE = 'KEY_TRANSCEIVER'
const RECEIVER_TYPE = 'SWITCH_VIRTUAL_RECEIVER'

type IntegrationRef = z.infer<typeof IntegrationRefSchema>
type LinkRefInput = z.infer<typeof LinkRefInputSchema>
type LinkProfileInput = z.infer<typeof LinkProfileInputSchema>
type OkResult = z.infer<typeof OkResultSchema>

function endpointsOfType(devices: readonly HmDevice[], type: string): LinkEndpoint[] {
  return devices.flatMap((device) =>
    device.channels
      .filter((channel) => channel.type === type)
      .map((channel) => ({
        address: channel.address,
        name: hmName(channel.name),
        deviceName: hmName(device.name),
        deviceType: device.type,
      })),
  )
}

function toProfile(profile: HmLinkProfile | null): LinkProfile {
  if (profile === null) return null
  if (profile.kind === 'custom') return { kind: 'custom' }
  return { kind: 'switch', short: profile.short, long: profile.long }
}

function channelType(devices: readonly HmDevice[], address: string): string | undefined {
  for (const device of devices) {
    const channel = device.channels.find((candidate) => candidate.address === address)
    if (channel !== undefined) return channel.type
  }
  return undefined
}

/**
 * Every direct link of the CCU, read device by device. A link is reported by
 * both its sender and its receiver device, so it is kept once per
 * sender → receiver pair. A device whose links could not be read is named in
 * `failures`: a partial list never reads as the whole one.
 */
async function readAllLinks(
  facade: CcuFacade,
  devices: readonly HmDevice[],
): Promise<{ readonly links: HmLink[]; readonly failures: LinkReadFailure[] }> {
  const seen = new Set<string>()
  const links: HmLink[] = []
  const failures: LinkReadFailure[] = []
  for (const device of devices) {
    try {
      for (const link of await facade.listLinks(device.address)) {
        const key = `${link.sender}>${link.receiver}`
        if (seen.has(key)) continue
        seen.add(key)
        links.push(link)
      }
    } catch (err) {
      failures.push({
        address: device.address,
        deviceName: hmName(device.name),
        error: errorText(err),
      })
    }
  }
  return { links, failures }
}

/** The Links tab: the CCU's direct links, and the key → switch link writes. */
export function buildCcuLinkHandlers(deps: CcuActionDeps) {
  const logWrite = (what: string, input: LinkRefInput, extra: Record<string, unknown> = {}) => {
    deps.logger.info(`Homematic: direct link ${what}`, {
      meta: {
        integrationId: input.integrationId,
        sender: input.sender,
        receiver: input.receiver,
        ...extra,
      },
    })
  }

  return {
    listCcuLinks: async (input: IntegrationRef): Promise<CcuLinksResult> => {
      const facade = requireFacade(deps, input.integrationId)
      const devices = facade.devices()
      const names = channelNameLookup(devices)
      const endpoint = (address: string): LinkEndpoint => {
        const found = names(address)
        return {
          address,
          name: found.channelName,
          deviceName: found.deviceName,
          deviceType: found.deviceType,
        }
      }
      const { links, failures } = await readAllLinks(facade, devices)
      if (failures.length > 0) {
        deps.logger.warn('Homematic: direct links of some devices could not be read', {
          meta: { integrationId: input.integrationId, failures },
        })
      }
      const rows: CcuLink[] = links.map((link) => ({
        sender: endpoint(link.sender),
        receiver: endpoint(link.receiver),
        name: link.name,
        description: link.description,
        profile: toProfile(link.profile),
      }))
      return {
        links: rows,
        senders: endpointsOfType(devices, SENDER_TYPE),
        receivers: endpointsOfType(devices, RECEIVER_TYPE),
        failures,
      }
    },

    createCcuLink: async (input: LinkProfileInput): Promise<OkResult> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      const devices = facade.devices()
      if (channelType(devices, input.sender) !== SENDER_TYPE) {
        throw new Error(`${input.sender} is not a key channel (${SENDER_TYPE})`)
      }
      if (channelType(devices, input.receiver) !== RECEIVER_TYPE) {
        throw new Error(`${input.receiver} is not a switch actuator channel (${RECEIVER_TYPE})`)
      }
      await facade.addLink(input.sender, input.receiver)
      logWrite('created', input)
      deps.ccuChanged(input.integrationId)
      try {
        await facade.setLinkProfile(input.sender, input.receiver, {
          short: input.short,
          long: input.long,
        })
      } catch (err) {
        deps.logger.warn('Homematic: direct link created, its profile was not written', {
          meta: {
            integrationId: input.integrationId,
            sender: input.sender,
            receiver: input.receiver,
            error: errorText(err),
          },
        })
        throw new Error(
          `The link was created, but its profile could not be written: ${errorText(err)}`,
        )
      }
      logWrite('profile written', input, { short: input.short, long: input.long })
      return { ok: true }
    },

    setCcuLinkProfile: async (input: LinkProfileInput): Promise<OkResult> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      await facade.setLinkProfile(input.sender, input.receiver, {
        short: input.short,
        long: input.long,
      })
      logWrite('profile written', input, { short: input.short, long: input.long })
      deps.ccuChanged(input.integrationId)
      return { ok: true }
    },

    deleteCcuLink: async (input: LinkRefInput): Promise<OkResult> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      await facade.removeLink(input.sender, input.receiver)
      logWrite('deleted', input)
      deps.ccuChanged(input.integrationId)
      return { ok: true }
    },
  }
}
