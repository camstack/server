import { describe, expect, it, vi } from 'vitest'
import type { HmCustomEntity, HmDevice, HmGroup } from 'nodehomematic'
import { buildCcuHeatingHandlers } from '../ccu/ccu-heating-actions.js'
import type { CcuFacade } from '../ccu/ccu-facade.js'
import { fakeDeps } from './ccu-fake.js'

const DEVICES: HmDevice[] = [
  {
    address: 'TRV1',
    type: 'HmIP-eTRV-2',
    name: 'Bedroom radiator',
    channels: [
      { address: 'TRV1:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
      { address: 'TRV1:1', index: 1, type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', dataPoints: [] },
    ],
  },
  {
    address: 'LAMP',
    type: 'HmIP-BSM',
    channels: [{ address: 'LAMP:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] }],
  },
]
const GROUP: HmGroup = {
  id: 7,
  name: 'Bedroom',
  type: 'hmip.heating.group',
  typeLabel: 'Heating group',
  deviceAddress: 'INT0000001',
  forbidSingleOperation: false,
  members: [{ address: 'TRV1:1', type: 'HEATING_CLIMATECONTROL_TRANSCEIVER' }],
}
const CLIMATE: HmCustomEntity = {
  kind: 'climate',
  device: 'TRV1',
  channel: 'TRV1:1',
  currentTemperature: 19.5,
  targetTemperature: 21,
  currentHumidity: null,
  minTemp: 5,
  maxTemp: 30,
  targetTemperatureStep: 0.5,
  mode: 'auto',
  preset: 'none',
  activity: 'heating',
}

function setup(facade: Partial<CcuFacade>) {
  const { deps, logger } = fakeDeps({
    devices: () => DEVICES,
    customEntities: () => [CLIMATE],
    ...facade,
  })
  return { handlers: buildCcuHeatingHandlers(deps), logger }
}

describe('listHeatingGroups', () => {
  it('lists groups with member device names, thermostats and group candidates', async () => {
    const { handlers } = setup({ groups: vi.fn().mockResolvedValue([GROUP]) })
    const out = await handlers.listHeatingGroups({ integrationId: 'hm_1' })
    expect(out.groups[0]?.members[0]).toEqual({
      address: 'TRV1:1',
      type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
      deviceName: 'Bedroom radiator',
    })
    expect(out.groupsError).toBeNull()
    expect(out.thermostats).toEqual([
      {
        device: 'TRV1',
        channel: 'TRV1:1',
        name: 'Bedroom radiator',
        currentTemperature: 19.5,
        targetTemperature: 21,
        mode: 'auto',
        activity: 'heating',
      },
    ])
    expect(out.candidates.map((c) => c.address)).toEqual(['TRV1:1'])
  })

  it('names why the groups are missing and still returns the thermostats', async () => {
    const { handlers } = setup({
      groups: vi.fn().mockRejectedValue(new Error('needs WebUI credentials')),
    })
    const out = await handlers.listHeatingGroups({ integrationId: 'hm_1' })
    expect(out.groups).toEqual([])
    expect(out.groupsError).toBe('needs WebUI credentials')
    expect(out.thermostats).toHaveLength(1)
  })
})

describe('group writes', () => {
  it('creates a group from the trimmed name and the picked members', async () => {
    const createGroup = vi.fn().mockResolvedValue(GROUP)
    const { handlers, logger } = setup({ createGroup })
    const out = await handlers.createHeatingGroup({
      integrationId: 'hm_1',
      name: '  Bedroom ',
      type: 'hmip.heating.group',
      members: ['TRV1:1'],
      confirmed: true,
    })
    expect(createGroup).toHaveBeenCalledWith({
      name: 'Bedroom',
      type: 'hmip.heating.group',
      members: ['TRV1:1'],
    })
    expect(out.id).toBe(7)
    expect(logger.lines.some((l) => /created/.test(l.message))).toBe(true)
  })

  it.each([
    ['an empty name', { name: ' ', members: ['TRV1:1'], type: 'hmip.heating.group' }, /name/],
    ['no members', { name: 'A', members: [], type: 'hmip.heating.group' }, /member/],
    ['an unknown type', { name: 'A', members: ['TRV1:1'], type: 'bogus' }, /type/],
  ])('refuses to create with %s, before touching the CCU', async (_label, patch, message) => {
    const createGroup = vi.fn()
    const { handlers } = setup({ createGroup })
    await expect(
      handlers.createHeatingGroup({ integrationId: 'hm_1', confirmed: true, ...patch }),
    ).rejects.toThrow(message)
    expect(createGroup).not.toHaveBeenCalled()
  })

  it('updates the name and the full member list', async () => {
    const updateGroup = vi.fn().mockResolvedValue(GROUP)
    const { handlers } = setup({ updateGroup })
    await handlers.updateHeatingGroup({
      integrationId: 'hm_1',
      id: 7,
      name: 'Master bedroom',
      members: ['TRV1:1'],
      confirmed: true,
    })
    expect(updateGroup).toHaveBeenCalledWith(7, { name: 'Master bedroom', members: ['TRV1:1'] })
  })

  it('refuses an update that changes nothing', async () => {
    const updateGroup = vi.fn()
    const { handlers } = setup({ updateGroup })
    await expect(
      handlers.updateHeatingGroup({ integrationId: 'hm_1', id: 7, confirmed: true }),
    ).rejects.toThrow(/nothing to change/i)
    expect(updateGroup).not.toHaveBeenCalled()
  })

  it('deletes a group', async () => {
    const deleteGroup = vi.fn().mockResolvedValue(undefined)
    const { handlers } = setup({ deleteGroup })
    expect(
      await handlers.deleteHeatingGroup({ integrationId: 'hm_1', id: 7, confirmed: true }),
    ).toEqual({
      ok: true,
    })
    expect(deleteGroup).toHaveBeenCalledWith(7)
  })

  it('no write reaches the CCU without the operator confirmation', async () => {
    const createGroup = vi.fn()
    const updateGroup = vi.fn()
    const deleteGroup = vi.fn()
    const { handlers } = setup({ createGroup, updateGroup, deleteGroup })
    await expect(
      handlers.createHeatingGroup({
        integrationId: 'hm_1',
        name: 'A',
        type: 'hmip.heating.group',
        members: ['TRV1:1'],
        confirmed: false,
      }),
    ).rejects.toThrow(/confirm/i)
    await expect(
      handlers.updateHeatingGroup({ integrationId: 'hm_1', id: 1, name: 'B', confirmed: false }),
    ).rejects.toThrow(/confirm/i)
    await expect(
      handlers.deleteHeatingGroup({ integrationId: 'hm_1', id: 1, confirmed: false }),
    ).rejects.toThrow(/confirm/i)
    expect(createGroup).not.toHaveBeenCalled()
    expect(updateGroup).not.toHaveBeenCalled()
    expect(deleteGroup).not.toHaveBeenCalled()
  })
})
