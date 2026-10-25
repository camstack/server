/**
 * Which `system-settings` keys the STORE may answer, and which the kernel
 * loads from the door into memory at boot — D675.
 *
 * ## The store never answers for a bootstrap section
 *
 * `system-settings` may still hold `auth.jwtSecret`, `auth.adminUsername` and
 * `auth.adminPassword` — written there by `local-auth` (and by older builds)
 * next to `auth.tokenExpiry`. Since D797 none of the three is a setting at
 * all (the signing key is the keychain's, the first-boot admin is fixed), and
 * the stale rows must still never answer: merging them back in would let a
 * stale DB copy stand in for a credential. The one-off ops script deletes them.
 *
 * So a bootstrap-owned section is answered from env + config.yaml ONLY, and
 * the store may add exactly the keys in {@link STORE_READABLE_BOOTSTRAP_KEYS}:
 * the values the operator edits on System → Authentication (`auth.tokenExpiry`,
 * `auth.accessTokenExpiry`, `auth.trustedProxies`). Widening this list is a security decision, not a
 * convenience.
 */

/** Top-level sections whose authority is env + config.yaml (`bootstrapSchema`). */
const BOOTSTRAP_OWNED_SECTIONS: ReadonlySet<string> = new Set([
  'mode',
  'server',
  'auth',
  'hub',
  'agent',
  'tls',
  'bootstrap',
  // The keychain's master-key location (D788): a stored row must never be
  // able to point the hub at a different key.
  'keychain',
])

/** The only keys under a bootstrap-owned section the store may answer. */
export const STORE_READABLE_BOOTSTRAP_KEYS: ReadonlySet<string> = new Set([
  'auth.tokenExpiry',
  // How long one access token lives before a refreshing client swaps it.
  'auth.accessTokenExpiry',
  // Which proxies' forwarding headers name the client (rate-limit keys).
  'auth.trustedProxies',
  // Opt-in: networks a DIRECT login may skip its second factor from.
  'auth.trustedNetworks',
  // The hub's human name (D861): a plain display string the System -> Settings
  // form edits; nothing security-relevant hangs on it.
  'server.name',
])

/** May the settings store answer `key`, or is it env + config.yaml only? */
export function storeMayAnswer(key: string): boolean {
  const dot = key.indexOf('.')
  const section = dot === -1 ? key : key.slice(0, dot)
  if (!BOOTSTRAP_OWNED_SECTIONS.has(section)) return true
  return STORE_READABLE_BOOTSTRAP_KEYS.has(key)
}

/**
 * Key prefixes loaded from the door into memory ONCE at boot, so the
 * synchronous readers that need them (the capability registry's preference
 * readers, `capabilities.getPreference`) answer the persisted value after a
 * reboot. Capability preferences are the only prefix: every other synchronous
 * caller of `ConfigManager.get` either reads a bootstrap key or runs before the
 * door exists.
 */
export const PRELOADED_SYSTEM_PREFIXES: readonly string[] = ['capabilities.']

/**
 * Single keys loaded the same way. `auth.tokenExpiry` is read synchronously on
 * every mint by the hub's `AuthService` (`AuthManager.signToken`), and
 * `auth.trustedProxies` on every public auth request (`auth-network-policy.ts`).
 */
export const PRELOADED_SYSTEM_KEYS: readonly string[] = [
  'auth.tokenExpiry',
  'auth.accessTokenExpiry',
  'auth.trustedProxies',
  'auth.trustedNetworks',
]

/** Is `key` served from the boot-time mirror when the engine is isolated? */
export function isPreloadedSystemKey(key: string): boolean {
  if (PRELOADED_SYSTEM_KEYS.includes(key)) return true
  return PRELOADED_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * The stored keys of `section` the store may answer (`storeMayAnswer`,
 * D675): everything for an ordinary section, only the allow-listed keys for a
 * bootstrap-owned one.
 */
export function filterStoreSection(
  section: string,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (storeMayAnswer(`${section}.${key}`)) out[key] = value
  }
  return out
}
