import type { IScopedLogger } from '@camstack/types'
import type { HmChannel, HmDevice, Homematic } from 'nodehomematic'
import { directLinksOfKey, isHmipDevice, keyEventProgramName } from '../ccu/ccu-button-events.js'
import { channelNameLookup, type HmChannelNames } from '../ccu/hm-channel-names.js'
import type { HmKeyLinkState } from './hm-button-events-section.js'
import { channelIndexFromAddress } from './hm-cold-start.js'
import { hmKeyChannels } from './hm-key-vocabulary.js'
import { hmName } from './hm-name.js'

/**
 * One snapshot of a device's key-channel central links, shared by the
 * container page and the Buttons child. Both publish through
 * {@link publishKeyLinkStates}; neither keeps a second copy.
 */
const published = new Map<string, readonly HmKeyLinkState[]>()

function storeKey(integrationId: string, address: string): string {
  return `${integrationId}\n${address}`
}

/** The last CCU answer for this device, or nothing when it has not answered. */
export function storedKeyLinkStates(
  integrationId: string | undefined,
  address: string,
): readonly HmKeyLinkState[] {
  if (integrationId === undefined) return []
  return published.get(storeKey(integrationId, address)) ?? []
}

/** Drop every snapshot. Called when the facade registry shuts down. */
export function clearStoredKeyLinkStates(): void {
  published.clear()
}

export type KeyLinkFacade = Pick<
  Homematic,
  'getChannelLinkState' | 'devices' | 'getKeyEventProgram'
>

export interface KeyLinkRead {
  readonly facade: KeyLinkFacade
  readonly device: HmDevice
  readonly deviceAddress: string
  readonly deviceId: number
  readonly logger: IScopedLogger
}

export interface KeyLinkPublishResult {
  readonly failed: boolean
}

interface OneKeyRead {
  readonly state: HmKeyLinkState
  readonly failed: boolean
}

/**
 * Read each key channel's central link from the CCU and publish that list.
 * `null` when the device has no key channel — the previous snapshot stays,
 * because an empty channel list is not evidence the buttons are gone.
 * A failed read is published as `central: null` and `failed: true`.
 */
export async function publishKeyLinkStates(
  integrationId: string,
  read: KeyLinkRead,
): Promise<KeyLinkPublishResult | null> {
  const keys = hmKeyChannels(read.device)
  if (keys.length === 0) return null
  const names = channelNameLookup(read.facade.devices())
  const coverage = await keyEventCoverage(read)
  const states: HmKeyLinkState[] = []
  let failed = false
  for (const channel of keys) {
    const one = await readKey(read, names, channel, coverage.get(channel.address) ?? null)
    if (one.failed) failed = true
    states.push(one.state)
  }
  published.set(storeKey(integrationId, read.deviceAddress), states)
  return { failed }
}

/** Channel address → program name, for keys the device's key-event program covers. */
async function keyEventCoverage(read: KeyLinkRead): Promise<ReadonlyMap<string, string>> {
  if (!isHmipDevice(read.device)) return new Map()
  const name = keyEventProgramName(read.device)
  try {
    const program = await read.facade.getKeyEventProgram(name)
    if (program === null) return new Map()
    return new Map(program.channelAddresses.map((address) => [address, name]))
  } catch (err: unknown) {
    read.logger.warn('Homematic key event program could not be read', {
      tags: { deviceId: read.deviceId },
      meta: {
        address: read.deviceAddress,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return new Map()
  }
}

async function readKey(
  read: KeyLinkRead,
  names: (channelAddress: string) => HmChannelNames,
  channel: HmChannel,
  programName: string | null,
): Promise<OneKeyRead> {
  const base = {
    address: channel.address,
    name: hmName(channel.name),
    index: channelIndexFromAddress(channel.address) ?? String(channel.index),
    programName,
  }
  try {
    const state = await read.facade.getChannelLinkState(channel.address)
    return {
      failed: false,
      state: {
        ...base,
        central: state.central,
        links: directLinksOfKey(channel.address, state.links, names),
      },
    }
  } catch (err: unknown) {
    read.logger.warn('Homematic key channel link state could not be read', {
      tags: { deviceId: read.deviceId },
      meta: {
        address: read.deviceAddress,
        channel: channel.address,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return { failed: true, state: { ...base, central: null, links: [] } }
  }
}
