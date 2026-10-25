import { describe, it, expect } from 'vitest'
import type { TokenScope } from '@camstack/types'
import { scopesAllowDeviceCap } from '../scope-matcher.js'

const deviceScope: TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]

describe('scopesAllowDeviceCap', () => {
  it('allows a device cap when a category:device scope is present', () => {
    expect(scopesAllowDeviceCap(deviceScope, 'view')).toBe(true)
    expect(scopesAllowDeviceCap(deviceScope, 'create')).toBe(true)
  })
  it('denies when the access level is not granted', () => {
    expect(
      scopesAllowDeviceCap([{ type: 'category', target: 'device', access: ['view'] }], 'create'),
    ).toBe(false)
  })
  it('denies when there is no device scope', () => {
    expect(
      scopesAllowDeviceCap([{ type: 'category', target: 'system', access: ['view'] }], 'view'),
    ).toBe(false)
    expect(scopesAllowDeviceCap([], 'view')).toBe(false)
  })
})
