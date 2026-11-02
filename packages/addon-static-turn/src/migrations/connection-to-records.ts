/**
 * The static TURN server moves from the addon's settings into a `servers` record (D985, D996):
 * a record under an id the addon mints, the credential re-bound to the record's keychain slot.
 * The old keys are deleted by the second migration of the catalogue (`planDropMovedSettings`),
 * only after this one succeeded and the record is confirmed.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are read
 * in full (a credential that cannot be resolved aborts the pass); an existing record is never
 * overwritten; the old credential is cleared only once the record verifiably holds it.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { type TurnServerBody, TURN_DEFAULT_BODY } from '../turn-record-kinds.js'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const TURN_ADDON_ID = 'static-turn'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The connection keys the record now owns. `credential` is the secret, cleared separately. */
export const MOVED_PLAIN_KEYS: readonly string[] = ['urls', 'username']

/** What the migrations say about a decision they took; never carries a value. */
export interface TurnMigrationLog {
  warn(message: string): void
}

/** What the server record holds, as far as the migrations care. */
export interface TurnRecordState {
  readonly urls: string
  readonly hasCredential: boolean
}

export interface TurnMigrationPorts extends TurnMigrationLog {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** The id of the addon's first server record, minted (no record written) when there is none. */
  ensureServerId(): Promise<string>
  /** Put the record under `id` with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(id: string, body: TurnServerBody): Promise<'created' | 'exists'>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<TurnRecordState | null>
  /** Remove the old credential and its keychain value. */
  clearOldCredential(): Promise<void>
}

const SERVER_NAME = 'TURN server'

function text(stored: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value : fallback
}

function bodyFrom(stored: Readonly<Record<string, unknown>>): TurnServerBody {
  const credential = text(stored, 'credential', '').trim()
  return {
    name: SERVER_NAME,
    urls: text(stored, 'urls', TURN_DEFAULT_BODY.urls),
    username: text(stored, 'username', TURN_DEFAULT_BODY.username).trim(),
    ...(credential.length > 0 ? { credential } : {}),
  }
}

export async function moveConnectionToRecord(
  ports: TurnMigrationPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  const urls = text(stored, 'urls', '').trim()
  const hasCredential = text(stored, 'credential', '').trim().length > 0
  if (urls.length === 0 && !hasCredential) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const id = await ports.ensureServerId()
  const put = await ports.putRecord(id, bodyFrom(stored))
  if (hasCredential) {
    // The old credential is the only copy until the record verifiably holds one: an existing
    // record that has none (or one that cannot be read) leaves it where it is.
    const held = put === 'created' || (await ports.readRecord(id))?.hasCredential === true
    if (held) await ports.clearOldCredential()
    else
      ports.warn(
        'TURN migration: the existing record holds no credential; the legacy one is kept, not cleared',
      )
  }
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true, serverId: id } }
    : { outcome: 'already-done', summary: { moved: false, serverId: id } }
}

export interface DropMovedSettingsPorts extends TurnMigrationLog {
  /** The id of the addon's first server record; null when it has none. */
  findServerId(): Promise<string | null>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<TurnRecordState | null>
  /** The addon's stored settings as written (markers unresolved), unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = [...MOVED_PLAIN_KEYS, 'credential'].filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordHoldsLegacy(ports, stored)
  const rowId = (key: string): string => `${TURN_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The precondition is the rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [rowId(key), { addonId: TURN_ADDON_ID, key, value: stored[key] }]),
          ),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when the record is confirmed to hold what they carried: the urls,
 * and the credential when the legacy settings still have one. Otherwise the migration fails, the
 * keys stay, and the next boot retries.
 */
async function confirmRecordHoldsLegacy(
  ports: DropMovedSettingsPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const legacyUrls = text(stored, 'urls', '').trim()
  const legacyCredential = 'credential' in stored
  if (legacyUrls.length === 0 && !legacyCredential) return
  const refuse = (reason: string): never => {
    ports.warn(`TURN migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy TURN keys are not deleted: ${reason}`)
  }
  const id = await ports.findServerId()
  if (id === null) return refuse('no TURN server record exists')
  const record = await ports.readRecord(id)
  if (record === null) return refuse('the servers record does not exist')
  if (legacyUrls.length > 0 && record.urls.trim().length === 0)
    return refuse('the record holds no urls')
  if (legacyCredential && !record.hasCredential) return refuse('the record holds no credential')
}
