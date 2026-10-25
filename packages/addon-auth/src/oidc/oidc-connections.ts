/**
 * Pure helpers for OIDC connection rows in `config.providers`.
 */
import {
  arrayItemFieldPath,
  globalSecretScope,
  isSecretClear,
  isSecretMarker,
  toSecretFieldView,
  type SecretClearInstruction,
  type SecretFieldView,
  type SecretsAccess,
} from '@camstack/types'

export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export type OidcUsernameClaim = 'preferred_username' | 'email' | 'sub'

export interface OidcProviderRow {
  readonly id: string
  readonly displayName: string
  readonly icon: string
  readonly issuerUrl: string
  readonly clientId: string
  /** Plaintext, keychain marker, or {@link SecretClearInstruction} on write. */
  readonly clientSecret: string | SecretClearInstruction
  readonly redirectUri: string
  readonly scopes: string
  readonly usernameClaim: OidcUsernameClaim
}

export interface OidcProvidersConfig {
  readonly providers: readonly OidcProviderRow[]
}

export const DEFAULT_OIDC_PROVIDER: OidcProviderRow = {
  id: 'default',
  displayName: 'OpenID Connect',
  icon: 'shield-check',
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username',
}

export function findOidcProvider(config: OidcProvidersConfig, id: string): OidcProviderRow | null {
  return config.providers.find((p) => p.id === id) ?? null
}

export function connectionConfigured(row: OidcProviderRow): boolean {
  const secret = typeof row.clientSecret === 'string' ? row.clientSecret.trim() : ''
  return row.clientId.trim() !== '' && secret !== ''
}

export function clientSecretView(
  clientSecret: unknown,
  secrets: SecretsAccess | undefined,
  connectionId: string,
): SecretFieldView | null {
  if (isSecretMarker(clientSecret)) return toSecretFieldView(clientSecret)
  const plain = typeof clientSecret === 'string' ? clientSecret.trim() : ''
  if (plain === '') return null
  if (secrets === undefined) return toSecretFieldView(plain)
  return {
    $secret: secrets.ref(
      globalSecretScope(),
      arrayItemFieldPath('providers', connectionId, 'clientSecret'),
    ),
    v: 1,
    set: true,
  }
}

export type CreateOidcConnectionResult =
  | { readonly ok: true; readonly config: OidcProvidersConfig; readonly id: string }
  | { readonly ok: false; readonly reason: 'invalid-id' | 'duplicate-id' }

export function createOidcConnection(
  config: OidcProvidersConfig,
  input: { readonly id: string; readonly displayName: string },
): CreateOidcConnectionResult {
  const id = input.id.trim()
  if (!INSTANCE_ID_PATTERN.test(id)) return { ok: false, reason: 'invalid-id' }
  if (config.providers.some((p) => p.id === id)) return { ok: false, reason: 'duplicate-id' }
  const row: OidcProviderRow = {
    ...DEFAULT_OIDC_PROVIDER,
    id,
    displayName: input.displayName.trim() || DEFAULT_OIDC_PROVIDER.displayName,
  }
  return { ok: true, id, config: { providers: [...config.providers, row] } }
}

export interface UpdateOidcConnectionPatch {
  readonly displayName: string
  readonly icon?: string
  readonly issuerUrl?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly clearClientSecret?: boolean
  readonly redirectUri?: string
  readonly scopes?: string
  readonly usernameClaim?: OidcUsernameClaim
}

export type UpdateOidcConnectionResult =
  | {
      readonly ok: true
      readonly config: OidcProvidersConfig
      readonly clearClientSecret: boolean
    }
  | { readonly ok: false; readonly reason: 'not-found' }

export function updateOidcConnection(
  config: OidcProvidersConfig,
  id: string,
  patch: UpdateOidcConnectionPatch,
): UpdateOidcConnectionResult {
  const idx = config.providers.findIndex((p) => p.id === id)
  if (idx < 0) return { ok: false, reason: 'not-found' }
  const prev = config.providers[idx]
  if (prev === undefined) return { ok: false, reason: 'not-found' }
  const next: OidcProviderRow = {
    ...prev,
    displayName: patch.displayName.trim() || prev.displayName,
    ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
    ...(patch.issuerUrl !== undefined ? { issuerUrl: patch.issuerUrl } : {}),
    ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
    ...(patch.clientSecret !== undefined ? { clientSecret: patch.clientSecret } : {}),
    ...(patch.redirectUri !== undefined ? { redirectUri: patch.redirectUri } : {}),
    ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
    ...(patch.usernameClaim !== undefined ? { usernameClaim: patch.usernameClaim } : {}),
  }
  const providers = config.providers.map((p, i) => (i === idx ? next : p))
  return {
    ok: true,
    config: { providers },
    clearClientSecret: patch.clearClientSecret === true,
  }
}

export type DeleteOidcConnectionResult =
  | { readonly ok: true; readonly config: OidcProvidersConfig }
  | { readonly ok: false; readonly reason: 'not-found' }

export function deleteOidcConnection(
  config: OidcProvidersConfig,
  id: string,
): DeleteOidcConnectionResult {
  if (!config.providers.some((p) => p.id === id)) return { ok: false, reason: 'not-found' }
  return { ok: true, config: { providers: config.providers.filter((p) => p.id !== id) } }
}

/** Map a wire `clientSecret` field into an update patch fragment. */
export function clientSecretPatchOf(
  value: string | SecretClearInstruction | undefined,
): Pick<UpdateOidcConnectionPatch, 'clientSecret' | 'clearClientSecret'> {
  if (value === undefined) return {}
  if (isSecretClear(value)) return { clearClientSecret: true }
  if (value === '') return {}
  return { clientSecret: value }
}
