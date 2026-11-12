import { describe, expect, it } from 'vitest'
import type { HmChannel, HmDevice } from 'nodehomematic'
import { buildCcuDevicesHandlers } from '../ccu/ccu-devices-actions.js'
import { buildButtonEventHandlers } from '../ccu/ccu-button-events.js'
import { channelLinkPort, readHmName, type HmChannelLinkPort } from '../ccu/hm-channel-links.js'
import { fakeDeps } from './ccu-fake.js'

const ADDRESS = '00315F298E5093'

function keyDevice(): HmDevice {
  const device = {
    address: ADDRESS,
    type: 'HmIP-BS2',
    name: 'Pulsante bagno camerette',
    channels: [
      {
        address: `${ADDRESS}:1`,
        index: 1,
        type: 'KEY_TRANSCEIVER',
        dataPoints: [],
        name: 'Sinistra',
      },
      { address: `${ADDRESS}:4`, index: 4, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
    ],
  }
  // `name` on a channel is the 0.6 field. The 0.5.1 channel type omits it.
  return device as unknown as HmDevice
}

function port(central: boolean): HmChannelLinkPort {
  return {
    getChannelLinkState: async () => ({
      kind: 'ok',
      state: { central, links: [{ sender: `${ADDRESS}:1`, receiver: 'CENTRAL', name: 'central' }] },
    }),
    createCentralLink: async () => ({ kind: 'ok' }),
    removeCentralLink: async () => ({ kind: 'ok' }),
  }
}

describe('channelLinkPort', () => {
  it('reports unsupported when the installed library has no link methods', async () => {
    const links = channelLinkPort({})
    expect(await links.getChannelLinkState(`${ADDRESS}:1`)).toEqual({ kind: 'unsupported' })
    expect(await links.createCentralLink(`${ADDRESS}:1`)).toEqual({ kind: 'unsupported' })
    expect(await links.removeCentralLink(`${ADDRESS}:1`)).toEqual({ kind: 'unsupported' })
  })

  it('reads a central link and surfaces a thrown remove as an error', async () => {
    const links = channelLinkPort({
      getChannelLinkState: async () => ({ central: false, links: [] }),
      createCentralLink: async () => undefined,
      removeCentralLink: async () => {
        throw new Error('CCU refused the link')
      },
    })
    expect(await links.getChannelLinkState(`${ADDRESS}:1`)).toEqual({
      kind: 'ok',
      state: { central: false, links: [] },
    })
    expect(await links.createCentralLink(`${ADDRESS}:1`)).toEqual({ kind: 'ok' })
    expect(await links.removeCentralLink(`${ADDRESS}:1`)).toEqual({
      kind: 'error',
      message: 'CCU refused the link',
    })
  })

  it('reads a channel name only when the facade carries one', () => {
    const named = keyDevice().channels[0]
    if (named === undefined) throw new Error('fixture')
    expect(readHmName(named)).toBe('Sinistra')
    const bare: HmChannel = {
      address: `${ADDRESS}:2`,
      index: 2,
      type: 'KEY_TRANSCEIVER',
      dataPoints: [],
    }
    expect(readHmName(bare)).toBeNull()
    expect(readHmName({ name: '  ' })).toBeNull()
  })
})

describe('button events on the device list', () => {
  it('reports central-link state only for an adopted device with key channels', async () => {
    const { deps } = fakeDeps({ devices: () => [keyDevice()] })
    const handlers = buildCcuDevicesHandlers({
      ...deps,
      adoptedAddresses: async () => new Set([ADDRESS]),
      channelLinks: () => port(false),
    })
    const out = await handlers.listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices[0]?.keyChannels).toEqual([
      { address: `${ADDRESS}:1`, index: '1', name: 'Sinistra', central: 'off' },
    ])
  })

  it('omits key channels for a device that is not adopted', async () => {
    const { deps } = fakeDeps({ devices: () => [keyDevice()] })
    const handlers = buildCcuDevicesHandlers({
      ...deps,
      channelLinks: () => port(true),
    })
    const out = await handlers.listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices[0]?.keyChannels).toEqual([])
  })

  it('refuses a central-link write the library cannot do, and keeps the confirmation gate', async () => {
    const { deps } = fakeDeps({ devices: () => [] })
    const handlers = buildButtonEventHandlers({
      ...deps,
      channelLinks: () => channelLinkPort({}),
    })
    await expect(
      handlers.setButtonEvents({
        integrationId: 'hm_1',
        address: `${ADDRESS}:1`,
        enabled: true,
        confirmed: true,
      }),
    ).rejects.toThrow(/cannot read or change central links/)
    await expect(
      handlers.setButtonEvents({
        integrationId: 'hm_1',
        address: `${ADDRESS}:1`,
        enabled: false,
        confirmed: false,
      }),
    ).rejects.toThrow(/confirmed/)
  })

  it('creates the central link and does not ask the port to drop direct links', async () => {
    const created: string[] = []
    const { deps } = fakeDeps({ devices: () => [] })
    const handlers = buildButtonEventHandlers({
      ...deps,
      channelLinks: () => ({
        getChannelLinkState: async () => ({ kind: 'ok', state: { central: false, links: [] } }),
        createCentralLink: async (address) => {
          created.push(address)
          return { kind: 'ok' }
        },
        removeCentralLink: async () => ({ kind: 'ok' }),
      }),
    })
    await handlers.setButtonEvents({
      integrationId: 'hm_1',
      address: `${ADDRESS}:1`,
      enabled: true,
      confirmed: true,
    })
    expect(created).toEqual([`${ADDRESS}:1`])
  })
})
