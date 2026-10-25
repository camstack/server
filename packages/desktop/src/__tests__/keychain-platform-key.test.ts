import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KEYCHAIN_KEY_FILE_NAME,
  loadOrCreatePlatformKeychainKey,
  type SafeStorageLike,
} from '../keychain-platform-key'

// A reversible stand-in for the OS keychain: what matters is that the file
// never holds the raw key and that the same key comes back.
const fakeSafeStorage = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).reverse().toString('hex')}`),
  decryptString: (buf) => {
    const s = buf.toString()
    if (!s.startsWith('enc:')) throw new Error('not ours')
    return Buffer.from(s.slice(4), 'hex').reverse().toString()
  },
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-desktop-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('hub keychain master key in the OS keychain', () => {
  it('creates a key once, stores it only encrypted (0600), and returns the same key after', () => {
    const first = loadOrCreatePlatformKeychainKey(dir, fakeSafeStorage())
    expect(first.kind).toBe('key')
    const file = path.join(dir, KEYCHAIN_KEY_FILE_NAME)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    if (first.kind !== 'key') return
    expect(fs.readFileSync(file).toString()).not.toContain(first.key.toString('base64'))
    const second = loadOrCreatePlatformKeychainKey(dir, fakeSafeStorage())
    expect(second.kind === 'key' && second.key.equals(first.key) && !second.created).toBe(true)
  })

  it('without OS encryption there is no platform key — and nothing is written', () => {
    expect(loadOrCreatePlatformKeychainKey(dir, fakeSafeStorage(false)).kind).toBe('unavailable')
    expect(fs.existsSync(path.join(dir, KEYCHAIN_KEY_FILE_NAME))).toBe(false)
  })

  it('a stored key that no longer decrypts is never replaced by a new one', () => {
    fs.writeFileSync(path.join(dir, KEYCHAIN_KEY_FILE_NAME), 'garbage')
    expect(loadOrCreatePlatformKeychainKey(dir, fakeSafeStorage()).kind).toBe('unavailable')
    expect(fs.readFileSync(path.join(dir, KEYCHAIN_KEY_FILE_NAME), 'utf8')).toBe('garbage')
  })
})
