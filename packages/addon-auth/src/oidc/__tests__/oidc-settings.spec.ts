/**
 * The addon declares no settings schema: the identity providers are records, not settings fields.
 */
import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AuthOidcAddon } from '../auth-oidc.addon.js'

class Probe extends AuthOidcAddon {
  globalFormForTest(): ConfigUISchema | null {
    return this.globalSettingsSchema()
  }
}

describe('AuthOidcAddon settings schema', () => {
  it('declares no global schema: connections are records, not settings fields', () => {
    expect(new Probe().globalFormForTest()).toBeNull()
  })
})
