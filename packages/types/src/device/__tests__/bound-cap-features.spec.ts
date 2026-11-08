import { describe, expect, it } from 'vitest'
import { DeviceFeature, featuresOfBoundCaps } from '../device-type.js'

describe('featuresOfBoundCaps', () => {
  it('a bound plain switch is the feature a viewer reads as the appliance on/off', () => {
    expect(featuresOfBoundCaps(['switch', 'timed-run', 'power-meter'])).toEqual(
      expect.arrayContaining([DeviceFeature.Switch, DeviceFeature.TimedRun]),
    )
  })
})
