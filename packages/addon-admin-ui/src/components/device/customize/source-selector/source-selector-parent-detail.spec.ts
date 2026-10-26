import { describe, expect, it } from 'vitest'
import type { DeviceNameFields } from '@camstack/ui-library'
import type { SourceCandidateDevice } from './source-selector-model'
import { compatiblePickerItems, sourceRowLabel } from './source-selector-parent-detail'

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

function named(
  id: number,
  name: string,
  type: string,
  parentDeviceId: number | null,
  role?: string,
): DeviceNameFields {
  return {
    id,
    name,
    type,
    stableId: `dev-${id}`,
    parentDeviceId,
    ...(role !== undefined ? { role } : {}),
  }
}

describe('compatiblePickerItems', () => {
  it('keeps the stored name so the picker can label the row itself', () => {
    const compatible = [
      candidate(301, { name: 'Porch motion sensor', parentDeviceId: 399, caps: ['binary'] }),
    ]
    const items = compatiblePickerItems(compatible)
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe('Porch motion sensor')
    expect(items[0]?.detail).toBeUndefined()
  })
})

describe('sourceRowLabel', () => {
  it('names the only motion child as its container', () => {
    const parent = named(399, 'Sensore movimento veranda', 'container', null)
    const motion = named(301, 'Motion', 'sensor', 399, 'motion-sensor')
    expect(sourceRowLabel(motion, [parent, motion])).toBe('Sensore movimento veranda')
    expect(sourceRowLabel(parent, [parent, motion])).toBe('Sensore movimento veranda')
  })
})
