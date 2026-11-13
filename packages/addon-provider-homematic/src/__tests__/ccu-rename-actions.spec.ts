import { describe, expect, it, vi } from 'vitest'
import { buildCcuRenameHandlers } from '../ccu/ccu-rename-actions.js'
import { toCcuDeviceRow } from '../ccu/ccu-device-rows.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDevice } from './hm-test-fixtures.js'

const ADDRESS = '00315F298E5093'

describe('renameCcuDevice', () => {
  it('renames the device and, when asked, its channels, only once confirmed', async () => {
    const renameDevice = vi.fn(async () => ({
      device: { address: ADDRESS, name: 'Bagno' },
      channels: [{ address: `${ADDRESS}:1`, name: 'Bagno:1' }],
    }))
    const changed = vi.fn()
    const { deps } = fakeDeps({ renameDevice })
    const handlers = buildCcuRenameHandlers({ ...deps, ccuChanged: changed })
    const input = {
      integrationId: 'hm_1',
      address: ADDRESS,
      name: '  Bagno ',
      renameChannels: true,
    }
    await expect(handlers.renameCcuDevice({ ...input, confirmed: false })).rejects.toThrow(
      /confirmation/,
    )
    expect(renameDevice).not.toHaveBeenCalled()

    const out = await handlers.renameCcuDevice({ ...input, confirmed: true })
    expect(renameDevice).toHaveBeenCalledWith(ADDRESS, 'Bagno', { renameChannels: true })
    expect(out).toEqual({
      device: { address: ADDRESS, name: 'Bagno' },
      channels: [{ address: `${ADDRESS}:1`, name: 'Bagno:1' }],
    })
    expect(changed).toHaveBeenCalledWith('hm_1')
  })

  it('refuses a blank name before any write', async () => {
    const renameDevice = vi.fn()
    const renameChannel = vi.fn()
    const { deps } = fakeDeps({ renameDevice, renameChannel })
    const handlers = buildCcuRenameHandlers(deps)
    await expect(
      handlers.renameCcuDevice({
        integrationId: 'hm_1',
        address: ADDRESS,
        name: '   ',
        renameChannels: false,
        confirmed: true,
      }),
    ).rejects.toThrow(/name/)
    await expect(
      handlers.renameCcuChannel({
        integrationId: 'hm_1',
        address: `${ADDRESS}:1`,
        name: '',
        confirmed: true,
      }),
    ).rejects.toThrow(/name/)
    expect(renameDevice).not.toHaveBeenCalled()
    expect(renameChannel).not.toHaveBeenCalled()
  })
})

describe('renameCcuChannel', () => {
  it('renames one channel only once confirmed and returns the stored name', async () => {
    const renameChannel = vi.fn(async () => ({ address: `${ADDRESS}:1`, name: 'Sinistra' }))
    const { deps } = fakeDeps({ renameChannel })
    const handlers = buildCcuRenameHandlers(deps)
    const input = { integrationId: 'hm_1', address: `${ADDRESS}:1`, name: 'Sinistra' }
    await expect(handlers.renameCcuChannel({ ...input, confirmed: false })).rejects.toThrow(
      /confirmation/,
    )
    expect(renameChannel).not.toHaveBeenCalled()
    await expect(handlers.renameCcuChannel({ ...input, confirmed: true })).resolves.toEqual({
      address: `${ADDRESS}:1`,
      name: 'Sinistra',
    })
  })
})

describe('device rows carry their channels', () => {
  it('lists every channel but the maintenance channel, with its CCU name', () => {
    const row = toCcuDeviceRow(
      hmDevice({
        address: ADDRESS,
        type: 'HmIP-BS2',
        name: 'Bagno',
        channels: [
          { address: `${ADDRESS}:0`, index: 0, type: 'MAINTENANCE' },
          { address: `${ADDRESS}:1`, index: 1, type: 'KEY_TRANSCEIVER', name: 'Sinistra' },
          { address: `${ADDRESS}:4`, index: 4, type: 'SWITCH_VIRTUAL_RECEIVER' },
        ],
      }),
    )
    expect(row.channels).toEqual([
      { address: `${ADDRESS}:1`, index: 1, type: 'KEY_TRANSCEIVER', name: 'Sinistra' },
      { address: `${ADDRESS}:4`, index: 4, type: 'SWITCH_VIRTUAL_RECEIVER', name: null },
    ])
  })
})
