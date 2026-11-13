import { describe, expect, it } from 'vitest'
import type { HmChannelLinkState } from 'nodehomematic'
import { buildCcuDevicesHandlers } from '../ccu/ccu-devices-actions.js'
import { buildButtonEventHandlers } from '../ccu/ccu-button-events.js'
import { hmName } from '../devices/hm-name.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDevice } from './hm-test-fixtures.js'

const ADDRESS = '00315F298E5093'

function keyDevice() {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-BS2',
    name: 'Pulsante bagno camerette',
    channels: [
      { address: `${ADDRESS}:1`, index: 1, type: 'KEY_TRANSCEIVER', name: 'Sinistra' },
      { address: `${ADDRESS}:4`, index: 4, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Luce' },
    ],
  })
}

function linkState(central: boolean): () => Promise<HmChannelLinkState> {
  return async () => ({
    central,
    links: [
      { sender: `${ADDRESS}:1`, receiver: `${ADDRESS}:4`, name: '' },
      // A link where this key is the RECEIVER actuates nothing from it.
      { sender: 'OTHER:1', receiver: `${ADDRESS}:1`, name: '' },
    ],
  })
}

describe('hmName', () => {
  it('keeps a CCU name and treats blank as none', () => {
    expect(hmName('Sinistra')).toBe('Sinistra')
    expect(hmName('  ')).toBeNull()
    expect(hmName(null)).toBeNull()
  })
})

describe('button events on the device list', () => {
  it('reports central-link state and the actuated channels for an adopted device with key channels', async () => {
    const { deps } = fakeDeps({
      devices: () => [keyDevice()],
      getChannelLinkState: linkState(false),
    })
    const handlers = buildCcuDevicesHandlers({
      ...deps,
      adoptedAddresses: async () => new Set([ADDRESS]),
    })
    const out = await handlers.listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices[0]?.keyChannels).toEqual([
      {
        address: `${ADDRESS}:1`,
        index: '1',
        name: 'Sinistra',
        central: 'off',
        links: [
          {
            receiver: `${ADDRESS}:4`,
            receiverName: 'Luce',
            receiverDeviceName: 'Pulsante bagno camerette',
          },
        ],
      },
    ])
  })

  it('reports a failed read as unknown, never as off', async () => {
    const { deps } = fakeDeps({
      devices: () => [keyDevice()],
      getChannelLinkState: async () => {
        throw new Error('XML-RPC fault')
      },
    })
    const handlers = buildCcuDevicesHandlers({
      ...deps,
      adoptedAddresses: async () => new Set([ADDRESS]),
    })
    const out = await handlers.listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices[0]?.keyChannels[0]?.central).toBe('unknown')
    expect(out.devices[0]?.keyChannels[0]?.links).toEqual([])
  })

  it('omits key channels for a device that is not adopted', async () => {
    const { deps } = fakeDeps({
      devices: () => [keyDevice()],
      getChannelLinkState: linkState(true),
    })
    const out = await buildCcuDevicesHandlers(deps).listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices[0]?.keyChannels).toEqual([])
  })
})

describe('setButtonEvents', () => {
  it('keeps the confirmation gate', async () => {
    const { deps } = fakeDeps({ devices: () => [] })
    await expect(
      buildButtonEventHandlers(deps).setButtonEvents({
        integrationId: 'hm_1',
        address: `${ADDRESS}:1`,
        enabled: false,
        confirmed: false,
      }),
    ).rejects.toThrow(/confirmed/)
  })

  it('creates the central link on the facade and never touches direct links', async () => {
    const created: string[] = []
    const removedLinks: string[] = []
    const { deps } = fakeDeps({
      devices: () => [],
      createCentralLink: async (address) => {
        created.push(address)
      },
      removeLink: async (sender) => {
        removedLinks.push(sender)
      },
    })
    const changed: string[] = []
    await buildButtonEventHandlers({
      ...deps,
      ccuChanged: (id) => changed.push(id),
    }).setButtonEvents({
      integrationId: 'hm_1',
      address: `${ADDRESS}:1`,
      enabled: true,
      confirmed: true,
    })
    expect(created).toEqual([`${ADDRESS}:1`])
    expect(changed).toEqual(['hm_1'])
    expect(removedLinks).toEqual([])
  })

  it('removes the central link and surfaces a CCU refusal with the device address logged', async () => {
    const { deps, logger } = fakeDeps({
      devices: () => [],
      removeCentralLink: async () => {
        throw new Error('reportValueUsage refused')
      },
    })
    await expect(
      buildButtonEventHandlers(deps).setButtonEvents({
        integrationId: 'hm_1',
        address: `${ADDRESS}:1`,
        enabled: false,
        confirmed: true,
      }),
    ).rejects.toThrow(/reportValueUsage refused/)
    expect(logger.lines.some((e) => e.level === 'warn')).toBe(true)
  })
})
