import { describe, expect, it } from 'vitest'
import { bridgeProviderAddonId, isAuthAddonDisabled } from '../auth-provider-gate.js'

/**
 * D777 — an auth addon's ONE enable is its provider toggle on Identity →
 * Authentication: `auth-provider` for login providers, `user-passkeys` for
 * passkeys. Every hub surface that offers or completes a login asks this gate.
 */

function registry(disabled: ReadonlyArray<readonly [string, string]>) {
  return {
    isProviderDisabled: (capability: string, addonId: string): boolean =>
      disabled.some(([cap, id]) => cap === capability && id === addonId),
  }
}

describe('isAuthAddonDisabled', () => {
  it('is true for an addon disabled at auth-provider', () => {
    expect(isAuthAddonDisabled(registry([['auth-provider', 'auth-oidc']]), 'auth-oidc')).toBe(true)
  })

  it('is true for an addon disabled at user-passkeys', () => {
    expect(
      isAuthAddonDisabled(registry([['user-passkeys', 'auth-webauthn']]), 'auth-webauthn'),
    ).toBe(true)
  })

  it('ignores a disable at an unrelated cap', () => {
    expect(isAuthAddonDisabled(registry([['addon-routes', 'auth-oidc']]), 'auth-oidc')).toBe(false)
  })

  it('is false for an enabled addon', () => {
    expect(isAuthAddonDisabled(registry([['auth-provider', 'auth-oidc']]), 'auth-webauthn')).toBe(
      false,
    )
  })
})

describe('bridgeProviderAddonId', () => {
  it('maps an OIDC instance bridge to the addon', () => {
    expect(bridgeProviderAddonId('auth-oidc/google')).toBe('auth-oidc')
  })

  it('maps a bridge without an instance to the addon it names', () => {
    expect(bridgeProviderAddonId('auth-saml')).toBe('auth-saml')
  })
})
