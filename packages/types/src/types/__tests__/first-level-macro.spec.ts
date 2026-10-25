import { describe, it, expect } from 'vitest'
import {
  CLASS_MAP_MACRO_TARGETS,
  FIRST_LEVEL_MACRO_CLASSES,
  isFirstLevelMacroClass,
} from '../labels.js'

describe('FIRST_LEVEL_MACRO_CLASSES', () => {
  it('is exactly the offer of the object-detection step', () => {
    expect([...FIRST_LEVEL_MACRO_CLASSES]).toEqual(['person', 'vehicle', 'animal'])
  })

  it('does NOT contain package — it belongs to the package-detection step', () => {
    // step-definitions.ts: offering the same word twice has already made
    // an operator turn on the COCO proxy while leaving the real detector off.
    expect([...FIRST_LEVEL_MACRO_CLASSES]).not.toContain('package')
  })

  it('is a subset of the targets a classMap can resolve', () => {
    // If a first-level macro were not a valid target, the executor could
    // never produce it and the trigger on it would be mute.
    for (const macro of FIRST_LEVEL_MACRO_CLASSES) {
      expect([...CLASS_MAP_MACRO_TARGETS]).toContain(macro)
    }
  })
})

describe('isFirstLevelMacroClass', () => {
  it('riconosce le tre e nient altro', () => {
    expect(isFirstLevelMacroClass('person')).toBe(true)
    expect(isFirstLevelMacroClass('vehicle')).toBe(true)
    expect(isFirstLevelMacroClass('animal')).toBe(true)
    expect(isFirstLevelMacroClass('package')).toBe(false)
    expect(isFirstLevelMacroClass('face')).toBe(false)
    expect(isFirstLevelMacroClass('')).toBe(false)
  })
})
