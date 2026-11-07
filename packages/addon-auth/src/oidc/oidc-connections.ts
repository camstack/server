/**
 * The shape of one OIDC identity provider as the sign-in flow reads it. The records are served as
 * `integration-instances` (kind `oidc-provider`, function cap `login-method`); the flow reads the
 * same rows, resolved.
 */
import type { SecretClearInstruction } from '@camstack/types'

export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export type OidcUsernameClaim = 'preferred_username' | 'email' | 'sub'

export interface OidcProviderRow {
  readonly id: string
  readonly displayName: string
  readonly icon: string
  readonly issuerUrl: string
  readonly clientId: string
  /** Plaintext once resolved for the token call; absent for a public client. */
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

export function connectionConfigured(row: Pick<OidcProviderRow, 'clientId'>): boolean {
  // A public client (PKCE, no secret) is configured with a client id alone.
  return row.clientId.trim() !== ''
}
