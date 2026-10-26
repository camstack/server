import { describe, expect, it } from 'vitest'
import {
  groupSourceValues,
  judgeSourceCompatibility,
  partitionSourceDevices,
  type SourceCandidateDevice,
  type SourceDestination,
  type SourceWireableField,
} from './source-selector-model'

const batteryDest: SourceDestination = {
  cap: 'battery',
  targetId: 'percentage',
  title: 'Battery',
}

const runningDest: SourceDestination = {
  cap: 'running-state',
  targetId: 'running',
  title: 'Running',
}

const doorbellDest: SourceDestination = {
  cap: 'doorbell',
  targetId: 'pressed',
  title: 'Doorbell',
}

function device(
  id: number,
  caps: readonly string[],
  overrides: Partial<SourceCandidateDevice> = {},
): SourceCandidateDevice {
  return {
    id,
    name: `Device ${id}`,
    type: 'sensor',
    location: 'Room',
    parentDeviceId: null,
    addonId: 'provider-homeassistant',
    stableId: `dev-${id}`,
    caps,
    ...overrides,
  }
}

describe('judgeSourceCompatibility', () => {
  it('battery percentage + number with identity+linear → direct', () => {
    const field: SourceWireableField = {
      cap: 'battery',
      path: 'percentage',
      kind: 'number',
      unit: '%',
      currentText: '82',
    }
    expect(judgeSourceCompatibility(batteryDest, field)).toEqual({ kind: 'direct' })
  })

  it('battery + boolean → incompatible kind', () => {
    const field: SourceWireableField = {
      cap: 'binary',
      path: 'on',
      kind: 'boolean',
      unit: null,
      currentText: 'true',
    }
    expect(judgeSourceCompatibility(batteryDest, field)).toEqual({
      kind: 'incompatible',
      reason: 'kind',
    })
  })

  it('running + number unit W → conversion threshold', () => {
    const field: SourceWireableField = {
      cap: 'power-meter',
      path: 'watts',
      kind: 'number',
      unit: 'W',
      currentText: '12',
    }
    expect(judgeSourceCompatibility(runningDest, field)).toEqual({
      kind: 'conversion',
      name: 'threshold',
    })
  })

  it('running + number unit % → incompatible unit', () => {
    const field: SourceWireableField = {
      cap: 'humidity-sensor',
      path: 'percent',
      kind: 'number',
      unit: '%',
      currentText: '50',
    }
    expect(judgeSourceCompatibility(runningDest, field)).toEqual({
      kind: 'incompatible',
      reason: 'unit',
    })
  })

  it('running + number unit null → unit-unknown', () => {
    const field: SourceWireableField = {
      cap: 'numeric-sensor',
      path: 'value',
      kind: 'number',
      unit: null,
      currentText: '5',
    }
    expect(judgeSourceCompatibility(runningDest, field)).toEqual({
      kind: 'incompatible',
      reason: 'unit-unknown',
    })
  })

  it('running + boolean on cap motion → direct', () => {
    const field: SourceWireableField = {
      cap: 'motion',
      path: 'detected',
      kind: 'boolean',
      unit: null,
      currentText: 'false',
    }
    expect(judgeSourceCompatibility(runningDest, field)).toEqual({ kind: 'direct' })
  })
})

describe('partitionSourceDevices', () => {
  it('doorbell: motion compatible, light incompatible, host excluded', () => {
    const hostId = 1
    const devices = [device(1, ['motion']), device(2, ['motion']), device(3, ['light'])]
    const { compatible, incompatible } = partitionSourceDevices(devices, doorbellDest, hostId)
    expect(compatible.map((d) => d.id)).toEqual([2])
    expect(incompatible.map((d) => d.id)).toEqual([3])
  })

  it('battery: binary incompatible; battery or power-meter compatible', () => {
    const { compatible, incompatible } = partitionSourceDevices(
      [device(10, ['binary']), device(11, ['battery']), device(12, ['power-meter'])],
      batteryDest,
      99,
    )
    expect(compatible.map((d) => d.id)).toEqual([11, 12])
    expect(incompatible.map((d) => d.id)).toEqual([10])
  })
})

describe('groupSourceValues', () => {
  it('two caps → two groups; incompatible rows outside groups', () => {
    const fields: readonly SourceWireableField[] = [
      {
        cap: 'battery',
        path: 'percentage',
        kind: 'number',
        unit: '%',
        currentText: '82',
      },
      {
        cap: 'power-meter',
        path: 'watts',
        kind: 'number',
        unit: 'W',
        currentText: '10',
      },
      {
        cap: 'binary',
        path: 'on',
        kind: 'boolean',
        unit: null,
        currentText: 'false',
      },
    ]
    const { groups, incompatible } = groupSourceValues(fields, batteryDest, 'en')
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.cap)).toEqual(['battery', 'power-meter'])
    expect(incompatible).toHaveLength(1)
    expect(incompatible[0]?.path).toBe('on')
  })
})
