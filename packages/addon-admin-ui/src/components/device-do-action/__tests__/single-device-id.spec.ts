import { describe, expect, it } from 'vitest'
import { sameFamilyDeviceIds, singleDeviceId } from '../DeviceDoActionFields'

describe('singleDeviceId', () => {
  it('clears when the picker empties', () => {
    expect(singleDeviceId([7], [])).toBe(0)
  })

  it('keeps a sole selection', () => {
    expect(singleDeviceId([], [12])).toBe(12)
  })

  it('when a second id is added, keeps the newcomer', () => {
    expect(singleDeviceId([1], [1, 9])).toBe(9)
  })
})

describe('sameFamilyDeviceIds', () => {
  const typeOf = (id: number): string | undefined => {
    if (id === 1 || id === 2) return 'lock'
    if (id === 10 || id === 11) return 'climate'
    if (id === 12) return 'humidifier'
    if (id === 20) return 'switch'
    return undefined
  }

  it('keeps several locks together', () => {
    expect(sameFamilyDeviceIds([1], [1, 2], typeOf)).toEqual([1, 2])
  })

  it('lets climate and humidifier share a selection', () => {
    expect(sameFamilyDeviceIds([10], [10, 12], typeOf)).toEqual([10, 12])
  })

  it('replaces the selection when a different family is added', () => {
    expect(sameFamilyDeviceIds([1], [1, 20], typeOf)).toEqual([20])
  })
})
