/**
 * The readable formula line humanises duration literals. The stored
 * expression is the caller's string and is not rewritten.
 */
import { describe, expect, it } from 'vitest'
import { formulaOneLiner } from '../field-entry-copy'

const FROM = {
  kind: 'from' as const,
  source: { addonId: 'provider-homeassistant', stableId: 'dev-301' },
  cap: 'binary',
  fieldPath: 'on',
}

describe('formulaOneLiner durations', () => {
  it('reads within(…, 300000) as "within 5 min" and leaves the stored expression', () => {
    const expr = 'any(d1, within(m1, 300000))'
    const text = formulaOneLiner(
      expr,
      {
        d1: FROM,
        m1: { ...FROM, cap: 'motion', fieldPath: 'lastDetectedAt' },
      },
      new Map([['provider-homeassistant/dev-301', 'Porch motion']]),
      'en',
      'Unknown device',
    )
    expect(expr).toBe('any(d1, within(m1, 300000))')
    expect(text).toBe('any(Porch motion · On, within 5 min)')
    expect(text).not.toContain('300000')
  })

  it('humanises dwell and rose delays and leaves other numbers', () => {
    const expr = 'dwell(flag, 60000, 1000) && rose(flag, at, 2000) && max(flag, 300000)'
    const text = formulaOneLiner(expr, {}, new Map(), 'en', 'Unknown device')
    expect(text).toBe('dwell(flag, 1 min, 1 s) && rose(flag, at, 2 s) && max(flag, 300000)')
  })

  it('leaves a within window that is not a duration literal', () => {
    const text = formulaOneLiner('within(m1, window)', {}, new Map(), 'en', 'Unknown device')
    expect(text).toBe('within(m1, window)')
  })
})
