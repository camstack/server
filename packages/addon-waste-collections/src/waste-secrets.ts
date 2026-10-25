/**
 * Which service arguments are credentials (D880), and how they are kept off every
 * read surface.
 *
 * A source's arguments are typed by the service catalog (`waste-catalog.ts`); the
 * catalog is generated from the vendored Python signatures, which carry no
 * "secret" flag. The credential keys are therefore NAMED here, once, and a spec
 * walks the whole catalog and fails when a credential-looking argument is in
 * neither list - so a new service cannot add a credential unseen.
 *
 * A listed argument is stored in the keychain exactly like a settings
 * `password` field (`secretStatePaths`, owner `waste-collections`); the row
 * keeps a marker, `this.config` reads the value.
 */
import { isSecretMarker, REDACTED_SECRET } from '@camstack/types'

/** Argument keys holding a credential, wherever a service declares them. */
export const SECRET_ARG_KEYS: readonly string[] = [
  'password',
  'api_key',
  'token',
  'authorization',
  'pin',
  'account_pin',
]

/**
 * Credential-LOOKING argument keys the catalog carries that are NOT secrets, with why.
 * `key` is the per-municipality lookup id of the abfall.io family (printed in the
 * public calendar page URL), not an account credential.
 */
export const REVIEWED_NON_SECRET_ARG_KEYS: Readonly<Record<string, string>> = {
  key: 'public per-municipality lookup id (abfall.io), shown in the calendar page URL',
  mapkey: 'public map layer id',
  email:
    'account identifier (PII), not a credential on its own; the password/pin next to it is the secret',
  username: 'account identifier (PII), not a credential on its own',
  phone: 'account identifier (PII), not a credential on its own',
  uuid: 'installation/property identifier, not an authenticator',
  device_id: 'installation/device identifier, not an authenticator',
  account_number: 'customer number printed on the bill, not an authenticator',
}

/** The `secretStatePaths` of the `sources` array: `sources[id].args.<key>`. */
export const WASTE_SECRET_STATE_PATHS: readonly string[] = SECRET_ARG_KEYS.map(
  (key) => `sources[id].args.${key}`,
)

/** Case-insensitive: `PIN` and `pin` are the same credential. */
export function isSecretArg(key: string): boolean {
  return SECRET_ARG_KEYS.includes(key.toLowerCase())
}

/** Is a credential stored for this argument (a value, or a marker the keychain could not serve)? */
function isSet(value: unknown): boolean {
  return isSecretMarker(value) || (typeof value === 'string' && value.length > 0)
}

/** The arguments as a read surface may show them: a stored credential is the redaction token. */
export function redactArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = isSecretArg(key) && isSet(value) ? REDACTED_SECRET : value
  }
  return out
}

/**
 * The write-back of {@link redactArgs}: a credential sent back as the redaction
 * token means "keep what is stored", so it takes the stored (resolved) value; one
 * with nothing stored is dropped, never saved as the token.
 */
export function restoreRedactedArgs(
  incoming: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (isSecretArg(key) && value === REDACTED_SECRET) {
      const previous = stored[key]
      if (previous !== undefined) out[key] = previous
      continue
    }
    out[key] = value
  }
  return out
}

/** Does this argument bag hold a credential that is a MARKER the keychain did not resolve? */
export function hasUnresolvedCredential(args: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(args).some(([key, value]) => isSecretArg(key) && isSecretMarker(value))
}

/** Does it hold a non-empty credential (any form)? */
export function hasCredential(args: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(args).some(([key, value]) => isSecretArg(key) && isSet(value))
}
