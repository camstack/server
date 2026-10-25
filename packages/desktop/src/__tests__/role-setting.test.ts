import { describe, expect, it } from 'vitest'
import { parseRoleSetting } from '../role-setting'

describe('parseRoleSetting', () => {
  it('returns "agent" for the exact "agent" value', () => {
    expect(parseRoleSetting('agent')).toBe('agent')
  })

  it('returns "hub" for the exact "hub" value', () => {
    expect(parseRoleSetting('hub')).toBe('hub')
  })

  it('returns "viewer" for the exact "viewer" value', () => {
    expect(parseRoleSetting('viewer')).toBe('viewer')
  })

  it('falls back to "hub" for anything else (undefined, garbage, wrong type)', () => {
    expect(parseRoleSetting(undefined)).toBe('hub')
    expect(parseRoleSetting(null)).toBe('hub')
    expect(parseRoleSetting('')).toBe('hub')
    expect(parseRoleSetting('Agent')).toBe('hub')
    expect(parseRoleSetting('Viewer')).toBe('hub')
    expect(parseRoleSetting('worker')).toBe('hub')
    expect(parseRoleSetting(42)).toBe('hub')
    expect(parseRoleSetting({ role: 'agent' })).toBe('hub')
  })
})
