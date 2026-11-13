import type { HmChannel, HmDevice } from 'nodehomematic'
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

/** A HmIP device sends presses only while a CCU program uses the key (a central link is not enough). */
export function isHmipDevice(device: Pick<HmDevice, 'type'>): boolean {
  return /^hmip/i.test(device.type)
}

/** The one CCU program that carries a device's key events. It is found by this name; nothing else is stored. */
export function keyEventProgramName(device: Pick<HmDevice, 'address' | 'name'>): string {
  return `CamStack: ${hmName(device.name) ?? device.address} events`
}

function deviceAddressOf(channelAddress: string): string {
  const colon = channelAddress.lastIndexOf(':')
  return colon === -1 ? channelAddress : channelAddress.slice(0, colon)
}

/**
 * The key channels the device's program listens to: an empty set when there is
 * no program, `null` when the read failed (the row then says `unknown`).
 */
async function programChannelsOf(
  deps: CcuActionDeps,
  integrationId: string,
  facade: CcuFacade,
  device: Pick<HmDevice, 'address' | 'name'>,
  deviceId: number | undefined,
): Promise<ReadonlySet<string> | null> {
  try {
    const program = await facade.getKeyEventProgram(keyEventProgramName(device))
    return new Set(program?.channelAddresses ?? [])
  } catch (err: unknown) {
    deps.logger.warn('Homematic key event program could not be read', {
      ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
      meta: { integrationId, address: device.address, error: errorText(err) },
    })
    return null
  }
}

async function keyChannelRow(
  deps: CcuActionDeps,
  integrationId: string,
  facade: CcuFacade,
  names: (channelAddress: string) => HmChannelNames,
  channel: HmChannel,
  /** Present for a HmIP device: the channels its program covers (`null` = unread). */
  programChannels?: ReadonlySet<string> | null,
): Promise<KeyChannelLink> {
  const row = {
    address: channel.address,
    index: channelIndexFromAddress(channel.address) ?? String(channel.index),
    name: hmName(channel.name),
  }
  try {
    const state = await facade.getChannelLinkState(channel.address)
    if (programChannels === null) return { ...row, central: 'unknown', links: [] }
    const covered = programChannels === undefined || programChannels.has(channel.address)
    return {
      ...row,
      central: state.central && covered ? 'on' : 'off',
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
  device: Parameters<typeof hmKeyChannels>[0] &
    Pick<HmDevice, 'type' | 'name'> & { readonly address: string },
  adopted: AdoptedAddressIndex,
): Promise<readonly KeyChannelLink[]> {
  if (!adopted.has(device.address)) return []
  const keys = hmKeyChannels(device)
  if (keys.length === 0) return []
  const facade = deps.facade(integrationId)
  if (facade === null) return []
  const names = channelNameLookup(facade.devices())
  const programChannels = isHmipDevice(device)
    ? await programChannelsOf(
        deps,
        integrationId,
        facade,
        device,
        (await deps.adoptedAddresses(integrationId)).get(device.address),
      )
    : undefined
  return Promise.all(
    keys.map((channel) =>
      keyChannelRow(deps, integrationId, facade, names, channel, programChannels),
    ),
  )
}

export function withKeyChannels(
  row: CcuDeviceRow,
  keyChannels: readonly KeyChannelLink[],
): CcuDeviceRow {
  return { ...row, keyChannels: [...keyChannels] }
}

/**
 * Enable or disable the events of one key channel. Direct links stay. A HmIP
 * key also needs a CCU program that uses it (one per device, found by name):
 * enabling puts the channel in it, disabling takes it out and deletes the
 * program when it was the last key.
 */
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
      const deviceAddress = deviceAddressOf(input.address)
      const device = facade.devices().find((candidate) => candidate.address === deviceAddress)
      const deviceId = (await deps.adoptedAddresses(input.integrationId)).get(deviceAddress)
      const tags = deviceId !== undefined ? { tags: { deviceId } } : {}
      try {
        if (input.enabled) await facade.createCentralLink(input.address)
        else await facade.removeCentralLink(input.address)
        if (device !== undefined && isHmipDevice(device)) {
          await syncKeyEventProgram(deps, facade, device, input.address, input.enabled, tags)
        }
      } catch (err: unknown) {
        deps.logger.warn('Homematic button events change failed', {
          ...tags,
          meta: {
            integrationId: input.integrationId,
            address: input.address,
            enabled: input.enabled,
            error: errorText(err),
          },
        })
        throw err
      }
      deps.logger.info(`Homematic: button events ${input.enabled ? 'enabled' : 'disabled'}`, {
        ...tags,
        meta: { integrationId: input.integrationId, address: input.address },
      })
      deps.ccuChanged(input.integrationId)
      return { ok: true }
    },
  }
}

/** Put the channel in the device's key event program, or take it out (deleting an emptied program). */
async function syncKeyEventProgram(
  deps: CcuActionDeps,
  facade: CcuFacade,
  device: Pick<HmDevice, 'address' | 'name'>,
  channelAddress: string,
  enabled: boolean,
  tags: { readonly tags?: { readonly deviceId: number } },
): Promise<void> {
  const name = keyEventProgramName(device)
  const current = (await facade.getKeyEventProgram(name))?.channelAddresses ?? []
  const wanted = enabled
    ? [...new Set([...current, channelAddress])]
    : current.filter((address) => address !== channelAddress)
  if (wanted.length === 0) {
    const { removed } = await facade.removeKeyEventProgram(name)
    deps.logger.info('Homematic: key event program removed', {
      ...tags,
      meta: { program: name, removed },
    })
    return
  }
  const { programId, created } = await facade.ensureKeyEventProgram({
    name,
    channelAddresses: wanted,
  })
  deps.logger.info(`Homematic: key event program ${created ? 'created' : 'updated'}`, {
    ...tags,
    meta: { program: name, programId, channels: wanted },
  })
}
