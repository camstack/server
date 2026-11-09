import { DeviceFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { projectedFeatures } from '../device-projection.js'

describe('projectedFeatures (#459)', () => {
  it('the row decides a derived feature, whatever the live device says', () => {
    expect(projectedFeatures([DeviceFeature.PanTiltZoom], [])).toEqual([])
    expect(projectedFeatures([], [DeviceFeature.PanTiltZoom])).toEqual([DeviceFeature.PanTiltZoom])
  })

  it('the live device still decides a feature nobody derives', () => {
    expect(projectedFeatures([DeviceFeature.BatteryOperated], [DeviceFeature.PanTiltZoom])).toEqual(
      [DeviceFeature.BatteryOperated, DeviceFeature.PanTiltZoom],
    )
  })

  it('falls back to the row for the driver-owned ones when the live list is empty', () => {
    expect(projectedFeatures([], [DeviceFeature.BatteryOperated])).toEqual([
      DeviceFeature.BatteryOperated,
    ])
  })

  it('without a row the live list is all there is, unknown strings dropped', () => {
    expect(projectedFeatures([DeviceFeature.PanTiltZoom, 'not-a-feature'], undefined)).toEqual([
      DeviceFeature.PanTiltZoom,
    ])
  })
})
