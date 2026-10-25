import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildHomeConnectCandidates,
  homeConnectDishwasherEntityName,
} from '../home-connect-discovery.js'

describe('buildHomeConnectCandidates', () => {
  it('emits a Container root with the dishwasher child; sensors come from the description', () => {
    const cands = buildHomeConnectCandidates({
      appliances: [
        {
          haId: 'ha-1',
          name: 'Kitchen',
          type: 'Dishwasher',
          availablePrograms: ['Eco50'],
        },
      ],
      adopted: new Map(),
    })
    expect(cands).toHaveLength(1)
    const root = cands[0]!
    expect(root.type).toBe(DeviceType.Container)
    expect(root.childNativeId).toBe('ha-1')
    expect(root.children).toHaveLength(1)
    const dishwasher = root.children!.find((c) => c.type === DeviceType.Dishwasher)
    expect(dishwasher?.childNativeId).toBe('ha-1#dishwasher')
    expect(dishwasher?.name).toBe('Dishwasher Kitchen')
    expect(dishwasher?.capabilities).toEqual(['dishwasher'])
  })

  it('marks an adopted appliance and skips appliance types it cannot serve', () => {
    const cands = buildHomeConnectCandidates({
      appliances: [
        { haId: 'ha-1', name: 'Kitchen', type: 'Dishwasher', availablePrograms: [] },
        { haId: 'ha-2', name: 'Oven', type: 'Oven', availablePrograms: [] },
      ],
      adopted: new Map([['ha-1', 77]]),
    })
    expect(cands.map((c) => c.childNativeId)).toEqual(['ha-1'])
    expect(cands[0]).toMatchObject({ alreadyAdopted: true, adoptedDeviceId: 77 })
  })
})

describe('homeConnectDishwasherEntityName', () => {
  it('prefixes Dishwasher to the container name', () => {
    expect(homeConnectDishwasherEntityName('Kitchen')).toBe('Dishwasher Kitchen')
  })
})
