import { describe, expect, it } from 'vitest'
import { stateLabelLocaleOf } from '../use-state-label'

describe('stateLabelLocaleOf', () => {
  it('maps an Italian tag to it and everything else to en', () => {
    expect(stateLabelLocaleOf('it')).toBe('it')
    expect(stateLabelLocaleOf('it-IT')).toBe('it')
    expect(stateLabelLocaleOf('en')).toBe('en')
    expect(stateLabelLocaleOf('de')).toBe('en')
    expect(stateLabelLocaleOf(undefined)).toBe('en')
  })
})
