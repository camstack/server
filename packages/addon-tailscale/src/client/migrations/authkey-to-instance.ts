/**
 * The pre-auth key and the hostname move from the hub's node settings into the `tailnet` record
 * (D985, D996, epic #440 step 6). Two migrations, like every credential move: the record is made
 * first (`moveAuthKeyToRecord`), the old keys are deleted by `planDropMovedKeys` only after the
 * record is confirmed to hold what they carried.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are read
 * in full (a key that cannot be resolved aborts the pass); an existing record is never overwritten;
 * the old key is cleared only once the record verifiably holds one.
 */
import {
  isSecretMarker,
  type MigrationPlan,
  type MigrationProcedureResult,
  preconditionOf,
} from '@camstack/types'
import { ADDON_SETTINGS_TABLE, SETTINGS_NODE_ID, nodeKeyOf } from '../../settings-per-node.js'
import type { TailnetBody } from '../tailnet-record-kinds.js'

export const TAILSCALE_CLIENT_ADDON_ID = 'tailscale-client'

const LEGACY_KEY = 'authKey'
const LEGACY_HOSTNAME = 'hostname'
/** Both spellings of each key: the bare row of an older version and the hub's node row. */
const LEGACY_ROWS: readonly string[] = [
  LEGACY_KEY,
  LEGACY_HOSTNAME,
  nodeKeyOf(LEGACY_KEY),
  nodeKeyOf(LEGACY_HOSTNAME),
]

const RECORD_NAME = 'Tailscale'

/** What the migrations say about a decision they took; never carries a value. */
export interface TailnetMigrationLog {
  warn(message: string): void
}

/** What the tailnet record holds, as far as the migrations care. */
export interface TailnetRecordState {
  readonly hostname: string
  readonly hasAuthKey: boolean
}

export interface AuthKeyToInstancePorts extends TailnetMigrationLog {
  /** The hub's node settings, secrets resolved. Throws when a secret cannot be resolved. */
  readHub(): Promise<Readonly<Record<string, unknown>>>
  /** Put the record with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(body: TailnetBody): Promise<'created' | 'exists'>
  /** The record, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(): Promise<TailnetRecordState | null>
  /** Remove the old key and its keychain value. */
  clearOldAuthKey(): Promise<void>
}

export interface DropMovedKeysPorts extends TailnetMigrationLog {
  readRecord(): Promise<TailnetRecordState | null>
  /** The rows as stored (markers kept), for each of `keys` that has one. Throws when unreadable. */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
}

function text(stored: Readonly<Record<string, unknown>>, key: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value.trim() : ''
}

export async function moveAuthKeyToRecord(
  ports: AuthKeyToInstancePorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readHub()
  // A key that is still a marker was not resolved: abort before anything is written.
  if (isSecretMarker(stored[LEGACY_KEY])) {
    throw new Error('the old Tailscale pre-auth key could not be resolved')
  }
  const authKey = text(stored, LEGACY_KEY)
  const hostname = text(stored, LEGACY_HOSTNAME)
  if (authKey.length === 0 && hostname.length === 0) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const put = await ports.putRecord({
    name: RECORD_NAME,
    hostname,
    ...(authKey.length > 0 ? { authKey } : {}),
  })
  if (authKey.length > 0) {
    // The old key is the only copy until the record verifiably holds one: an existing record
    // that has none (or one that cannot be read) leaves it where it is.
    const held = put === 'created' || (await ports.readRecord())?.hasAuthKey === true
    if (held) await ports.clearOldAuthKey()
    else
      ports.warn(
        'Tailscale migration: the existing record holds no pre-auth key; the legacy one is kept, not cleared',
      )
  }
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true } }
    : { outcome: 'already-done', summary: { moved: false } }
}

/** The row as the settings writer stores it: a node row carries `nodeId`. */
function rowOf(key: string, value: unknown): Record<string, unknown> {
  const node = key.endsWith(`@${SETTINGS_NODE_ID}`)
  return node
    ? {
        addonId: TAILSCALE_CLIENT_ADDON_ID,
        key,
        value,
        nodeId: SETTINGS_NODE_ID,
      }
    : { addonId: TAILSCALE_CLIENT_ADDON_ID, key, value }
}

const holdsValue = (value: unknown): boolean =>
  isSecretMarker(value) || (typeof value === 'string' && value.trim().length > 0)

export async function planDropMovedKeys(ports: DropMovedKeysPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored(LEGACY_ROWS)
  const present = LEGACY_ROWS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordHoldsLegacy(ports, stored)
  const rowId = (key: string): string => `${TAILSCALE_CLIENT_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(present.map((key) => [rowId(key), rowOf(key, stored[key])])),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when the record is confirmed to hold what they carried: the hostname,
 * and the key when any legacy row still has one. Otherwise the migration fails, the keys stay, and
 * the next boot retries.
 */
async function confirmRecordHoldsLegacy(
  ports: DropMovedKeysPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const legacyKey = [LEGACY_KEY, nodeKeyOf(LEGACY_KEY)].some((k) => holdsValue(stored[k]))
  const legacyHostname = [LEGACY_HOSTNAME, nodeKeyOf(LEGACY_HOSTNAME)].some(
    (k) => text(stored, k).length > 0,
  )
  if (!legacyKey && !legacyHostname) return
  const refuse = (reason: string): never => {
    ports.warn(`Tailscale migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy Tailscale keys are not deleted: ${reason}`)
  }
  const record = await ports.readRecord()
  if (record === null) return refuse('no tailnet record exists')
  if (legacyHostname && record.hostname.trim().length === 0) {
    return refuse('the record holds no hostname')
  }
  if (legacyKey && !record.hasAuthKey) return refuse('the record holds no pre-auth key')
}
