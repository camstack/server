/**
 * The hub keychain's master key on a DESKTOP hub lives in the OS keychain
 * (D788): macOS Keychain, Windows DPAPI, the Linux secret service — whatever
 * Electron's `safeStorage` is backed by.
 *
 * `safeStorage` exists only in this (Electron main) process and the hub runs
 * as a plain Node child, so this module reads or creates the key here and the
 * caller hands the RAW bytes to the hub over an inherited pipe
 * (`--keychain-key-fd=3`). Never an env var: a child's environment is readable
 * by every process of the same user and is copied into every runner it forks.
 *
 * At rest the key is `safeStorage.encryptString(base64)` in the app's user-data
 * directory (0600). Without OS encryption (`isEncryptionAvailable() === false`,
 * e.g. a Linux session with no secret service) there is no platform key: the
 * hub falls back to its default key file and says so on the Secrets page.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { writeOwnerOnlyFileSync } from '@camstack/owner-only-file'

/** The slice of Electron's `safeStorage` this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export const KEYCHAIN_KEY_FILE_NAME = 'keychain-master.enc'
/** The descriptor the hub reads the key from (stdin/out/err are 0-2). */
export const KEYCHAIN_KEY_FD = 3
export const KEYCHAIN_KEY_FD_ARG = `--keychain-key-fd=${KEYCHAIN_KEY_FD}`

const KEY_BYTES = 32

export type PlatformKeyResult =
  | { readonly kind: 'key'; readonly key: Buffer; readonly created: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Read the master key from `<userDataDir>/keychain-master.enc`, creating it on
 * first use. A file that exists but does not decrypt is NOT replaced — a new
 * key would make every stored value unreadable; the hub locks instead.
 */
export function loadOrCreatePlatformKeychainKey(
  userDataDir: string,
  safeStorage: SafeStorageLike,
): PlatformKeyResult {
  if (!safeStorage.isEncryptionAvailable()) {
    return { kind: 'unavailable', reason: 'OS encryption is not available to this session' }
  }
  const file = path.join(userDataDir, KEYCHAIN_KEY_FILE_NAME)
  if (fs.existsSync(file)) {
    try {
      const text = safeStorage.decryptString(fs.readFileSync(file))
      const key = Buffer.from(text.trim(), 'base64')
      if (key.length !== KEY_BYTES)
        return { kind: 'unavailable', reason: 'stored key is malformed' }
      return { kind: 'key', key, created: false }
    } catch (err: unknown) {
      return {
        kind: 'unavailable',
        reason: `stored key did not decrypt: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  const key = randomBytes(KEY_BYTES)
  writeOwnerOnlyFileSync(file, safeStorage.encryptString(key.toString('base64')))
  return { kind: 'key', key, created: true }
}
