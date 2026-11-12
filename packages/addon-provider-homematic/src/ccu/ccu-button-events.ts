import type { HmChannel } from 'nodehomematic'
import { hmKeyChannels } from '../devices/hm-key-vocabulary.js'
import { channelIndexFromAddress } from '../devices/hm-cold-start.js'
import type { CcuActionDeps } from './ccu-facade.js'
import { requireConfirmed, requireFacade } from './ccu-facade.js'
import { readHmName, type HmChannelLinkPort } from './hm-channel-links.js'
import type { CcuDeviceRow, KeyChannelLink } from './ccu-schemas.js'

const UNSUPPORTED = 'This CCU library cannot read or change central links yet'

function centralOf(
  read: Awaited<ReturnType<HmChannelLinkPort['getChannelLinkState']>>,
): KeyChannelLink['central'] {
  if (read.kind === 'unsupported') return 'unsupported'
  if (read.kind === 'error') return 'unknown'
  return read.state.central ? 'on' : 'off'
}

async function keyChannelRow(port: HmChannelLinkPort, channel: HmChannel): Promise<KeyChannelLink> {
  const read = await port.getChannelLinkState(channel.address)
  return {
    address: channel.address,
    index: channelIndexFromAddress(channel.address) ?? String(channel.index),
    name: readHmName(channel),
    central: centralOf(read),
  }
}

/** Key-channel central-link rows for adopted devices. Direct links are not touched. */
export async function keyChannelsForDevice(
  deps: CcuActionDeps,
  integrationId: string,
  device: Parameters<typeof hmKeyChannels>[0] & { readonly address: string },
  adopted: ReadonlySet<string>,
): Promise<readonly KeyChannelLink[]> {
  if (!adopted.has(device.address)) return []
  const keys = hmKeyChannels(device)
  if (keys.length === 0) return []
  const port = deps.channelLinks(integrationId)
  if (port === null) return []
  return Promise.all(keys.map((channel) => keyChannelRow(port, channel)))
}

export function withKeyChannels(
  row: CcuDeviceRow,
  keyChannels: readonly KeyChannelLink[],
): CcuDeviceRow {
  return { ...row, keyChannels: [...keyChannels] }
}

/** Enable or disable the central link of one key channel. Other links stay. */
export function buildButtonEventHandlers(deps: CcuActionDeps) {
  return {
    setButtonEvents: async (input: {
      readonly integrationId: string
      readonly address: string
      readonly enabled: boolean
      readonly confirmed: boolean
    }): Promise<{ readonly ok: true }> => {
      requireConfirmed(input.confirmed)
      requireFacade(deps, input.integrationId)
      const port = deps.channelLinks(input.integrationId)
      if (port === null) throw new Error(UNSUPPORTED)
      const result = input.enabled
        ? await port.createCentralLink(input.address)
        : await port.removeCentralLink(input.address)
      if (result.kind === 'unsupported') throw new Error(UNSUPPORTED)
      if (result.kind === 'error') {
        deps.logger.warn('Homematic central link change failed', {
          meta: {
            integrationId: input.integrationId,
            address: input.address,
            error: result.message,
          },
        })
        throw new Error(result.message)
      }
      return { ok: true }
    },
  }
}
