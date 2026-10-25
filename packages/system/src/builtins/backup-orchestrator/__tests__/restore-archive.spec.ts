/**
 * Restore asks for the backup key of an encrypted archive, and only of one:
 * an archive made before encryption (or with it off) restores as it always did.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BackupKeyMismatchError,
  encryptBackupFile,
  generateBackupKeyPair,
} from '../../system-backup/backup-encryption.js'
import {
  BackupKeyRequiredError,
  precheckRestoreKey,
  prepareRestoreArchive,
} from '../restore-archive.js'

let dir: string
const PLAIN = Buffer.from('\x1f\x8b plain tar.gz bytes, as every archive before encryption')

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-archive-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

async function encrypted(publicKey: string): Promise<string> {
  const plain = path.join(dir, 'src.tar.gz')
  await fsp.writeFile(plain, PLAIN)
  const out = path.join(dir, 'restore-x.download')
  await encryptBackupFile(plain, out, publicKey)
  return out
}

describe('prepareRestoreArchive', () => {
  it('a plain archive needs no key and is used as is', async () => {
    const downloaded = path.join(dir, 'restore-x.download')
    await fsp.writeFile(downloaded, PLAIN)
    const target = path.join(dir, 'restore-x.tar.gz')
    expect(await prepareRestoreArchive({ downloaded, target })).toEqual({ encrypted: false })
    expect((await fsp.readFile(target)).equals(PLAIN)).toBe(true)
  })

  it('an encrypted archive is decrypted with its key, and the ciphertext copy removed', async () => {
    const keys = generateBackupKeyPair()
    const downloaded = await encrypted(keys.publicKey)
    const target = path.join(dir, 'restore-x.tar.gz')
    const result = await prepareRestoreArchive({ downloaded, target, secretKey: keys.secretKey })
    expect(result).toEqual({ encrypted: true, keyId: keys.keyId })
    expect((await fsp.readFile(target)).equals(PLAIN)).toBe(true)
    expect(fs.existsSync(downloaded)).toBe(false)
  })

  it('an encrypted archive without a key is refused, naming the key it needs', async () => {
    const keys = generateBackupKeyPair()
    const downloaded = await encrypted(keys.publicKey)
    const target = path.join(dir, 'restore-x.tar.gz')
    const err = await prepareRestoreArchive({ downloaded, target }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackupKeyRequiredError)
    expect(String(err)).toContain(keys.keyId)
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(downloaded)).toBe(false)
  })

  it('the wrong key is refused and leaves no plaintext', async () => {
    const keys = generateBackupKeyPair()
    const downloaded = await encrypted(keys.publicKey)
    const target = path.join(dir, 'restore-x.tar.gz')
    await expect(
      prepareRestoreArchive({ downloaded, target, secretKey: generateBackupKeyPair().secretKey }),
    ).rejects.toBeInstanceOf(BackupKeyMismatchError)
    expect(fs.existsSync(target)).toBe(false)
  })
})

describe('precheckRestoreKey — before any download', () => {
  it('nothing to check for an archive the manifest records as plain', () => {
    expect(() => precheckRestoreKey(undefined, undefined)).not.toThrow()
  })

  it('an encrypted archive needs a key, and the right one', () => {
    const keys = generateBackupKeyPair()
    expect(() => precheckRestoreKey(keys.keyId, undefined)).toThrow(BackupKeyRequiredError)
    expect(() => precheckRestoreKey(keys.keyId, '  ')).toThrow(BackupKeyRequiredError)
    expect(() => precheckRestoreKey(keys.keyId, generateBackupKeyPair().secretKey)).toThrow(
      BackupKeyMismatchError,
    )
    expect(() => precheckRestoreKey(keys.keyId, keys.secretKey)).not.toThrow()
  })
})
