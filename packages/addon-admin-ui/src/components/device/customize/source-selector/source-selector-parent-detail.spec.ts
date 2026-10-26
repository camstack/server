import { describe, expect, it } from 'vitest'
import type { SourceCandidateDevice } from './source-selector-model'
import { compatiblePickerItems } from './source-selector-parent-detail'

function candidate(
  id: number,
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
    caps: ['motion'],
    ...overrides,
  }
}

describe('compatiblePickerItems', () => {
  it('resolves parent detail from the full fleet when the parent is not compatible', () => {
    const fleet = [
      { id: 399, name: 'Porch hub', parentDeviceId: null },
      {
        id: 301,
        name: 'Porch motion sensor',
        parentDeviceId: 399,
      },
    ]
    const compatible = [
      candidate(301, { name: 'Porch motion sensor', parentDeviceId: 399, caps: ['binary'] }),
    ]
    const items = compatiblePickerItems(compatible, fleet)
    expect(items).toHaveLength(1)
    expect(items[0]?.detail).toBe('in Porch hub')
  })
})
