/**
 * The `AuthConfigReader` shim `local-auth` hands to its own `AuthManager`.
 *
 * WHY IT IS AN ALLOW-LIST AND STAYS ONE. `AuthConfigReader.get` is
 * SYNCHRONOUS; `ctx.settings.getSection` is a promise over the hub's settings
 * store. The addon therefore resolves the handful of paths its AuthManager
 * actually consults ONCE, in `onInitialize`, and answers only those. The
 * whitelist is not decoration: it is the list of values that were awaited, and
 * a path outside it has no resolved value to return. Widening it means
 * pre-resolving one more value here — never "let the addon read arbitrary host
 * config", which it structurally cannot do anyway.
 *
 * `auth.tokenExpiry` was the path that fell off the end. It was declared,
 * editable and mapped to the `auth` yml section, and this reader answered
 * `undefined` for it, so this AuthManager always signed with the hardcoded
 * fallback no matter what the operator set.
 */
import type { AuthConfigReader } from '../../auth/auth-manager.js'

/**
 * The values `local-auth` pre-resolves before constructing its AuthManager.
 *
 * No credential is among them (D797): the session signing key lives in the
 * keychain (`jwt-signing-key.ts`) and the first-boot admin is fixed
 * (`admin` / `changeme`), so `auth.jwtSecret`, `auth.adminUsername` and
 * `auth.adminPassword` are answered by nothing.
 */
export interface ResolvedAuthConfig {
  /**
   * Operator-configured session lifetime. `undefined` when the `auth` section
   * carries no value — the signer then applies `DEFAULT_TOKEN_EXPIRY`, which
   * is where the default belongs (one default, one place).
   */
  readonly tokenExpiry: string | undefined
}

/**
 * Every config path this reader can answer. Anything else resolves to
 * `undefined` by construction — see the module docblock.
 */
export function createAuthConfigReader(resolved: ResolvedAuthConfig): AuthConfigReader {
  return {
    get<T>(path: string): T | undefined {
      switch (path) {
        case 'auth.tokenExpiry':
          return narrow<T>(resolved.tokenExpiry)
        default:
          return undefined
      }
    },
    // Nothing is written back: the reader persists no value of its own.
    update(): void {},
  }
}

/**
 * The one documented type boundary in this module. `AuthConfigReader.get` is
 * the legacy `get<T>(path)` shape shared with `ConfigManager.get`, which is
 * likewise unchecked at runtime — every value returned here is a `string |
 * undefined` the caller immediately re-validates (`parseTokenExpiry`).
 */
function narrow<T>(value: string | undefined): T | undefined {
  return value as T | undefined
}
