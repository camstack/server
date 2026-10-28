import { groupTemplate, sourcePickForTemplate } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyMemberSelection,
  directAcceptFields,
  type MemberDevice,
  partitionMemberDevices,
} from '../source-selector-members-model'

function device(
  id: number,
  type: string,
  caps: readonly string[],
  name = `Device ${id}`,
): MemberDevice {
  return {
    id,
    name,
    type,
    location: 'Porch',
    parentDeviceId: null,
    addonId: 'provider-homeassistant',
    stableId: `sensor.${id}`,
    caps,
  }
}

function requestFor(id: 'temperature' | 'occupancy') {
  const template = groupTemplate(id)
  if (template === null) throw new Error(`missing ${id}`)
  return sourcePickForTemplate(template)
}

describe('partitionMemberDevices', () => {
  it('keeps sensors that bind the template cap and drops other types', () => {
    const request = requestFor('temperature')
    const { compatible, incompatible } = partitionMemberDevices(
      [
        device(1, 'sensor', ['temperature-sensor'], 'Porch'),
        device(2, 'camera', ['temperature-sensor'], 'Driveway'),
        device(3, 'sensor', ['binary'], 'Door'),
      ],
      request,
    )
    expect(compatible.map((row) => row.id)).toEqual([1])
    expect(incompatible.map((row) => row.id)).toEqual([2, 3])
  })

  it('offers a climate device to a temperature group and reads it from its current temperature', () => {
    const request = requestFor('temperature')
    const climate = device(5, 'climate', ['climate-control'], 'Climate veranda')
    const both = device(6, 'thermostat', ['climate-control', 'temperature-sensor'], 'Hall')
    expect(
      partitionMemberDevices([climate, both], request).compatible.map((row) => row.id),
    ).toEqual([5, 6])
    const picked = applyMemberSelection({
      request,
      devices: [climate, both],
      selectedIds: [5, 6],
      previous: [],
      choiceDeviceId: null,
      choice: null,
    })
    expect(picked.needsField).toEqual([])
    expect(picked.members.map((member) => `${member.cap}.${member.fieldPath}`)).toEqual([
      'climate-control.currentTemp',
      'temperature-sensor.temperature',
    ])
  })

  it('hides an excluded ref instead of listing it as incompatible', () => {
    const request = {
      ...requestFor('temperature'),
      exclude: [{ addonId: 'provider-homeassistant', stableId: 'sensor.1' }],
    }
    const { compatible, incompatible } = partitionMemberDevices(
      [device(1, 'sensor', ['temperature-sensor'])],
      request,
    )
    expect(compatible).toEqual([])
    expect(incompatible).toEqual([])
  })
})

describe('directAcceptFields', () => {
  it('offers only the catalog field, not a conversion or another cap', () => {
    const fields = directAcceptFields(
      [
        { cap: 'temperature-sensor', fieldPath: 'temperature', kind: 'number' },
        { cap: 'temperature-sensor', fieldPath: 'lastFetchedAt', kind: 'number' },
        { cap: 'humidity-sensor', fieldPath: 'humidity', kind: 'number' },
      ],
      requestFor('temperature'),
    )
    expect(fields).toEqual([
      { cap: 'temperature-sensor', fieldPath: 'temperature', kind: 'number' },
    ])
  })
})

describe('applyMemberSelection', () => {
  const porch = device(1, 'sensor', ['temperature-sensor'], 'Porch')
  const garden = device(2, 'sensor', ['temperature-sensor'], 'Garden')

  it('fills the one catalog field when a sensor is selected', () => {
    const result = applyMemberSelection({
      request: requestFor('temperature'),
      devices: [porch, garden],
      selectedIds: [1],
      previous: [],
      choiceDeviceId: null,
      choice: null,
    })
    expect(result.refused).toBeNull()
    expect(result.members).toEqual([
      {
        source: { addonId: 'provider-homeassistant', stableId: 'sensor.1' },
        cap: 'temperature-sensor',
        fieldPath: 'temperature',
      },
    ])
  })

  it('waits for a field when the template accepts more than one', () => {
    const motion = device(4, 'sensor', ['motion'], 'Hall')
    const pending = applyMemberSelection({
      request: requestFor('occupancy'),
      devices: [motion],
      selectedIds: [4],
      previous: [],
      choiceDeviceId: null,
      choice: null,
    })
    expect(pending.members).toEqual([])
    expect(pending.needsField).toEqual([4])
    const chosen = applyMemberSelection({
      request: requestFor('occupancy'),
      devices: [motion],
      selectedIds: [4],
      previous: [],
      choiceDeviceId: 4,
      choice: { cap: 'motion', fieldPath: 'detected' },
    })
    expect(chosen.members[0]?.fieldPath).toBe('detected')
    expect(chosen.needsField).toEqual([])
  })

  it('refuses a selection past the template maximum and keeps the previous members', () => {
    const request = { ...requestFor('temperature'), max: 1 }
    const previous = applyMemberSelection({
      request,
      devices: [porch, garden],
      selectedIds: [1],
      previous: [],
      choiceDeviceId: null,
      choice: null,
    })
    const over = applyMemberSelection({
      request,
      devices: [porch, garden],
      selectedIds: [1, 2],
      previous: previous.members,
      choiceDeviceId: null,
      choice: null,
    })
    expect(over.refused).toBe('max')
    expect(over.members).toEqual(previous.members)
  })
})
