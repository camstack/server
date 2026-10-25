/**
 * The backup encryption setting: the hub keeps PUBLIC keys only — the active
 * one it encrypts to, and the retired ones so the page can say which key an
 * old archive needs. Driven by a real in-memory settings backend.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { generateBackupKeyPair } from '../../system-backup/backup-encryption.js'
import { BackupEncryptionKeyStore } from '../encryption-key-store.js'

describe('BackupEncryptionKeyStore', () => {
  let backend: SqliteSettingsBackend
  let store: BackupEncryptionKeyStore
  let now = 1_000

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    now = 1_000
    store = new BackupEncryptionKeyStore(backend, () => now)
  })

  it('off until set up', async () => {
    expect(await store.active()).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('activating a key makes it the one archives are encrypted to — public key only', async () => {
    const keys = generateBackupKeyPair()
    await store.activate({ publicKey: keys.publicKey })
    expect(await store.active()).toEqual({
      keyId: keys.keyId,
      publicKey: keys.publicKey,
      createdAt: 1_000,
      retiredAt: null,
    })
    const rows = await backend.query({ collection: 'backup_encryption_keys' })
    expect(JSON.stringify(rows)).not.toContain(keys.secretKey.split(':')[1])
  })

  it('regenerating retires the previous key and keeps it listed', async () => {
    const a = generateBackupKeyPair()
    const b = generateBackupKeyPair()
    await store.activate({ publicKey: a.publicKey })
    now = 2_000
    await store.activate({ publicKey: b.publicKey })
    expect((await store.active())?.keyId).toBe(b.keyId)
    const all = await store.list()
    expect(all.map((k) => [k.keyId, k.retiredAt])).toEqual([
      [b.keyId, null],
      [a.keyId, 2_000],
    ])
  })

  it('disabling retires the active key; nothing is encrypted after', async () => {
    const a = generateBackupKeyPair()
    await store.activate({ publicKey: a.publicKey })
    now = 3_000
    await store.disable()
    expect(await store.active()).toBeNull()
    expect((await store.list())[0]?.retiredAt).toBe(3_000)
  })

  it('refuses a key that is not a backup public key', async () => {
    await expect(store.activate({ publicKey: generateBackupKeyPair().secretKey })).rejects.toThrow(
      /backup public key/,
    )
  })
})
