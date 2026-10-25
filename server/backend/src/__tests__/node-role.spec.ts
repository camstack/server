import { describe, expect, it } from 'vitest'
import { resolveNodeRole } from '../node-role.js'

describe('resolveNodeRole', () => {
  it('defaults to hub when unset or empty', () => {
    expect(resolveNodeRole({})).toBe('hub')
    expect(resolveNodeRole({ CAMSTACK_ROLE: '' })).toBe('hub')
  })
  it('accepts hub/agent case-insensitively with whitespace', () => {
    expect(resolveNodeRole({ CAMSTACK_ROLE: 'agent' })).toBe('agent')
    expect(resolveNodeRole({ CAMSTACK_ROLE: ' Agent ' })).toBe('agent')
    expect(resolveNodeRole({ CAMSTACK_ROLE: 'HUB' })).toBe('hub')
  })
  it('throws on unknown values', () => {
    expect(() => resolveNodeRole({ CAMSTACK_ROLE: 'worker' })).toThrow(/CAMSTACK_ROLE/)
  })
})
