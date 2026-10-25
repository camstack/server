import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_KEY_FILE_NAME,
  LegacyCiphertextError,
  loadLegacyKey,
  RETIRED_CIPHERTEXT_PREFIX,
  resolveStoredPassword,
  retiredCiphertextPaths,
} from '../retired-ciphertext.js'

/**
 * D797 bridge: until the operator's one-off `mqtt` step has moved them into
 * the keychain, the hub's `enc:v1` broker passwords keep working — decrypted
 * READ-ONLY with the existing `.secret-key` (no env, no re-encrypt, no write).
 * Without that key an `enc:v1` value is an ERROR, never "no password".
 */
function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(text, 'utf-8'), c.final()])
  return `${RETIRED_CIPHERTEXT_PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-legacy-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the read-only enc:v1 bridge', () => {
  it('resolves an enc:v1 value with the key file present', () => {
    const key = randomBytes(32)
    fs.writeFileSync(path.join(dir, LEGACY_KEY_FILE_NAME), key)
    const legacy = loadLegacyKey(dir)
    expect(legacy.kind).toBe('key')
    expect(resolveStoredPassword(encrypt('broker-pw', key), legacy)).toBe('broker-pw')
  })

  it('derives a non-32-byte key file like the retired codec (scrypt)', () => {
    fs.writeFileSync(path.join(dir, LEGACY_KEY_FILE_NAME), 'an old passphrase')
    const key = scryptSync('an old passphrase', Buffer.from('camstack-mqtt-broker:v1', 'utf-8'), 32)
    expect(resolveStoredPassword(encrypt('pw-2', key), loadLegacyKey(dir))).toBe('pw-2')
  })

  it('with the key file absent, an enc:v1 value is a clear error — never "no password"', () => {
    const legacy = loadLegacyKey(dir)
    expect(legacy.kind).toBe('absent')
    const value = encrypt('broker-pw', randomBytes(32))
    expect(() => resolveStoredPassword(value, legacy)).toThrow(LegacyCiphertextError)
    expect(() => resolveStoredPassword(value, legacy)).toThrow(/mqtt step/)
  })

  it('a wrong key is an error too, and the message never carries the value', () => {
    fs.writeFileSync(path.join(dir, LEGACY_KEY_FILE_NAME), randomBytes(32))
    const value = encrypt('broker-pw', randomBytes(32))
    let message = ''
    try {
      resolveStoredPassword(value, loadLegacyKey(dir))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/did not decrypt/)
    expect(message).not.toContain(value)
  })

  it('after migration the keychain value wins: a resolved password passes through untouched', () => {
    fs.writeFileSync(path.join(dir, LEGACY_KEY_FILE_NAME), randomBytes(32))
    expect(resolveStoredPassword('from-the-keychain', loadLegacyKey(dir))).toBe('from-the-keychain')
    expect(resolveStoredPassword('from-the-keychain', { kind: 'absent' })).toBe('from-the-keychain')
  })

  it('absent and empty stay "no password"', () => {
    expect(resolveStoredPassword(undefined, { kind: 'absent' })).toBeUndefined()
    expect(resolveStoredPassword('', { kind: 'absent' })).toBeUndefined()
  })

  it('never writes or creates the key file', () => {
    loadLegacyKey(dir)
    expect(fs.existsSync(path.join(dir, LEGACY_KEY_FILE_NAME))).toBe(false)
  })
})

describe('retiredCiphertextPaths', () => {
  const OLD = `${RETIRED_CIPHERTEXT_PREFIX}aXY=:dGFn:Ym9keQ==`
  it('names every field still holding an enc:v1 value, by broker id — never the value', () => {
    const paths = retiredCiphertextPaths({
      brokers: [{ id: 'a', password: OLD }, { id: 'b', password: 'resolved-plain' }, { id: 'c' }],
      embeddedPassword: OLD,
    })
    expect(paths).toEqual(['brokers[a].password', 'embeddedPassword'])
    expect(JSON.stringify(paths)).not.toContain('aXY=')
  })

  it('is empty when nothing is left over', () => {
    expect(retiredCiphertextPaths({ brokers: [], embeddedPassword: '' })).toEqual([])
  })
})
