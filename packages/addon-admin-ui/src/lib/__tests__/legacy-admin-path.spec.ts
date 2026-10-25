import { describe, expect, it } from 'vitest'
import { stripLegacyAdminPrefix } from '../legacy-admin-path'

describe('stripLegacyAdminPrefix', () => {
  it('maps an /admin route onto the real route', () => {
    expect(stripLegacyAdminPrefix('/admin/system/my-access')).toBe('/system/my-access')
    expect(stripLegacyAdminPrefix('/admin/login')).toBe('/login')
  })

  it('maps the bare /admin onto the app root', () => {
    expect(stripLegacyAdminPrefix('/admin')).toBe('/')
    expect(stripLegacyAdminPrefix('/admin/')).toBe('/')
  })

  it('leaves other paths alone', () => {
    expect(stripLegacyAdminPrefix('/system/my-access')).toBe('/system/my-access')
    expect(stripLegacyAdminPrefix('/administration')).toBe('/administration')
  })
})
