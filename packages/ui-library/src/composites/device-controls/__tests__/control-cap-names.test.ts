import { describe, it, expect } from 'vitest'
import { CONTROL_CAP_NAMES } from '../types'

describe('CONTROL_CAP_NAMES', () => {
  it('lists exactly the ten control caps', () => {
    expect([...CONTROL_CAP_NAMES].toSorted()).toEqual(
      [
        'brightness',
        'climate-control',
        'control',
        'cover',
        'dishwasher',
        'fan-control',
        'lock-control',
        'media-player',
        'pet-feeder',
        'switch',
      ].toSorted(),
    )
  })
})
