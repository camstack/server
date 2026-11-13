import type { HmChannel } from 'nodehomematic'
import { hmKeyChannels } from '../devices/hm-key-vocabulary.js'
import { channelIndexFromAddress } from '../devices/hm-cold-start.js'
import { hmName } from '../devices/hm-name.js'
import type { CcuActionDeps, CcuFacade } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import type { CcuDeviceRow, KeyChannelLink, KeyDirectLink } from './ccu-schemas.js'
import { channelNameLookup, type HmChannelNames } from './hm-channel-names.js'

/** The channels this key actuates: links where it is the SENDER. */
export function directLinksOfKey(
  keyAddress: string,
  links: readonly { readonly sender: string; readonly receiver: string }[],
  names: (channelAddress: string) => HmChannelNames,
): KeyDirectLink[] {
  return links
    .filter((link) => link.sender === keyAddress)
    .map((link) => {
      const resolved = names(link.receiver)
      return {
        receiver: link.receiver,
        receiverName: resolved.channelName,
        receiverDeviceName: resolved.deviceName,
      }
    })
}

async function keyChannelRow(
  deps: CcuActionDeps,
  integrationId: string,
  facade: CcuFacade,
  names: (channelAddress: string) => HmChannelNames,
  channel: HmChannel,
): Promise<KeyChannelLink> {
  const row = {
    address: channel.address,
    index: channelIndexFromAddress(channel.address) ?? String(channel.index),
    name: hmName(channel.name),
  }
  try {
    const state = await facade.getChannelLinkState(channel.address)
    return {
      ...row,
      central: state.central ? 'on' : 'off',
      links: directLinksOfKey(channel.address, state.links, names),
    }
  } catch (err: unknown) {
    deps.logger.warn('Homematic key channel link state could not be read', {
      meta: { integrationId, address: channel.address, error: errorText(err) },
    })
    return { ...row, central: 'unknown', links: [] }
  }
}

/** Something that can say whether a CCU address is adopted (a set or the id map). */
export interface AdoptedAddressIndex {
  has(address: string): boolean
}

/** Key-channel central-link rows for adopted devices. */
export async function keyChannelsForDevice(
  deps: CcuActionDeps,
  integrationId: string,
  device: Parameters<typeof hmKeyChannels>[0] & { readonly address: string },
  adopted: AdoptedAddressIndex,
): Promise<readonly KeyChannelLink[]> {
  if (!adopted.has(device.address)) return []
  const keys = hmKeyChannels(device)
  if (keys.length === 0) return []
  const facade = deps.facade(integrationId)
  if (facade === null) return []
  const names = channelNameLookup(facade.devices())
  return Promise.all(
    keys.map((channel) => keyChannelRow(deps, integrationId, facade, names, channel)),
  )
}

export function withKeyChannels(
  row: CcuDeviceRow,
  keyChannels: readonly KeyChannelLink[],
): CcuDeviceRow {
  return { ...row, keyChannels: [...keyChannels] }
}

/** Enable or disable the central link of one key channel. Direct links stay. */
export function buildButtonEventHandlers(deps: CcuActionDeps) {
  return {
    setButtonEvents: async (input: {
      readonly integrationId: string
      readonly address: string
      readonly enabled: boolean
      readonly confirmed: boolean
    }): Promise<{ readonly ok: true }> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      try {
        if (input.enabled) await facade.createCentralLink(input.address)
        else await facade.removeCentralLink(input.address)
      } catch (err: unknown) {
        deps.logger.warn('Homematic central link change failed', {
          meta: {
            integrationId: input.integrationId,
            address: input.address,
            enabled: input.enabled,
            error: errorText(err),
          },
        })
        throw err
      }
      deps.ccuChanged(input.integrationId)
      return { ok: true }
    },
  }
}
