/**
 * The keychain's three tables, behind the `settings-store` door (D44) — the
 * same database file as every other collection, which is the point: what a
 * stray copy of `camstack.db` holds of them is ciphertext, wrapped key material
 * and an audit trail, never a value.
 *
 * The repository takes a narrow door port rather than the whole tRPC client so
 * the service can be exercised against an in-memory door in tests.
 */
import type {
  ISettingsStoreProvider,
  KeychainAuditAction,
  KeychainResetRecord,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import {
  keychainRecordKinds,
  type KeychainAuditBodySchema,
  type KeychainResetBodySchema,
} from './record-kinds.js'
import type { z } from 'zod'

/**
 * @durable class=config owner=keychain
 *   write="`keychain.put` upserts one row per ref; `delete` removes it"
 *   retention="none — a row lives until its owner deletes the ref or the
 *     operator deletes it as an orphan. Losing the table loses every secret
 *     value; the settings blobs then point at refs that resolve `missing`."
 */
export const KEYCHAIN_SECRETS_COLLECTION = 'keychain:secrets'

/**
 * @durable class=config owner=keychain
 *   write="first boot writes the wrapped data key; `rotateMasterKey` adds a
 *     wrap and retires the previous one"
 *   retention="retired wraps until `purgeRetiredKeys`. Losing the table with
 *     the secrets intact makes every value undecryptable."
 */
export const KEYCHAIN_KEYS_COLLECTION = 'keychain:keys'

/**
 * @durable class=audit owner=keychain
 *   write="one row per write / delete / rotation / reveal / recovery download"
 *   retention="90 days and at most 20 000 rows, pruned at boot and daily"
 */
export const KEYCHAIN_AUDIT_COLLECTION = 'keychain:audit'

/**
 * @durable class=config owner=keychain
 *   write="one row per keychain reset (System → Secrets, or the RESET_KEYCHAIN
 *     trigger file); `acknowledgeReset` stamps `acknowledgedAt`"
 *   retention="none — a handful of rows over a hub's life; they name the
 *     archive tables a reset left behind"
 */
export const KEYCHAIN_RESETS_COLLECTION = 'keychain:resets'

export const AUDIT_RETENTION_MS: number = 90 * 24 * 60 * 60_000
export const AUDIT_MAX_ROWS = 20_000

export interface KeychainSecretRow {
  readonly ref: string
  readonly owner: string
  readonly scope: string
  readonly fieldPath: string
  readonly ciphertext: string
  readonly keyId: string
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly updatedBy: string
  readonly lastReadAt: number | null
}

export type KeyWrapState = 'active' | 'retired'

export interface KeychainKeyRow {
  readonly wrapId: string
  readonly keyId: string
  readonly wrappedDek: string
  readonly kekFingerprint: string
  readonly kekSource: string
  readonly createdAt: number
  readonly state: KeyWrapState
  readonly recoveryDownloadedAt: number | null
}

export interface KeychainAuditRow {
  readonly id: string
  readonly at: number
  readonly action: KeychainAuditAction
  readonly actor: string
  readonly ref: string | null
  readonly detail: string | null
}

/** The subset of the settings door the repository uses. */
export type KeychainDoor = Pick<
  ISettingsStoreProvider,
  'declareCollection' | 'get' | 'set' | 'query' | 'delete' | 'deleteWhere'
>

const SECRET_COLUMNS = [
  { name: 'ref', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'owner', type: 'TEXT' as const, notNull: true },
  { name: 'scope', type: 'TEXT' as const, notNull: true },
  { name: 'fieldPath', type: 'TEXT' as const, notNull: true },
  { name: 'ciphertext', type: 'TEXT' as const, notNull: true },
  { name: 'keyId', type: 'TEXT' as const, notNull: true },
  { name: 'version', type: 'INTEGER' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedBy', type: 'TEXT' as const, notNull: true },
  { name: 'lastReadAt', type: 'INTEGER' as const },
]

const KEY_COLUMNS = [
  { name: 'wrapId', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'keyId', type: 'TEXT' as const, notNull: true },
  { name: 'wrappedDek', type: 'TEXT' as const, notNull: true },
  { name: 'kekFingerprint', type: 'TEXT' as const, notNull: true },
  { name: 'kekSource', type: 'TEXT' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'state', type: 'TEXT' as const, notNull: true },
  { name: 'recoveryDownloadedAt', type: 'INTEGER' as const },
]

const RESET_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'at', type: 'INTEGER' as const, notNull: true },
  { name: 'actor', type: 'TEXT' as const, notNull: true },
  { name: 'lockedReason', type: 'TEXT' as const },
  { name: 'archived', type: 'INTEGER' as const, notNull: true },
  { name: 'archivedCollection', type: 'TEXT' as const },
  { name: 'archivedKeysCollection', type: 'TEXT' as const },
  { name: 'clearedSettingsKeys', type: 'TEXT' as const, notNull: true },
  { name: 'acknowledgedAt', type: 'INTEGER' as const },
]

