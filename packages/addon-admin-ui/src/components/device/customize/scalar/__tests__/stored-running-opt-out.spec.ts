import { type Composition, DeviceType, runningOptOutFeature } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import type { CustomizationHandle } from '../../use-customization'
import { storedScalarFeature } from '../use-scalar-row'

const held: { composition: Composition | null } = { composition: null }
vi.mock('../../customization-read', () => ({ currentComposition: () => held.composition }))

const handle: CustomizationHandle = {
  target: { addonId: 'composer', stableId: 'x' },
  state: { kind: 'none' },
  saving: false,
  save: async () => ({ kind: 'saved' }),
}

describe('the running opt-out is the toggle, not a stored source', () => {
  it('reads as nothing stored, so the row never calls it another formula', () => {
    held.composition = {
      target: { kind: 'new', type: DeviceType.Fan },
      features: [runningOptOutFeature()],
    }
    expect(storedScalarFeature(handle, 'running-state', 'running')).toBeNull()
  })
})
