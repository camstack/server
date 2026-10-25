import { DeviceRole, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildSkeletonComposition,
  skeletonFillStatus,
  unfilledRequiredFields,
} from '../build-skeleton'

describe('buildSkeletonComposition', () => {
  it('reads incomplete while the role still has required fields with no source', () => {
    const composition = buildSkeletonComposition({
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
    expect(skeletonFillStatus(composition)).toBe('incomplete')
    expect(unfilledRequiredFields('temperature-sensor', new Set())).toContain('celsius')
  })
})
