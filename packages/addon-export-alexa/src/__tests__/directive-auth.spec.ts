import { describe, it, expect } from 'vitest'
import { extractDirectiveBearer, assertDeviceScope } from '../directive-router.js'

describe('directive auth helpers', () => {
  it('extracts the bearer from endpoint.scope.token', () => {
    const ev = { directive: { endpoint: { scope: { token: 'tok-abc' } }, payload: {} } }
    expect(extractDirectiveBearer(ev)).toBe('tok-abc')
  })
  it('extracts the bearer from payload.scope.token', () => {
    const ev = { directive: { payload: { scope: { token: 'tok-xyz' } } } }
    expect(extractDirectiveBearer(ev)).toBe('tok-xyz')
  })
  it('returns null when no bearer is present', () => {
    expect(extractDirectiveBearer({ directive: { payload: {} } })).toBeNull()
  })
  it('assertDeviceScope passes for a category:device token and throws otherwise', () => {
    expect(() =>
      assertDeviceScope([{ type: 'category', target: 'device', access: ['view'] }]),
    ).not.toThrow()
    expect(() => assertDeviceScope([])).toThrow()
  })
})
