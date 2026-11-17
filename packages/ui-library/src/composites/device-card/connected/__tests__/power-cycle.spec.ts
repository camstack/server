import { SWITCH_DEFAULT_OPTIONS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { powerCycleDeclared } from '../use-power-cycle'

describe('powerCycleDeclared — the plug restart is drawn only when the switch says it cycles', () => {
  const cycles = { supportsSetState: false, supportsPowerCycle: true }

  it('is true when the provider has the method and its options declare the cycle', () => {
    expect(powerCycleDeclared(true, cycles)).toBe(true)
  })

  it('is false for a provider without the method, whatever its options say', () => {
    expect(powerCycleDeclared(false, cycles)).toBe(false)
  })

  it('is false when the options declare no cycle (the defaults)', () => {
    expect(powerCycleDeclared(true, SWITCH_DEFAULT_OPTIONS)).toBe(false)
  })

  it('is false while the options are pending or after a failed read', () => {
    expect(powerCycleDeclared(true, undefined)).toBe(false)
  })
})
