/**
 * The dispensa camera (device 1438) is the fixture: presets 1-3 are the
 * operator's, and 34/39/40/46/92/93/94/95 are the firmware's reserved band.
 */
import { describe, expect, it } from 'vitest'
import { findFreePresetSlot } from '../free-preset-slot.js'

const w = (id: string) => ({ id, writable: true })

describe('findFreePresetSlot', () => {
  it('takes the first gap after the operator’s own presets', () => {
    expect(findFreePresetSlot([w('1'), w('2'), w('3')], 300)).toBe('4')
  })

  it('never proposes a reserved function id', () => {
    const taken = Array.from({ length: 33 }, (_, i) => w(String(i + 1)))
    // 1..33 taken, so the next free number is 34 — which is "Back to origin".
    expect(findFreePresetSlot(taken, 300)).not.toBe('34')
    expect(findFreePresetSlot(taken, 300)).toBe('35')
  })

  it('never proposes a slot the operator already used', () => {
    const chosen = findFreePresetSlot([w('1'), w('3')], 300)
    expect(chosen).toBe('2')
  })

  /**
   * No room must REFUSE. Picking a victim to make space would destroy a preset
   * the operator placed, which is a worse outcome than not setting a home.
   */
  it('returns null rather than choosing a victim when the camera is full', () => {
    const taken = Array.from({ length: 4 }, (_, i) => w(String(i + 1)))
    expect(findFreePresetSlot(taken, 4)).toBeNull()
  })

  /** An unadvertised budget stays below the reserved band instead of guessing. */
  it('stays under the reserved band when the camera advertises no maximum', () => {
    const chosen = findFreePresetSlot([], undefined)
    expect(chosen).toBe('1')
    const full = Array.from({ length: 32 }, (_, i) => w(String(i + 1)))
    expect(findFreePresetSlot(full, undefined)).toBeNull()
  })
})
