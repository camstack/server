/**
 * Build the {@link SecretFieldView} the Providers edit form needs for an
 * entry's token secret.
 *
 * `readStoredGlobalKey` / `this.config` answer VALUES (D798), never markers —
 * so `toSecretFieldView(plaintext)` alone yields an inline view (`$secret:
 * null`) and `SecretFieldControl` cannot reveal. When the secret is set we
 * prefer the deterministic keychain ref (`ctx.secrets.ref`) so the eye can
 * call `keychain-admin.reveal` (D789).
 */
import {
  arrayItemFieldPath,
  globalSecretScope,
  isSecretMarker,
  toSecretFieldView,
  type SecretFieldView,
  type SecretsAccess,
} from '@camstack/types'

/** View for one entry row, or `null` when nothing is stored. */
export function entryTokenSecretView(
  tokenSecret: unknown,
  secrets: SecretsAccess | undefined,
  entryId: string,
): SecretFieldView | null {
  if (isSecretMarker(tokenSecret)) return toSecretFieldView(tokenSecret)
  const plain = typeof tokenSecret === 'string' ? tokenSecret.trim() : ''
  if (plain === '') return null
  if (secrets === undefined) return toSecretFieldView(plain)
  return {
    $secret: secrets.ref(
      globalSecretScope(),
      arrayItemFieldPath('entries', entryId, 'tokenSecret'),
    ),
    v: 1,
    set: true,
  }
}

/** View for the legacy flat `tokenSecret` (pre-multi-entry Default). */
export function flatTokenSecretView(
  tokenSecret: unknown,
  secrets: SecretsAccess | undefined,
): SecretFieldView | null {
  if (isSecretMarker(tokenSecret)) return toSecretFieldView(tokenSecret)
  const plain = typeof tokenSecret === 'string' ? tokenSecret.trim() : ''
  if (plain === '') return null
  if (secrets === undefined) return toSecretFieldView(plain)
  return {
    $secret: secrets.ref(globalSecretScope(), 'tokenSecret'),
    v: 1,
    set: true,
  }
}
