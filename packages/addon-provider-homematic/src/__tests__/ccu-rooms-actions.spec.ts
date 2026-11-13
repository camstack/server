import { describe, expect, it, vi } from 'vitest'
import type { HmRoom } from 'nodehomematic'
import { buildCcuRoomHandlers } from '../ccu/ccu-rooms-actions.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDevice } from './hm-test-fixtures.js'

const DEV = '00315F298E5093'

function devices() {
  return [
    hmDevice({
      address: DEV,
      type: 'HmIP-BS2',
      name: 'Bagno',
      channels: [
        { address: `${DEV}:0`, index: 0, type: 'MAINTENANCE' },
        { address: `${DEV}:1`, index: 1, type: 'KEY_TRANSCEIVER', name: 'Sinistra' },
        { address: `${DEV}:4`, index: 4, type: 'SWITCH_VIRTUAL_RECEIVER' },
      ],
    }),
  ]
}

const ROOM: HmRoom = { id: '1234', name: 'Bagno', channels: [`${DEV}:1`] }

describe('listCcuRooms', () => {
  it('names each member channel and offers every non-maintenance channel', async () => {
    const { deps } = fakeDeps({ devices, listRooms: async () => [ROOM] })
    const out = await buildCcuRoomHandlers(deps).listCcuRooms({ integrationId: 'hm_1' })
    expect(out.rooms).toEqual([
      {
        id: '1234',
        name: 'Bagno',
        channels: [
          { address: `${DEV}:1`, name: 'Sinistra', deviceName: 'Bagno', deviceType: 'HmIP-BS2' },
        ],
      },
    ])
    expect(out.channels.map((c) => c.address)).toEqual([`${DEV}:1`, `${DEV}:4`])
  })
})

describe('room writes', () => {
  it('refuses every write without confirmation, and a blank name', async () => {
    const createRoom = vi.fn()
    const renameRoom = vi.fn()
    const deleteRoom = vi.fn()
    const addChannelToRoom = vi.fn()
    const { deps } = fakeDeps({ devices, createRoom, renameRoom, deleteRoom, addChannelToRoom })
    const h = buildCcuRoomHandlers(deps)
    const base = { integrationId: 'hm_1', confirmed: false }
    await expect(h.createCcuRoom({ ...base, name: 'X' })).rejects.toThrow(/confirmation/)
    await expect(h.renameCcuRoom({ ...base, id: '1', name: 'X' })).rejects.toThrow(/confirmation/)
    await expect(h.deleteCcuRoom({ ...base, id: '1' })).rejects.toThrow(/confirmation/)
    await expect(h.setCcuRoomChannels({ ...base, id: '1', channels: [] })).rejects.toThrow(
      /confirmation/,
    )
    await expect(
      h.createCcuRoom({ integrationId: 'hm_1', name: '  ', confirmed: true }),
    ).rejects.toThrow(/name/)
    for (const fn of [createRoom, renameRoom, deleteRoom, addChannelToRoom]) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('creates, renames and deletes a room once confirmed', async () => {
    const createRoom = vi.fn(async (name: string) => ({ id: '9', name, channels: [] }))
    const renameRoom = vi.fn(async () => undefined)
    const deleteRoom = vi.fn(async () => undefined)
    const changed = vi.fn()
    const { deps } = fakeDeps({ devices, createRoom, renameRoom, deleteRoom })
    const h = buildCcuRoomHandlers({ ...deps, ccuChanged: changed })
    await expect(
      h.createCcuRoom({ integrationId: 'hm_1', name: ' Cucina ', confirmed: true }),
    ).resolves.toEqual({ id: '9', name: 'Cucina', channels: [] })
    await h.renameCcuRoom({ integrationId: 'hm_1', id: '9', name: 'Kitchen', confirmed: true })
    await h.deleteCcuRoom({ integrationId: 'hm_1', id: '9', confirmed: true })
    expect(createRoom).toHaveBeenCalledWith('Cucina')
    expect(renameRoom).toHaveBeenCalledWith('9', 'Kitchen')
    expect(deleteRoom).toHaveBeenCalledWith('9')
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('applies only the difference to the member list', async () => {
    const addChannelToRoom = vi.fn(async () => undefined)
    const removeChannelFromRoom = vi.fn(async () => undefined)
    const { deps } = fakeDeps({
      devices,
      listRooms: async () => [{ ...ROOM, channels: [`${DEV}:1`, 'GONE:2'] }],
      addChannelToRoom,
      removeChannelFromRoom,
    })
    const out = await buildCcuRoomHandlers(deps).setCcuRoomChannels({
      integrationId: 'hm_1',
      id: '1234',
      channels: [`${DEV}:1`, `${DEV}:4`],
      confirmed: true,
    })
    expect(out).toEqual({ added: [`${DEV}:4`], removed: ['GONE:2'] })
    expect(addChannelToRoom).toHaveBeenCalledTimes(1)
    expect(addChannelToRoom).toHaveBeenCalledWith('1234', `${DEV}:4`)
    expect(removeChannelFromRoom).toHaveBeenCalledTimes(1)
    expect(removeChannelFromRoom).toHaveBeenCalledWith('1234', 'GONE:2')
  })

  it('names an unknown room instead of writing', async () => {
    const addChannelToRoom = vi.fn()
    const { deps } = fakeDeps({ devices, listRooms: async () => [], addChannelToRoom })
    await expect(
      buildCcuRoomHandlers(deps).setCcuRoomChannels({
        integrationId: 'hm_1',
        id: 'nope',
        channels: [`${DEV}:4`],
        confirmed: true,
      }),
    ).rejects.toThrow(/nope/)
    expect(addChannelToRoom).not.toHaveBeenCalled()
  })
})
