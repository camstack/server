// packages/kernel/src/__tests__/provider-kind-drift.spec.ts
import { describe, it, expect } from 'vitest'
import { describeProviderKindDrift } from '../provider-kind-drift.js'

describe('describeProviderKindDrift (D4)', () => {
  it('returns null when no runtime hint is present', () => {
    expect(
      describeProviderKindDrift('snapshot', { kind: 'wrapper', defaultActive: true }, {}),
    ).toBeNull()
  })

  it('returns null when the hint matches the cap definition', () => {
    expect(
      describeProviderKindDrift(
        'snapshot',
        { kind: 'wrapper', defaultActive: true },
        { kind: 'wrapper', defaultActive: true },
      ),
    ).toBeNull()
  })

  it('returns null when the cap definition omits kind and the hint explicitly says native', () => {
    expect(describeProviderKindDrift('reboot', {}, { kind: 'native' })).toBeNull()
  })

  it('flags a kind mismatch', () => {
    const msg = describeProviderKindDrift(
      'motion-detection',
      { kind: 'wrapper', defaultActive: true },
      { kind: 'native' },
    )
    expect(msg).toContain('motion-detection')
    expect(msg).toContain('kind')
    expect(msg).toContain('cap definition wins')
  })

  it('flags a defaultActive mismatch', () => {
    const msg = describeProviderKindDrift(
      'audio-analysis',
      { kind: 'wrapper', defaultActive: true },
      { kind: 'wrapper', defaultActive: false },
    )
    expect(msg).toContain('defaultActive')
    expect(msg).toContain("'false'")
    expect(msg).toContain("'true'")
  })

  it('includes both kind and defaultActive in a combined mismatch', () => {
    const msg = describeProviderKindDrift(
      'analytics',
      { kind: 'wrapper', defaultActive: true },
      { kind: 'native', defaultActive: false },
    )
    expect(msg).toContain('kind')
    expect(msg).toContain('defaultActive')
  })
})
