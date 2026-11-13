import type { HmChannel } from 'nodehomematic'
import { hmKeyChannels } from '../devices/hm-key-vocabulary.js'
import { channelIndexFromAddress } from '../devices/hm-cold-start.js'
import { hmName } from '../devices/hm-name.js'
import type { CcuActionDeps, CcuFacade } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import type { CcuDeviceRow, KeyChannelLink } from './ccu-schemas.js'

async function keyChannelRow(
  deps: CcuActionDeps,
  integrationId: string,
  facade: CcuFacade,
  channel: HmChannel,
): Promise<KeyChannelLink> {
  const row = {
    address: channel.address,
    index: channelIndexFromAddress(channel.address) ?? String(channel.index),
    name: hmName(channel.name),
  }
  try {
    const state = await facade.getChannelLinkState(channel.address)
    return { ...row, central: state.central ? 'on' : 'off' }
  } catch (err: unknown) {
    deps.logger.warn('Homematic key channel link state could not be read', {
      meta: { integrationId, address: channel.address, error: errorText(err) },
    })
    return { ...row, central: 'unknown' }
  }
}

/** Key-channel central-link rows for adopted devices. */
export async function keyChannelsForDevice(
  deps: CcuActionDeps,
  integrationId: string,
  device: Parameters<typeof hmKeyChannels>[0] & { readonly address: string },
  adopted: ReadonlySet<string>,
): Promise<readonly KeyChannelLink[]> {
  if (!adopted.has(device.address)) return []
  const keys = hmKeyChannels(device)
  if (keys.length === 0) return []
  const facade = deps.facade(integrationId)
  if (facade === null) return []
  return Promise.all(keys.map((channel) => keyChannelRow(deps, integrationId, facade, channel)))
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
      return { ok: true }
    },
  }
}
