import { applianceExport, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { planGenericDevice } from '../index.js'
import type { AdapterDevice } from '../types.js'

function appliance(type: DeviceType): AdapterDevice {
  return {
    deviceId: 4,
    type,
    role: null,
    features: [],
    capNames: ['power-meter', 'running-state'],
    slices: {},
  }
}

describe('Alexa appliance export', () => {
  it.each([
    DeviceType.Washer,
    DeviceType.Dryer,
    DeviceType.Dishwasher,
  ])('skips a %s and names the reason', (type) => {
    const decision = applianceExport('alexa', type)
    expect(decision?.exported).toBe(false)
    if (decision === null || decision.exported) return
    expect(planGenericDevice(appliance(type))).toEqual({
      kind: 'skip',
      reasons: [decision.reason],
    })
  })
})
