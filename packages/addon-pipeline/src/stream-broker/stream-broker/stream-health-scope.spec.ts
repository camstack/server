import { describe, expect, it } from 'vitest'
import { healthEventIsOperatorFacing } from './stream-health-scope.js'

describe('healthEventIsOperatorFacing', () => {
  it('a camera stream going offline is news', () => {
    expect(healthEventIsOperatorFacing('native:main')).toBe(true)
    expect(healthEventIsOperatorFacing('native:sub')).toBe(true)
    expect(healthEventIsOperatorFacing('flv:main')).toBe(true)
  })

  it('an EGRESS pipe is not — its whole life is one consumer session', () => {
    // Measured: every Alexa session on the baby monitor produced an
    // online/offline pair against `640/egress:8e96e97a…`, and the operator
    // read it as the battery camera flapping during its wake.
    expect(
      healthEventIsOperatorFacing(
        'egress:8e96e97a1aa3c73fd148ebdda91433ed71ff1e5432af97895a35ad5b01b4a97c',
      ),
    ).toBe(false)
  })

  it('a DERIVED stream stays in scope — the operator configured it', () => {
    // It is meant to persist, so its going offline IS news. The rule is about
    // privacy of purpose, not about being synthetic.
    expect(healthEventIsOperatorFacing('derived:timelapse')).toBe(true)
  })
})