const AUDIT_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'at', type: 'INTEGER' as const, notNull: true },
  { name: 'action', type: 'TEXT' as const, notNull: true },
  { name: 'actor', type: 'TEXT' as const, notNull: true },
  { name: 'ref', type: 'TEXT' as const },
  { name: 'detail', type: 'TEXT' as const },
]

function str(data: Readonly<Record<string, unknown>>, key: string): string {
  const v = data[key]
  return typeof v === 'string' ? v : ''
}

function num(data: Readonly<Record<string, unknown>>, key: string): number {
  const v = data[key]
  return typeof v === 'number' ? v : Number(v ?? 0)
}

function numOrNull(data: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = data[key]
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function strOrNull(data: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = data[key]
  return typeof v === 'string' ? v : null
}

function toSecretRow(id: string, data: Readonly<Record<string, unknown>>): KeychainSecretRow {
  return {
    ref: str(data, 'ref') || id,
    owner: str(data, 'owner'),
    scope: str(data, 'scope'),
    fieldPath: str(data, 'fieldPath'),
    ciphertext: str(data, 'ciphertext'),
    keyId: str(data, 'keyId'),
    version: num(data, 'version'),
    createdAt: num(data, 'createdAt'),
    updatedAt: num(data, 'updatedAt'),
    updatedBy: str(data, 'updatedBy'),
    lastReadAt: numOrNull(data, 'lastReadAt'),
  }
}

function toKeyRow(id: string, data: Readonly<Record<string, unknown>>): KeychainKeyRow {
  const state = str(data, 'state')
  return {
    wrapId: str(data, 'wrapId') || id,
    keyId: str(data, 'keyId'),
    wrappedDek: str(data, 'wrappedDek'),
    kekFingerprint: str(data, 'kekFingerprint'),
    kekSource: str(data, 'kekSource'),
    createdAt: num(data, 'createdAt'),
    state: state === 'retired' ? 'retired' : 'active',
    recoveryDownloadedAt: numOrNull(data, 'recoveryDownloadedAt'),
  }
}

const AUDIT_ACTIONS: ReadonlySet<string> = new Set<KeychainAuditAction>([
  'put',
  'delete',
  'reveal',
  'rotate-master-key',
  'purge-retired-keys',
  'download-recovery-key',
  'delete-orphans',
  'reset',
  'acknowledge-reset',
  'initialize',
])

function isAuditAction(value: string): value is KeychainAuditAction {
  return AUDIT_ACTIONS.has(value)
}

function toAuditRow(id: string, data: Readonly<Record<string, unknown>>): KeychainAuditRow | null {
  const action = str(data, 'action')
  if (!isAuditAction(action)) return null
  return {
    id: str(data, 'id') || id,
    at: num(data, 'at'),
    action,
    actor: str(data, 'actor'),
    ref: strOrNull(data, 'ref'),
    detail: strOrNull(data, 'detail'),
  }
}

function toResetRecord(id: string, data: Readonly<Record<string, unknown>>): KeychainResetRecord {
  const cleared = data['clearedSettingsKeys']
  let keys: string[] = []
  if (typeof cleared === 'string') {
    try {
      const parsed: unknown = JSON.parse(cleared)
      if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === 'string')
    } catch {
      keys = []
    }
  } else if (Array.isArray(cleared)) {
    keys = cleared.filter((k): k is string => typeof k === 'string')
  }
  return {
    id: str(data, 'id') || id,
    at: num(data, 'at'),
    actor: str(data, 'actor'),
    lockedReason: strOrNull(data, 'lockedReason'),
    archived: num(data, 'archived'),
    archivedCollection: strOrNull(data, 'archivedCollection'),
    archivedKeysCollection: strOrNull(data, 'archivedKeysCollection'),
    clearedSettingsKeys: keys,
    acknowledgedAt: numOrNull(data, 'acknowledgedAt'),
  }
}

/** Rows one listing page asks for — the table is small, but a read names its bound. */
const PAGE = 1_000

type KeychainAuditBody = z.infer<typeof KeychainAuditBodySchema>
type KeychainResetBody = z.infer<typeof KeychainResetBodySchema>

export interface KeychainRecordStores {
  readonly audit: RecordKindHandle<KeychainAuditBody>
  readonly resets: RecordKindHandle<KeychainResetBody>
}

export class KeychainRepository {
  constructor(
    private readonly door: KeychainDoor,
    private readonly records?: KeychainRecordStores,
  ) {}

  static recordStoresOf(records: Pick<RecordsAccess, 'kind'>): KeychainRecordStores {
    return {
      audit: records.kind(keychainRecordKinds.audit),
      resets: records.kind(keychainRecordKinds.resets),
    }
  }

