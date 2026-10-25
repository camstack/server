/**
 * The backup encryption setting (operator decision 2026-10-09): which backup
 * PUBLIC key new archives are encrypted to, and the keys used before.
 *
 * The secret key is never here — it is shown once at setup and kept by the
 * operator (see `system-backup/backup-encryption.ts` for why). A retired key
 * stays listed so the Backup page can say which key an older archive needs.
 *
 * A read that fails THROWS: a backup run must never take "could not read the
 * setting" for "encryption is off" and ship a plain archive.
 */
import type { CollectionColumn, ISettingsStoreProvider, RecordKindHandle } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { parseBackupPublicKey } from '../system-backup/backup-encryption.js'
import { backupOrchestratorRecordKinds, type BackupEncryptionKeyBody } from './record-kinds.js'

/**
 * @durable class=config owner=backup-orchestrator
 *   write="`setupEncryption` inserts one row per generated key and retires the
 *     previous active row; `disableEncryption` retires the active row"
 *   retention="none — one small row per key ever generated; a retired row
 *     names the key older archives need"
 */
export const BACKUP_ENCRYPTION_KEYS_COLLECTION = 'backup_encryption_keys'

const COLUMNS: readonly CollectionColumn[] = [
  { name: 'key_id', type: 'TEXT', primaryKey: true },
  { name: 'public_key', type: 'TEXT', notNull: true },
  { name: 'created_at', type: 'INTEGER', notNull: true },
  { name: 'retired_at', type: 'INTEGER' },
]

export interface BackupEncryptionKeyRecord {
  readonly keyId: string
  readonly publicKey: string
  readonly createdAt: number
  readonly retiredAt: number | null
}

type Store = Pick<ISettingsStoreProvider, 'declareCollection' | 'query' | 'insert' | 'deleteWhere'>

export class BackupEncryptionKeyStore {
  private declared = false
  private readonly keysKind: RecordKindHandle<BackupEncryptionKeyBody> | null

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    keysKind: RecordKindHandle<BackupEncryptionKeyBody> | null = null,
  ) {
    this.keysKind = keysKind
  }

  private async ensureDeclared(): Promise<void> {
    if (this.keysKind !== null) return
    if (this.declared) return
    await this.store.declareCollection({
      collection: BACKUP_ENCRYPTION_KEYS_COLLECTION,
      columns: COLUMNS,
    })
    this.declared = true
  }

  /** Every key, newest first. */
  async list(): Promise<readonly BackupEncryptionKeyRecord[]> {
    await this.ensureDeclared()
    const kind = this.keysKind
    if (kind !== null) {
      const rows = await readAllRows(kind)
      rows.sort((a, b) => b.data.createdAt - a.data.createdAt)
      const out: BackupEncryptionKeyRecord[] = []
      for (const row of rows) {
        const record = bodyToRecord(row.id, row.data)
        if (record !== null) out.push(record)
      }
      return out
    }
    const rows = await this.store.query({
      collection: BACKUP_ENCRYPTION_KEYS_COLLECTION,
      filter: { orderBy: { field: 'created_at', direction: 'desc' } },
    })
    const out: BackupEncryptionKeyRecord[] = []
    for (const row of rows) {
      const record = toRecord(row.data)
      if (record !== null) out.push(record)
    }
    return out
  }

  /** The key new archives are encrypted to; `null` = encryption off. */
  async active(): Promise<BackupEncryptionKeyRecord | null> {
    return (await this.list()).find((k) => k.retiredAt === null) ?? null
  }

  /** Make `publicKey` the active key; the previous one is retired, kept listed. */
  async activate(input: { readonly publicKey: string }): Promise<BackupEncryptionKeyRecord> {
    const parsed = parseBackupPublicKey(input.publicKey)
    const t = this.now()
    await this.retireActive(t)
    const record: BackupEncryptionKeyRecord = {
      keyId: parsed.keyId,
      publicKey: input.publicKey.trim(),
      createdAt: t,
      retiredAt: null,
    }
    await this.write(record)
    return record
  }

  /** Encryption off: the active key is retired. Archives already made keep needing it. */
  async disable(): Promise<void> {
    await this.retireActive(this.now())
  }

  private async retireActive(at: number): Promise<void> {
    for (const key of await this.list()) {
      if (key.retiredAt === null) await this.write({ ...key, retiredAt: at })
    }
  }

  private async write(record: BackupEncryptionKeyRecord): Promise<void> {
    await this.ensureDeclared()
    const kind = this.keysKind
    if (kind !== null) {
      const body: BackupEncryptionKeyBody = {
        keyId: record.keyId,
        publicKey: record.publicKey,
        createdAt: record.createdAt,
        retiredAt: record.retiredAt,
      }
      const data = backupOrchestratorRecordKinds['encryption-keys'].schema.parse(body)
      await kind.put({ id: record.keyId, data })
      return
    }
    await this.store.deleteWhere({
      collection: BACKUP_ENCRYPTION_KEYS_COLLECTION,
      filter: { where: { key_id: record.keyId } },
    })
    await this.store.insert({
      collection: BACKUP_ENCRYPTION_KEYS_COLLECTION,
      record: {
        id: record.keyId,
        data: {
          key_id: record.keyId,
          public_key: record.publicKey,
          created_at: record.createdAt,
          retired_at: record.retiredAt,
        },
      },
    })
  }
}

function bodyToRecord(
  keyId: string,
  body: BackupEncryptionKeyBody,
): BackupEncryptionKeyRecord | null {
  if (!keyId) return null
  return {
    keyId: body.keyId,
    publicKey: body.publicKey,
    createdAt: body.createdAt,
    retiredAt: body.retiredAt,
  }
}

function toRecord(row: Record<string, unknown>): BackupEncryptionKeyRecord | null {
  const keyId = row['key_id']
  const publicKey = row['public_key']
  const createdAt = row['created_at']
  if (typeof keyId !== 'string' || typeof publicKey !== 'string') return null
  const retired = row['retired_at']
  return {
    keyId,
    publicKey,
    createdAt: typeof createdAt === 'number' ? createdAt : Number(createdAt ?? 0),
    retiredAt: typeof retired === 'number' ? retired : null,
  }
}
