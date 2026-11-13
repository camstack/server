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
      {
        address: `${ADDRESS}:1`,
        index: 1,
        type: 'KEY_TRANSCEIVER',
        name: 'Sinistra',
      },
      {
        address: `${ADDRESS}:4`,
        index: 4,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        name: 'Luce',
      },
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
      getKeyEventProgram: async () => null,
    })
    const handlers = buildCcuDevicesHandlers({
      ...deps,
      adoptedAddresses: async () => new Map([[ADDRESS, 7]]),
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
      adoptedAddresses: async () => new Map([[ADDRESS, 7]]),
    })
    const out = await handlers.listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices[0]?.keyChannels[0]?.central).toBe('unknown')
    expect(out.devices[0]?.keyChannels[0]?.links).toEqual([])
  })

  it('omits key channels for a device that is not adopted', async () => {
    const { deps } = fakeDeps({
      devices: () => [keyDevice()],
      getChannelLinkState: linkState(true),
      getKeyEventProgram: async () => null,
    })
    const out = await buildCcuDevicesHandlers(deps).listCcuDevices({
      integrationId: 'hm_1',
    })
    expect(out.devices[0]?.keyChannels).toEqual([])
  })
})

function adoptedDeps(facade: Parameters<typeof fakeDeps>[0]) {
  const { deps, logger } = fakeDeps(facade)
  return {
    deps: { ...deps, adoptedAddresses: async () => new Map([[ADDRESS, 7]]) },
    logger,
  }
}

const PROGRAM = 'CamStack: Pulsante bagno camerette events'

describe('HmIP key events need a CCU program', () => {
  it('reports a central link without the program as off, with it as on', async () => {
    for (const [covered, expected] of [
      [[], 'off'],
      [[`${ADDRESS}:1`], 'on'],
    ] as const) {
      const { deps } = adoptedDeps({
        devices: () => [keyDevice()],
        getChannelLinkState: linkState(true),
        getKeyEventProgram: async () => ({
          programId: '9',
          channelAddresses: [...covered],
        }),
      })
      const out = await buildCcuDevicesHandlers(deps).listCcuDevices({
        integrationId: 'hm_1',
      })
      expect(out.devices[0]?.keyChannels[0]?.central).toBe(expected)
    }
  })

  it('reports off when the program is missing, unknown when it cannot be read', async () => {
    const missing = adoptedDeps({
      devices: () => [keyDevice()],
      getChannelLinkState: linkState(true),
      getKeyEventProgram: async () => null,
    })
    expect(
      (
        await buildCcuDevicesHandlers(missing.deps).listCcuDevices({
          integrationId: 'hm_1',
        })
      ).devices[0]?.keyChannels[0]?.central,
    ).toBe('off')
    const broken = adoptedDeps({
      devices: () => [keyDevice()],
      getChannelLinkState: linkState(true),
      getKeyEventProgram: async () => {
        throw new Error('ReGa fault')
      },
    })
    expect(
      (
        await buildCcuDevicesHandlers(broken.deps).listCcuDevices({
          integrationId: 'hm_1',
        })
      ).devices[0]?.keyChannels[0]?.central,
    ).toBe('unknown')
  })

  it('enabling creates the device program with the channel and logs the device id', async () => {
    const ensured: unknown[] = []
    const { deps, logger } = adoptedDeps({
      devices: () => [keyDevice()],
      createCentralLink: async () => undefined,
      getKeyEventProgram: async () => null,
      ensureKeyEventProgram: async (input) => {
        ensured.push(input)
        return { programId: '55', created: true }
      },
    })
    await buildButtonEventHandlers(deps).setButtonEvents({
      integrationId: 'hm_1',
      address: `${ADDRESS}:1`,
      enabled: true,
      confirmed: true,
    })
    expect(ensured).toEqual([{ name: PROGRAM, channelAddresses: [`${ADDRESS}:1`] }])
    const written = logger.lines.filter((line) => line.level === 'info')
    expect(written.length).toBeGreaterThan(0)
    expect(written.every((line) => line.tags['deviceId'] === 7)).toBe(true)
  })

  it('enabling a second key keeps the first in the program', async () => {
    const ensured: unknown[] = []
    const { deps } = adoptedDeps({
      devices: () => [keyDevice()],
      createCentralLink: async () => undefined,
      getKeyEventProgram: async () => ({
        programId: '55',
        channelAddresses: [`${ADDRESS}:1`],
      }),
      ensureKeyEventProgram: async (input) => {
        ensured.push(input)
        return { programId: '55', created: false }
      },
    })
    await buildButtonEventHandlers(deps).setButtonEvents({
      integrationId: 'hm_1',
      address: `${ADDRESS}:2`,
      enabled: true,
      confirmed: true,
    })
    expect(ensured).toEqual([{ name: PROGRAM, channelAddresses: [`${ADDRESS}:1`, `${ADDRESS}:2`] }])
  })

  it('disabling one of two keys rewrites the program; the last key deletes it', async () => {
    const ensured: unknown[] = []
    const removed: string[] = []
    let covered = [`${ADDRESS}:1`, `${ADDRESS}:2`]
    const { deps } = adoptedDeps({
      devices: () => [keyDevice()],
      removeCentralLink: async () => undefined,
      getKeyEventProgram: async () => ({
        programId: '55',
        channelAddresses: covered,
      }),
      ensureKeyEventProgram: async (input) => {
        ensured.push(input)
        return { programId: '55', created: false }
      },
      removeKeyEventProgram: async (name) => {
        removed.push(name)
        return { removed: true }
      },
    })
    const handlers = buildButtonEventHandlers(deps)
    await handlers.setButtonEvents({
      integrationId: 'hm_1',
      address: `${ADDRESS}:2`,
      enabled: false,
      confirmed: true,
    })
    expect(ensured).toEqual([{ name: PROGRAM, channelAddresses: [`${ADDRESS}:1`] }])
    expect(removed).toEqual([])
    covered = [`${ADDRESS}:1`]
    await handlers.setButtonEvents({
      integrationId: 'hm_1',
      address: `${ADDRESS}:1`,
      enabled: false,
      confirmed: true,
    })
    expect(removed).toEqual([PROGRAM])
    expect(ensured).toHaveLength(1)
  })

  it('a BidCos key never touches programs', async () => {
    const touched: string[] = []
    const bidcos = hmDevice({
      address: 'NEQ0000001',
      type: 'HM-RC-4-2',
      name: 'Remote',
      channels: [{ address: 'NEQ0000001:1', index: 1, type: 'KEY', name: 'K' }],
    })
    const { deps } = adoptedDeps({
      devices: () => [bidcos],
      createCentralLink: async () => undefined,
      removeCentralLink: async () => undefined,
      getKeyEventProgram: async () => {
        touched.push('get')
        return null
      },
      ensureKeyEventProgram: async () => {
        touched.push('ensure')
        return { programId: '1', created: true }
      },
      removeKeyEventProgram: async () => {
        touched.push('remove')
        return { removed: false }
      },
    })
    const handlers = buildButtonEventHandlers(deps)
    for (const enabled of [true, false]) {
      await handlers.setButtonEvents({
        integrationId: 'hm_1',
        address: 'NEQ0000001:1',
        enabled,
        confirmed: true,
      })
    }
    expect(touched).toEqual([])
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