  async init(): Promise<void> {
    await this.door.declareCollection({
      collection: KEYCHAIN_SECRETS_COLLECTION,
      columns: SECRET_COLUMNS,
      indexes: [{ name: 'idx_keychain_secrets_owner', columns: ['owner'] }],
    })
    await this.door.declareCollection({
      collection: KEYCHAIN_KEYS_COLLECTION,
      columns: KEY_COLUMNS,
    })
    if (this.records === undefined) {
      await this.door.declareCollection({
        collection: KEYCHAIN_RESETS_COLLECTION,
        columns: RESET_COLUMNS,
      })
      await this.door.declareCollection({
        collection: KEYCHAIN_AUDIT_COLLECTION,
        columns: AUDIT_COLUMNS,
        indexes: [{ name: 'idx_keychain_audit_at', columns: ['at'] }],
      })
    }
  }

  async getSecrets(refs: readonly string[]): Promise<ReadonlyMap<string, KeychainSecretRow>> {
    const out = new Map<string, KeychainSecretRow>()
    if (refs.length === 0) return out
    const rows = await this.door.query({
      collection: KEYCHAIN_SECRETS_COLLECTION,
      filter: { whereIn: { ref: [...refs] }, limit: refs.length },
    })
    for (const row of rows) {
      const parsed = toSecretRow(row.id, row.data)
      out.set(parsed.ref, parsed)
    }
    return out
  }

  /** Every row, paged by primary key. */
  async listSecrets(): Promise<readonly KeychainSecretRow[]> {
    const out: KeychainSecretRow[] = []
    for (let offset = 0; ; offset += PAGE) {
      const rows = await this.door.query({
        collection: KEYCHAIN_SECRETS_COLLECTION,
        filter: { orderBy: { field: 'ref', direction: 'asc' }, limit: PAGE, offset },
      })
      for (const row of rows) out.push(toSecretRow(row.id, row.data))
      if (rows.length < PAGE) return out
    }
  }

  async putSecret(row: KeychainSecretRow): Promise<void> {
    await this.door.set({ collection: KEYCHAIN_SECRETS_COLLECTION, key: row.ref, value: row })
  }

  async deleteSecrets(refs: readonly string[]): Promise<number> {
    if (refs.length === 0) return 0
    const result = await this.door.deleteWhere({
      collection: KEYCHAIN_SECRETS_COLLECTION,
      filter: { whereIn: { ref: [...refs] } },
    })
    return result.deleted
  }

  async listKeys(): Promise<readonly KeychainKeyRow[]> {
    const rows = await this.door.query({
      collection: KEYCHAIN_KEYS_COLLECTION,
      filter: { orderBy: { field: 'createdAt', direction: 'asc' }, limit: PAGE },
    })
    return rows.map((row) => toKeyRow(row.id, row.data))
  }

  async putKey(row: KeychainKeyRow): Promise<void> {
    await this.door.set({ collection: KEYCHAIN_KEYS_COLLECTION, key: row.wrapId, value: row })
  }

  async deleteKey(wrapId: string): Promise<void> {
    await this.door.delete({ collection: KEYCHAIN_KEYS_COLLECTION, key: wrapId })
  }

  async appendAudit(row: KeychainAuditRow): Promise<void> {
    const kind = this.records?.audit
    if (kind !== undefined) {
      const { id, at, action, actor, ref, detail } = row
      await kind.put({ id, at, data: { action, actor, ref, detail } })
      return
    }
    await this.door.set({ collection: KEYCHAIN_AUDIT_COLLECTION, key: row.id, value: row })
  }

  async listAudit(limit: number): Promise<readonly KeychainAuditRow[]> {
    const kind = this.records?.audit
    if (kind !== undefined) {
      const rows = await readAllRows(kind)
      rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      const out: KeychainAuditRow[] = []
      for (const row of rows.slice(0, limit)) {
        const parsed = toAuditRow(row.id, { ...row.data, at: row.at ?? 0 })
        if (parsed !== null) out.push(parsed)
      }
      return out
    }
    const rows = await this.door.query({
      collection: KEYCHAIN_AUDIT_COLLECTION,
      filter: { orderBy: { field: 'at', direction: 'desc' }, limit },
    })
    const out: KeychainAuditRow[] = []
    for (const row of rows) {
      const parsed = toAuditRow(row.id, row.data)
      if (parsed !== null) out.push(parsed)
    }
    return out
  }

