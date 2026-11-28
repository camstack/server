import { describe, expect, it } from 'vitest'
import { resolveNodeRole } from '../node-role.js'

describe('resolveNodeRole', () => {
  it('defaults to hub when unset or empty', () => {
    expect(resolveNodeRole({})).toBe('hub')
    expect(resolveNodeRole({ DOMINEVO_ROLE: '' })).toBe('hub')
  })
  it('accepts hub/agent case-insensitively with whitespace', () => {
    expect(resolveNodeRole({ DOMINEVO_ROLE: 'agent' })).toBe('agent')
    expect(resolveNodeRole({ DOMINEVO_ROLE: ' Agent ' })).toBe('agent')
    expect(resolveNodeRole({ DOMINEVO_ROLE: 'HUB' })).toBe('hub')
  })
  it('throws on unknown values', () => {
    expect(() => resolveNodeRole({ DOMINEVO_ROLE: 'worker' })).toThrow(/DOMINEVO_ROLE/)
  })
})
