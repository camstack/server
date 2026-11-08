/**
 * The addon declares no settings schema: the identity providers are records, not settings fields.
 */
import { describe, expect, it } from 'vitest'
import { AuthOidcAddon } from '../auth-oidc.addon.js'

describe('AuthOidcAddon settings schema', () => {
  it('declares no scoped settings: connections are records, not settings fields', async () => {
    expect(await new AuthOidcAddon().listScopedSettings()).toEqual([])
  })
})
