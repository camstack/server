import { describe, expect, it, vi } from 'vitest'
import type { HmLink } from 'nodehomematic'
import { buildCcuLinkHandlers } from '../ccu/ccu-links-actions.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDevice } from './hm-test-fixtures.js'

const KEY = '00315F298E5093'
const LAMP = '0001D3C99C2F10'

function devices() {
  return [
    hmDevice({
      address: KEY,
      type: 'HmIP-BS2',
      name: 'Pulsante bagno',
      channels: [
        { address: `${KEY}:1`, index: 1, type: 'KEY_TRANSCEIVER', name: 'Sinistra' },
        { address: `${KEY}:2`, index: 2, type: 'KEY_TRANSCEIVER' },
        { address: `${KEY}:4`, index: 4, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Luce' },
      ],
    }),
    hmDevice({
      address: LAMP,
      type: 'HmIP-PS',
      name: 'Lampada',
      channels: [{ address: `${LAMP}:3`, index: 3, type: 'SWITCH_VIRTUAL_RECEIVER' }],
    }),
  ]
}

const KEY1_TO_LAMP: HmLink = {
  sender: `${KEY}:1`,
  receiver: `${LAMP}:3`,
  name: 'bagno',
  description: '',
  profile: { kind: 'switch', short: 'toggle', long: 'none' },
}

describe('listCcuLinks', () => {
  it('lists every link once with CCU names, the candidates, and names a device that could not be read', async () => {
    const listLinks = vi.fn(async (address: string): Promise<HmLink[]> => {
      // The sender device and the receiver device both report the same link.
      if (address === KEY || address === LAMP) return [KEY1_TO_LAMP]
      throw new Error('getLinks fault')
    })
    const { deps } = fakeDeps({
      devices: () => [
        ...devices(),
        hmDevice({ address: 'BROKEN', type: 'HmIP-X', name: 'Rotto', channels: [] }),
      ],
      listLinks,
    })
    const out = await buildCcuLinkHandlers(deps).listCcuLinks({ integrationId: 'hm_1' })
    expect(out.links).toEqual([
      {
        sender: {
          address: `${KEY}:1`,
          name: 'Sinistra',
          deviceName: 'Pulsante bagno',
          deviceType: 'HmIP-BS2',
        },
        receiver: {
          address: `${LAMP}:3`,
          name: null,
          deviceName: 'Lampada',
          deviceType: 'HmIP-PS',
        },
        name: 'bagno',
        description: '',
        profile: { kind: 'switch', short: 'toggle', long: 'none' },
      },
    ])
    expect(out.senders.map((s) => s.address)).toEqual([`${KEY}:1`, `${KEY}:2`])
    expect(out.receivers.map((r) => r.address)).toEqual([`${KEY}:4`, `${LAMP}:3`])
    expect(out.failures).toEqual([
      { address: 'BROKEN', deviceName: 'Rotto', error: 'getLinks fault' },
    ])
  })
})

describe('link writes', () => {
  it('creates a key → switch link and writes its profile, only once confirmed', async () => {
    const addLink = vi.fn(async () => undefined)
    const setLinkProfile = vi.fn(async () => undefined)
    const changed = vi.fn()
    const { deps } = fakeDeps({ devices: devices, addLink, setLinkProfile })
    const handlers = buildCcuLinkHandlers({ ...deps, ccuChanged: changed })
    const input = {
      integrationId: 'hm_1',
      sender: `${KEY}:1`,
      receiver: `${LAMP}:3`,
      short: 'on' as const,
      long: 'off' as const,
    }
    await expect(handlers.createCcuLink({ ...input, confirmed: false })).rejects.toThrow(
      /confirmation/,
    )
    expect(addLink).not.toHaveBeenCalled()

    await expect(handlers.createCcuLink({ ...input, confirmed: true })).resolves.toEqual({
      ok: true,
    })
    expect(addLink).toHaveBeenCalledWith(`${KEY}:1`, `${LAMP}:3`)
    expect(setLinkProfile).toHaveBeenCalledWith(`${KEY}:1`, `${LAMP}:3`, {
      short: 'on',
      long: 'off',
    })
    expect(changed).toHaveBeenCalledWith('hm_1')
  })

  it('refuses a link that is not key channel → switch actuator channel, before any write', async () => {
    const addLink = vi.fn(async () => undefined)
    const { deps } = fakeDeps({ devices: devices, addLink })
    const handlers = buildCcuLinkHandlers(deps)
    await expect(
      handlers.createCcuLink({
        integrationId: 'hm_1',
        sender: `${KEY}:4`,
        receiver: `${LAMP}:3`,
        short: 'toggle',
        long: 'toggle',
        confirmed: true,
      }),
    ).rejects.toThrow(/key channel/)
    await expect(
      handlers.createCcuLink({
        integrationId: 'hm_1',
        sender: `${KEY}:1`,
        receiver: `${KEY}:2`,
        short: 'toggle',
        long: 'toggle',
        confirmed: true,
      }),
    ).rejects.toThrow(/switch actuator/)
    expect(addLink).not.toHaveBeenCalled()
  })

  it('names a link that was created but whose profile could not be written', async () => {
    const { deps, logger } = fakeDeps({
      devices: devices,
      addLink: async () => undefined,
      setLinkProfile: async () => {
        throw new Error('custom profile')
      },
    })
    await expect(
      buildCcuLinkHandlers(deps).createCcuLink({
        integrationId: 'hm_1',
        sender: `${KEY}:1`,
        receiver: `${LAMP}:3`,
        short: 'on',
        long: 'on',
        confirmed: true,
      }),
    ).rejects.toThrow(/link was created.*custom profile/)
    expect(logger.lines.some((e) => e.level === 'warn')).toBe(true)
  })

  it('edits a profile and deletes a link, each only once confirmed', async () => {
    const setLinkProfile = vi.fn(async () => undefined)
    const removeLink = vi.fn(async () => undefined)
    const { deps } = fakeDeps({ devices: devices, setLinkProfile, removeLink })
    const handlers = buildCcuLinkHandlers(deps)
    const ref = { integrationId: 'hm_1', sender: `${KEY}:1`, receiver: `${KEY}:4` }
    await expect(
      handlers.setCcuLinkProfile({ ...ref, short: 'off', long: 'none', confirmed: false }),
    ).rejects.toThrow(/confirmation/)
    await expect(handlers.deleteCcuLink({ ...ref, confirmed: false })).rejects.toThrow(
      /confirmation/,
    )
    expect(setLinkProfile).not.toHaveBeenCalled()
    expect(removeLink).not.toHaveBeenCalled()

    await handlers.setCcuLinkProfile({ ...ref, short: 'off', long: 'none', confirmed: true })
    expect(setLinkProfile).toHaveBeenCalledWith(`${KEY}:1`, `${KEY}:4`, {
      short: 'off',
      long: 'none',
    })
    await handlers.deleteCcuLink({ ...ref, confirmed: true })
    expect(removeLink).toHaveBeenCalledWith(`${KEY}:1`, `${KEY}:4`)
  })
})
