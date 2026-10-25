/**
 * The ONE enable of an auth addon (D777).
 *
 * Identity → Authentication shows each auth addon once, with an
 * Enable/Disable toggle on the capability it provides there: `auth-provider`
 * for login providers (local password, OIDC), `user-passkeys` for
 * passkeys. That toggle is the only switch — addons carry no private
 * `enabled` setting. An addon registers further caps (`login-method`,
 * `addon-routes`) that the page does not toggle, so every hub surface that
 * offers or completes a login asks THIS gate rather than the registry state of
 * whichever cap it happens to read.
 *
 * Keep in step with `AUTH_CAPS` in the admin-ui Authentication page.
 */
import type { CapabilityRegistry } from '@camstack/system'

/** Capabilities whose per-provider toggle is an auth addon's enable. */
export const AUTH_GOVERNING_CAPS = ['auth-provider', 'user-passkeys'] as const

export type ProviderDisabledLookup = Pick<CapabilityRegistry, 'isProviderDisabled'>

/** Whether the operator disabled `addonId` on Identity → Authentication. */
export function isAuthAddonDisabled(registry: ProviderDisabledLookup, addonId: string): boolean {
  return AUTH_GOVERNING_CAPS.some((cap) => registry.isProviderDisabled(cap, addonId))
}

/**
 * The addon behind an SSO bridge's `provider` claim: `auth-oidc/<instance>`
 * is signed by `auth-oidc`, anything else names its addon directly.
 */
export function bridgeProviderAddonId(provider: string): string {
  const slash = provider.indexOf('/')
  return slash === -1 ? provider : provider.slice(0, slash)
}
