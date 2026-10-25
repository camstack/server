import { clearPlatformKeychainKey, getPlatformKeychainKey } from '@camstack/system'
import { afterEach, describe, expect, it } from 'vitest'
import { keychainKeyFdFromArgv, loadPlatformKeychainKey } from '../platform-keychain-key'

describe('desktop OS-keychain key over an inherited pipe', () => {
  afterEach(() => clearPlatformKeychainKey())

  it('parses the descriptor; ignores stdio and junk', () => {
    expect(keychainKeyFdFromArgv(['node', 'starter.js', '--keychain-key-fd=3'])).toBe(3)
    expect(keychainKeyFdFromArgv(['--keychain-key-fd=1'])).toBeNull()
    expect(keychainKeyFdFromArgv(['--keychain-key-fd=x'])).toBeNull()
    expect(keychainKeyFdFromArgv([])).toBeNull()
  })

  it('reads the key once, registers it, and closes the descriptor', () => {
    const key = Buffer.alloc(32, 7)
    const closed: number[] = []
    const result = loadPlatformKeychainKey(
      ['--keychain-key-fd=3'],
      () => `${key.toString('base64')}\n`,
      (fd) => closed.push(fd),
    )
    expect(result.kind).toBe('loaded')
    expect(getPlatformKeychainKey()?.key.equals(key)).toBe(true)
    expect(closed).toEqual([3])
  })

  it('refuses material that is not a 32-byte key, registering nothing', () => {
    const result = loadPlatformKeychainKey(
      ['--keychain-key-fd=3'],
      () => 'hunter2',
      () => undefined,
    )
    expect(result.kind).toBe('failed')
    expect(getPlatformKeychainKey()).toBeNull()
  })
})
