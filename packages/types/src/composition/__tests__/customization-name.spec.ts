// packages/types/src/composition/__tests__/customization-name.spec.ts
import { describe, expect, it } from 'vitest'
import { customizationBlockName } from '../customization-name.js'

const HA = 'provider-homeassistant'

describe('customizationBlockName (D663, server-derived)', () => {
  it('is the target ref under the prefix when it fits the 120-char block name', () => {
    expect(customizationBlockName({ addonId: HA, stableId: 'ha:b:dev:8dec' })).toBe(
      `customize:${HA}/ha:b:dev:8dec`,
    )
  })
  it('hashes a ref that would not fit, deterministically', () => {
    const ref = { addonId: HA, stableId: 'x'.repeat(200) }
    const name = customizationBlockName(ref)
    expect(name).toMatch(/^customize:#[0-9a-f]{32}$/)
    expect(name.length).toBeLessThanOrEqual(120)
    expect(customizationBlockName(ref)).toBe(name)
  })
})
