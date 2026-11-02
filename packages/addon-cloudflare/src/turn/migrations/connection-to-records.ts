/**
 * The Cloudflare TURN credentials move from the addon's settings into the `accounts` record
 * (D985, D996): the record is named after the addon, the API token re-bound to the record's
 * keychain slot. The old keys are deleted by the second migration of the catalogue
 * (`planDropMovedSettings`), only after this one succeeded and the record is confirmed.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are read
 * in full (a token that cannot be resolved aborts the pass); an existing record is never
 * overwritten; the old token is cleared only once the record verifiably holds it.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { type CloudflareTurnBody } from '../turn-record-kinds.js'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const CLOUDFLARE_TURN_ADDON_ID = 'cloudflare-turn'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The legacy keys, in order: `accountId` held the Token ID, `apiToken` is the secret. */
const LEGACY_KEY_ID = 'accountId'
const LEGACY_TOKEN = 'apiToken'

/** What the migrations say about a decision they took; never carries a value. */
export interface CloudflareTurnMigrationLog {
  warn(message: string): void
}

/** What the account record holds, as far as the migrations care. */
export interface CloudflareTurnRecordState {
  readonly keyId: string
  readonly hasApiToken: boolean
}

export interface CloudflareTurnMigrationPorts extends CloudflareTurnMigrationLog {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the record with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(body: CloudflareTurnBody): Promise<'created' | 'exists'>
  /** The record, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(): Promise<CloudflareTurnRecordState | null>
  /** Remove the old token and its keychain value. */
  clearOldApiToken(): Promise<void>
}

const ACCOUNT_NAME = 'Cloudflare TURN'

function text(stored: Readonly<Record<string, unknown>>, key: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value.trim() : ''
}

export async function moveConnectionToRecord(
  ports: CloudflareTurnMigrationPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  const keyId = text(stored, LEGACY_KEY_ID)
  const apiToken = text(stored, LEGACY_TOKEN)
  if (keyId.length === 0 && apiToken.length === 0) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const put = await ports.putRecord({
    name: ACCOUNT_NAME,
    keyId,
    ...(apiToken.length > 0 ? { apiToken } : {}),
  })
  if (apiToken.length > 0) {
    // The old token is the only copy until the record verifiably holds one: an existing record
    // that has none (or one that cannot be read) leaves it where it is.
    const held = put === 'created' || (await ports.readRecord())?.hasApiToken === true
    if (held) await ports.clearOldApiToken()
    else
      ports.warn(
        'Cloudflare TURN migration: the existing record holds no API token; the legacy one is kept, not cleared',
      )
  }
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true } }
    : { outcome: 'already-done', summary: { moved: false } }
}

export interface DropMovedSettingsPorts extends CloudflareTurnMigrationLog {
  /** The record, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(): Promise<CloudflareTurnRecordState | null>
  /** The addon's stored settings as written (markers unresolved), unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = [LEGACY_KEY_ID, LEGACY_TOKEN].filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordHoldsLegacy(ports, stored)
  const rowId = (key: string): string => `${CLOUDFLARE_TURN_ADDON_ID}.${key}`
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
              { addonId: CLOUDFLARE_TURN_ADDON_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when the record is confirmed to hold what they carried: the key id,
 * and the token when the legacy settings still have one. Otherwise the migration fails, the keys
 * stay, and the next boot retries.
 */
async function confirmRecordHoldsLegacy(
  ports: DropMovedSettingsPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const legacyKeyId = text(stored, LEGACY_KEY_ID)
  const legacyToken = LEGACY_TOKEN in stored
  if (legacyKeyId.length === 0 && !legacyToken) return
  const refuse = (reason: string): never => {
    ports.warn(`Cloudflare TURN migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy Cloudflare TURN keys are not deleted: ${reason}`)
  }
  const record = await ports.readRecord()
  if (record === null) return refuse('no Cloudflare TURN record exists')
  if (legacyKeyId.length > 0 && record.keyId.trim().length === 0) {
    return refuse('the record holds no key id')
  }
  if (legacyToken && !record.hasApiToken) return refuse('the record holds no API token')
}
