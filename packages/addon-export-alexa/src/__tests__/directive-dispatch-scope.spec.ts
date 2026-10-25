import { describe, it, expect } from 'vitest'
import { requireDeviceScope } from '../directive-router.js'

describe('requireDeviceScope', () => {
  it('returns for a control-capable token', () => {
    expect(() =>
      requireDeviceScope(
        [{ type: 'category', target: 'device', access: ['view', 'create'] }],
        'create',
      ),
    ).not.toThrow()
  })
  it('throws when the token cannot control devices', () => {
    expect(() =>
      requireDeviceScope([{ type: 'category', target: 'device', access: ['view'] }], 'create'),
    ).toThrow()
  })
})
