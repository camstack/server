import { describe, expect, it } from 'vitest'
import { stageHasClassFilter } from '../zone-rule-class-filter.js'

describe('stageHasClassFilter', () => {
  it('shows the class selector only for the detection stage', () => {
    // detection zone engine passes getClassName → classFilter is consumed.
    expect(stageHasClassFilter('detection')).toBe(true)
  })

  it('hides the class selector for package rules (always the package class)', () => {
    // crop-zone + package-drop detector read only zoneIds/enabled.
    expect(stageHasClassFilter('package')).toBe(false)
  })

  it('hides the class selector for motion rules (regions carry no class)', () => {
    // motion gate calls evaluateZoneRules without getClassName → no-op.
    expect(stageHasClassFilter('motion')).toBe(false)
  })
})
