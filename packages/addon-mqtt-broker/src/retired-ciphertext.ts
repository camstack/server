/**
 * The retired `enc:v1` codec — a READ-ONLY bridge until the hub is migrated.
 *
 * Broker passwords are `type: 'password'` fields, so they live in the
 * keychain like every other secret (D787, D797) and `this.config` hands this
 * addon the resolved value. The addon's own AES-GCM codec is retired: nothing
 * is encrypted with it any more, nothing is re-encrypted, no key is generated,
 * and no key comes from the environment (`CAMSTACK_SECRET_KEY` is gone).
 *
 * A hub that has not yet run the one-off operator step
 * (`scripts/ops/keychain-migrate-hub.mjs mqtt`) still stores `enc:v1:` strings.
 * So that a release never takes MQTT's credentials away, such a value is
 * DECRYPTED READ-ONLY with the existing `<addon data dir>/.secret-key`. Once
 * the step has run, the stored values are keychain markers, `this.config`
 * holds plaintext, and this path is dead.
 *
 * Without that key file (or with the wrong one) an `enc:v1` value is an ERROR
 * naming the field — never "no password", which would silently connect
 * anonymously.
 */
import { createDecipheriv, scryptSync } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The prefix every value the retired codec wrote starts with. */
export const RETIRED_CIPHERTEXT_PREFIX = 'enc:v1:'

/** The retired codec's key file, in the addon's data dir. Read, never written. */
export const LEGACY_KEY_FILE_NAME = '.secret-key'

const KEY_BYTES = 32
const SCRYPT_SALT = Buffer.from('camstack-mqtt-broker:v1', 'utf-8')

export type LegacyKey =
  | { readonly kind: 'key'; readonly key: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }

/** An `enc:v1` value that cannot be turned back into its password. */
export class LegacyCiphertextError extends Error {
  constructor(reason: string) {
    super(
      `mqtt-broker: a stored password is still in the retired enc:v1 form and ${reason} — ` +
        'run the one-off mqtt step of scripts/ops/keychain-migrate-hub.mjs, or re-enter the password',
    )
    this.name = 'LegacyCiphertextError'
  }
}

/** Read the retired codec's key file once. Never creates or writes it. */
export function loadLegacyKey(dataDir: string): LegacyKey {
  const file = path.join(dataDir, LEGACY_KEY_FILE_NAME)
  let raw: Buffer
  try {
    raw = fs.readFileSync(file)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }
  }
  // Exactly as the retired codec read it: 32 raw bytes, else a passphrase.
  const key =
    raw.length === KEY_BYTES ? raw : scryptSync(raw.toString('utf-8'), SCRYPT_SALT, KEY_BYTES)
  return { kind: 'key', key }
}

function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.slice(RETIRED_CIPHERTEXT_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('malformed')
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer]
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
}

/**
 * The credential a stored password stands for: the value itself (keychain-
 * resolved), `undefined` for absent / empty, the decrypted password for a
 * leftover `enc:v1` value — or a {@link LegacyCiphertextError} when that value
 * cannot be decrypted. Never `undefined` for an `enc:v1` value.
 */
export function resolveStoredPassword(
  value: string | undefined,
  legacy: LegacyKey,
): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  if (!value.startsWith(RETIRED_CIPHERTEXT_PREFIX)) return value
  if (legacy.kind === 'absent') {
    throw new LegacyCiphertextError(`the old key file (${LEGACY_KEY_FILE_NAME}) is gone`)
  }
  if (legacy.kind === 'unreadable') {
    throw new LegacyCiphertextError(`the old key file could not be read (${legacy.error})`)
  }
  try {
    return decrypt(value, legacy.key)
  } catch {
    throw new LegacyCiphertextError('it did not decrypt with the old key file')
  }
}

interface StoredPasswords {
  readonly brokers: readonly { readonly id: string; readonly password?: string }[]
  readonly embeddedPassword: string
}

/** The field paths that still hold a retired ciphertext, keychain-ref style. */
export function retiredCiphertextPaths(config: StoredPasswords): readonly string[] {
  const out: string[] = []
  for (const b of config.brokers) {
    if (b.password?.startsWith(RETIRED_CIPHERTEXT_PREFIX) === true) {
      out.push(`brokers[${b.id}].password`)
    }
  }
  if (config.embeddedPassword.startsWith(RETIRED_CIPHERTEXT_PREFIX)) out.push('embeddedPassword')
  return out
}
