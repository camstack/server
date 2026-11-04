/**
 * The Modal accounts move from the addon's `entries` setting into `training-account` records
 * (D985, D996): one record per account under the id it already had (jobs and the orchestrator
 * name an account by that id), the token secret re-bound to the record's keychain slot.
 * The old keys are deleted by the second migration of the catalogue (`planDropMovedSettings`),
 * only after this one succeeded and every record is confirmed.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are read
 * in full (a secret that cannot be resolved aborts the pass); an existing record is never
 * overwritten; an old secret is cleared only once its record verifiably holds one.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import type { TrainingAccountBody } from '../training-account-record-kinds.js'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const MODAL_ADDON_ID = 'training-modal'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** Every key the records now own (the list plus the pre-multi-account flat fields). */
export const MOVED_KEYS: readonly string[] = [
  'entries',
  'tokenId',
  'tokenSecret',
  'environment',
  'gpuType',
  'region',
  'costCapUsd',
  'maxRuntimeHours',
  'failedDatasetGraceHours',
]

/** What the migrations say about a decision they took; never carries a value. */
export interface ModalMigrationLog {
  warn(message: string): void
}

/** What an account record holds, as far as the migrations care. */
export interface ModalRecordState {
  readonly tokenId: string
  readonly hasSecret: boolean
}

export interface ModalMigrationPorts extends ModalMigrationLog {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the record under `id` with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(id: string, body: TrainingAccountBody): Promise<'created' | 'exists'>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<ModalRecordState | null>
  /** Remove the old token secret (and its keychain value) of these accounts. */
  clearOldSecrets(ids: readonly string[]): Promise<void>
}

const DEFAULTS = {
  gpuType: 'L4',
  region: '',
  costCapUsd: 5,
  maxRuntimeHours: 4,
  failedDatasetGraceHours: 24,
}

function text(from: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = from[key]
  return typeof value === 'string' ? value : fallback
}

function num(from: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = from[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One old account row, its id kept; rows without an id cannot be named and are skipped. */
export interface OldAccount {
  readonly id: string
  readonly body: TrainingAccountBody
}

export function oldAccountsOf(stored: Readonly<Record<string, unknown>>): readonly OldAccount[] {
  const list = stored['entries']
  if (!Array.isArray(list)) return []
  const out: OldAccount[] = []
  for (const row of list) {
    if (!isRecord(row)) continue
    const id = text(row, 'id', '').trim()
    if (id === '') continue
    const secret = text(row, 'tokenSecret', '').trim()
    out.push({
      id,
      body: {
        name: text(row, 'name', 'Default') || 'Default',
        tokenId: text(row, 'tokenId', ''),
        ...(secret.length > 0 ? { tokenSecret: secret } : {}),
        environment: text(row, 'environment', ''),
        gpuType: text(row, 'gpuType', DEFAULTS.gpuType),
        region: text(row, 'region', DEFAULTS.region),
        costCapUsd: num(row, 'costCapUsd', DEFAULTS.costCapUsd),
        maxRuntimeHours: num(row, 'maxRuntimeHours', DEFAULTS.maxRuntimeHours),
        failedDatasetGraceHours: num(
          row,
          'failedDatasetGraceHours',
          DEFAULTS.failedDatasetGraceHours,
        ),
      },
    })
  }
  return out
}

export async function moveEntriesToRecords(
  ports: ModalMigrationPorts,
): Promise<MigrationProcedureResult> {
  const accounts = oldAccountsOf(await ports.readStored())
  if (accounts.length === 0) return { outcome: 'already-done', summary: { moved: 0 } }
  let moved = 0
  const clearable: string[] = []
  for (const account of accounts) {
    const put = await ports.putRecord(account.id, account.body)
    if (put === 'created') moved += 1
    if (account.body.tokenSecret === undefined) continue
    // The old secret is the only copy until the record verifiably holds one: an existing record
    // that has none leaves it where it is.
    const held = put === 'created' || (await ports.readRecord(account.id))?.hasSecret === true
    if (held) clearable.push(account.id)
    else
      ports.warn(
        'Modal migration: an existing account record holds no token secret; the legacy one is kept, not cleared',
      )
  }
  if (clearable.length > 0) await ports.clearOldSecrets(clearable)
  return moved > 0
    ? { outcome: 'done', summary: { moved } }
    : { outcome: 'already-done', summary: { moved: 0 } }
}

export interface DropMovedSettingsPorts extends ModalMigrationLog {
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<ModalRecordState | null>
  /** The addon's stored settings, unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = MOVED_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordsHoldLegacy(ports, stored)
  const rowId = (key: string): string => `${MODAL_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The precondition is the rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: MODAL_ADDON_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when every old account has its record and a secret the legacy
 * settings still carry is held by it. Otherwise the migration fails, the keys stay, and the next
 * boot retries.
 */
async function confirmRecordsHoldLegacy(
  ports: DropMovedSettingsPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const refuse = (reason: string): never => {
    ports.warn(`Modal migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy Modal keys are not deleted: ${reason}`)
  }
  if (text(stored, 'tokenSecret', '').trim().length > 0) {
    return refuse('a flat legacy token secret is still stored')
  }
  for (const account of oldAccountsOf(stored)) {
    const record = await ports.readRecord(account.id)
    if (record === null) return refuse(`the account ${account.id} has no record`)
    if (account.body.tokenSecret !== undefined && !record.hasSecret) {
      return refuse(`the record of ${account.id} holds no token secret`)
    }
    if (account.body.tokenId.trim() !== '' && record.tokenId.trim() === '') {
      return refuse(`the record of ${account.id} holds no token id`)
    }
  }
}
