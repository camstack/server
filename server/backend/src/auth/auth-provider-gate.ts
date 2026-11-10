/**
 * The ONE enable of an auth addon (D777).
 *
 * An auth addon is switched off on the capability it provides: `auth-provider`
 * (login providers), `user-passkeys` (passkeys), or `login-method` — the switch
 * of a provider's row in Identity → Authentication (the passkey row keeps no
 * records, so its switch is the addon's). Addons carry no private `enabled`
 * setting, and every hub surface that offers or completes a login asks THIS
 * gate rather than the registry state of whichever cap it happens to read.
 */
import type { CapabilityRegistry } from "@camstack/server/system";

/** Capabilities whose per-provider toggle is an auth addon's enable. */
export const AUTH_GOVERNING_CAPS = [
  "auth-provider",
  "user-passkeys",
  "login-method",
] as const;

export type ProviderDisabledLookup = Pick<
  CapabilityRegistry,
  "isProviderDisabled"
>;

/** Whether the operator disabled `addonId` on Identity → Authentication. */
export function isAuthAddonDisabled(
  registry: ProviderDisabledLookup,
  addonId: string,
): boolean {
  return AUTH_GOVERNING_CAPS.some((cap) =>
    registry.isProviderDisabled(cap, addonId),
  );
}

/**
 * The addon behind an SSO bridge's `provider` claim: `auth-oidc/<instance>`
 * is signed by `auth-oidc`, anything else names its addon directly.
 */
export function bridgeProviderAddonId(provider: string): string {
  const slash = provider.indexOf("/");
  return slash === -1 ? provider : provider.slice(0, slash);
}