  /** Drop audit rows older than the retention window, then beyond the row bound. */
  async pruneAudit(nowMs: number): Promise<number> {
    const kind = this.records?.audit
    if (kind !== undefined) {
      const ageCutoff = nowMs - AUDIT_RETENTION_MS
      let deleted = 0
      for (const row of await readAllRows(kind)) {
        const at = row.at ?? 0
        if (at <= ageCutoff) {
          await kind.delete(row.id)
          deleted += 1
        }
      }
      const remaining = await readAllRows(kind)
      remaining.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      for (const row of remaining.slice(AUDIT_MAX_ROWS)) {
        await kind.delete(row.id)
        deleted += 1
      }
      return deleted
    }
    const aged = await this.door.deleteWhere({
      collection: KEYCHAIN_AUDIT_COLLECTION,
      filter: { whereBetween: { at: [0, nowMs - AUDIT_RETENTION_MS] } },
    })
    const beyond = await this.door.query({
      collection: KEYCHAIN_AUDIT_COLLECTION,
      filter: { orderBy: { field: 'at', direction: 'desc' }, limit: 1, offset: AUDIT_MAX_ROWS },
    })
    const cutoff = beyond[0]?.data['at']
    if (typeof cutoff !== 'number') return aged.deleted
    const bounded = await this.door.deleteWhere({
      collection: KEYCHAIN_AUDIT_COLLECTION,
      filter: { whereBetween: { at: [0, cutoff] } },
    })
    return aged.deleted + bounded.deleted
  }

  /**
   * Lost-key recovery: copy every secret row into `archive`, then empty the
   * live table. The archive is ciphertext under a key nobody has — it exists
   * so a key that turns up later can still recover it.
   */
  async archiveAllSecrets(archive: string): Promise<number> {
    const rows = await this.listSecrets()
    if (rows.length === 0) return 0
    await this.door.declareCollection({ collection: archive, columns: SECRET_COLUMNS })
    for (const row of rows) {
      await this.door.set({ collection: archive, key: row.ref, value: row })
    }
    await this.deleteSecrets(rows.map((r) => r.ref))
    return rows.length
  }

  /**
   * Copy every wrapped data key into `archive` (the companion of
   * {@link archiveAllSecrets}): without the wrap, an archived value could
   * never be opened again even if the lost master key turned up.
   */
  async archiveAllKeys(archive: string): Promise<number> {
    const rows = await this.listKeys()
    if (rows.length === 0) return 0
    await this.door.declareCollection({ collection: archive, columns: KEY_COLUMNS })
    for (const row of rows)
      await this.door.set({ collection: archive, key: row.wrapId, value: row })
    return rows.length
  }

  /** Every secret row of an archive table (ciphertext — never decrypted here). */
  async listArchivedSecrets(archive: string): Promise<readonly KeychainSecretRow[]> {
    const out: KeychainSecretRow[] = []
    for (let offset = 0; ; offset += PAGE) {
      const rows = await this.door.query({
        collection: archive,
        filter: { orderBy: { field: 'ref', direction: 'asc' }, limit: PAGE, offset },
      })
      for (const row of rows) out.push(toSecretRow(row.id, row.data))
      if (rows.length < PAGE) return out
    }
  }

  /**
   * Delete the `system-settings` rows among `keys` that exist; returns the
   * keys it deleted. A read that fails throws — never "nothing was there".
   */
  async clearSystemSettingsKeys(keys: readonly string[]): Promise<readonly string[]> {
    const cleared: string[] = []
    for (const key of keys) {
      const current = await this.door.get({ collection: 'system-settings', key })
      if (current === undefined || current === null) continue
      await this.door.delete({ collection: 'system-settings', key })
      cleared.push(key)
    }
    return cleared
  }

  async putReset(record: KeychainResetRecord): Promise<void> {
    const kind = this.records?.resets
    if (kind !== undefined) {
      const {
        id,
        at,
        actor,
        lockedReason,
        archived,
        archivedCollection,
        archivedKeysCollection,
        clearedSettingsKeys,
        acknowledgedAt,
      } = record
      await kind.put({
        id,
        at,
        data: {
          actor,
          lockedReason,
          archived,
          archivedCollection,
          archivedKeysCollection,
          clearedSettingsKeys: [...clearedSettingsKeys],
          acknowledgedAt,
        },
      })
      return
    }
    await this.door.set({
      collection: KEYCHAIN_RESETS_COLLECTION,
      key: record.id,
      value: { ...record, clearedSettingsKeys: JSON.stringify(record.clearedSettingsKeys) },
    })
  }

  async latestReset(): Promise<KeychainResetRecord | null> {
    const kind = this.records?.resets
    if (kind !== undefined) {
      const rows = await readAllRows(kind)
      rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      const row = rows[0]
      if (row === undefined) return null
      return toResetRecord(row.id, { ...row.data, at: row.at ?? 0 })
    }
    const rows = await this.door.query({
      collection: KEYCHAIN_RESETS_COLLECTION,
      filter: { orderBy: { field: 'at', direction: 'desc' }, limit: 1 },
    })
    const row = rows[0]
    return row === undefined ? null : toResetRecord(row.id, row.data)
  }
}
