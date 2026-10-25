/**
 * The keychain's cryptography, and nothing else: no I/O, no state.
 *
 * Envelope scheme. A MASTER key (KEK, 32 bytes, never stored in the database)
 * wraps a DATA key (DEK, 32 bytes, stored wrapped in `keychain:keys`), and the
 * DEK encrypts every value. Rotating the master key re-wraps one row; no value
 * is touched.
 *
 *   value:   ck1.<keyId>.<b64 iv(12)>.<b64 tag(16)>.<b64 ciphertext>
 *            AES-256-GCM under the DEK, AAD = the ref — a ciphertext copied
 *            onto another ref does not authenticate.
 *   DEK:     kw1.<b64 iv>.<b64 tag>.<b64 ciphertext>
 *            AES-256-GCM under the KEK, AAD = `camstack-keychain-dek:<keyId>`.
 *   KEK id:  HMAC-SHA256(KEK, "camstack-keychain-v1"), hex — the fingerprint
 *            stored next to the wrapped DEK, so a wrong master key is NAMED
 *            (`wrong-key`) instead of surfacing as a decrypt failure per value.
 *
 * `ck1` / `kw1` version the algorithm: a future scheme adds a prefix, it does
 * not reinterpret this one.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const VALUE_PREFIX = 'ck1'
const WRAP_PREFIX = 'kw1'
const FINGERPRINT_LABEL = 'camstack-keychain-v1'

/** 32 fresh random bytes — a master or a data key. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** A short random id for a data key (no dots — it is a segment of `ck1`). */
export function generateKeyId(): string {
  return randomBytes(8).toString('hex')
}

/** The full fingerprint of a master key. */
export function kekFingerprint(kek: Buffer): string {
  return createHmac('sha256', kek).update(FINGERPRINT_LABEL).digest('hex')
}

/** What the operator sees: the first 16 hex chars. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16)
}

/** Constant-time string equality (lengths may differ). */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Key material from a key file: base64 (the format we write) or hex of
 * exactly 32 bytes, surrounding whitespace ignored. Anything else is `null` —
 * a file holding a password or a PEM is refused, never stretched into a key.
 */
export function decodeKeyMaterial(text: string): Buffer | null {
  const trimmed = text.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  if (!/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) return null
  const buf = Buffer.from(trimmed, 'base64')
  return buf.length === KEY_BYTES ? buf : null
}

export function encodeKeyMaterial(key: Buffer): string {
  return key.toString('base64')
}

function seal(key: Buffer, plaintext: Buffer, aad: string): readonly [string, string, string] {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')]
}

function open(
  key: Buffer,
  ivB64: string,
  tagB64: string,
  ctB64: string,
  aad: string,
): Buffer | null {
  try {
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()])
  } catch {
    return null
  }
}

function dekAad(keyId: string): string {
  return `camstack-keychain-dek:${keyId}`
}

/** Wrap a data key under a master key. */
export function wrapDek(kek: Buffer, dek: Buffer, keyId: string): string {
  const [iv, tag, ct] = seal(kek, dek, dekAad(keyId))
  return `${WRAP_PREFIX}.${iv}.${tag}.${ct}`
}

/** Unwrap; `null` when the master key is not the one that wrapped it. */
export function unwrapDek(kek: Buffer, wrapped: string, keyId: string): Buffer | null {
  const parts = wrapped.split('.')
  if (parts.length !== 4 || parts[0] !== WRAP_PREFIX) return null
  const [, iv, tag, ct] = parts
  if (iv === undefined || tag === undefined || ct === undefined) return null
  const dek = open(kek, iv, tag, ct, dekAad(keyId))
  return dek !== null && dek.length === KEY_BYTES ? dek : null
}

/** Encrypt one value for one ref. */
export function encryptValue(dek: Buffer, keyId: string, ref: string, value: string): string {
  const [iv, tag, ct] = seal(dek, Buffer.from(value, 'utf8'), ref)
  return `${VALUE_PREFIX}.${keyId}.${iv}.${tag}.${ct}`
}

/** The data-key id an envelope was written under, or `null` if it is not one. */
export function envelopeKeyId(envelope: string): string | null {
  const parts = envelope.split('.')
  if (parts.length !== 5 || parts[0] !== VALUE_PREFIX) return null
  return parts[1] ?? null
}

/** Decrypt; `null` on any failure — wrong key, wrong ref, tampered bytes. */
export function decryptValue(dek: Buffer, ref: string, envelope: string): string | null {
  const parts = envelope.split('.')
  if (parts.length !== 5 || parts[0] !== VALUE_PREFIX) return null
  const [, , iv, tag, ct] = parts
  if (iv === undefined || tag === undefined || ct === undefined) return null
  const plain = open(dek, iv, tag, ct, ref)
  return plain === null ? null : plain.toString('utf8')
}
