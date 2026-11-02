/**
 * The Loki connection moves from the addon's settings into a `destinations` record (D985):
 * an integration row in the registry, a record under that id, and the password re-bound to
 * the record's keychain slot. The old keys are deleted by the second migration of the
 * catalogue (`dropMovedSettings`), only after this one succeeded.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are
 * read in full (a password that cannot be resolved aborts the pass); an existing record is
 * never overwritten; the old password is cleared only once the record verifiably holds it.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { LOKI_DEFAULT_BODY, type LokiDestinationBody, LOKI_BOUNDS } from '../loki-record-kinds.js'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const LOKI_ADDON_ID = 'loki-logging'

/**
 * Where the addon's global settings live: the canonical `addon-settings` table, one row per
 * key, id `<addonId>.<key>`, data `{ addonId, key, value }` (never a per-addon scoped table,
 * which exists only when something lazily declared it).
 */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The connection keys the record now owns. `password` is the secret, cleared separately. */
export const MOVED_PLAIN_KEYS: readonly string[] = [
  'url',
  'level',
  'job',
  'extraLabels',
  'tenantId',
  'username',
  'batchIntervalMs',
  'batchSize',
  'timeoutMs',
]

/** What the migrations say about a decision they took; never carries a value. */
export interface LokiMigrationLog {
  warn(message: string): void
}

/** What the destinations record holds, as far as the migrations care. */
export interface LokiRecordState {
  readonly url: string
  readonly hasPassword: boolean
}

export interface LokiMigrationPorts extends LokiMigrationLog {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** The id of the `integrations` row for this addon, created when absent. */
  ensureIntegration(name: string): Promise<string>
  /** Put the record under `id` with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(id: string, body: LokiDestinationBody): Promise<'created' | 'exists'>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<LokiRecordState | null>
  /** Remove the old password and its keychain value. */
  clearOldPassword(): Promise<void>
}

const LOKI_NAME = 'Loki'

function text(stored: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value : fallback
}

type BoundedKey = 'batchIntervalMs' | 'batchSize' | 'timeoutMs'

/**
 * A whole number inside the kind's own bounds (`LOKI_BOUNDS`, the same copy the schema uses): an
 * out-of-range legacy value would make the record write throw and block the owner, so it is
 * clamped, and the clamp is named.
 */
function bounded(
  stored: Readonly<Record<string, unknown>>,
  key: BoundedKey,
  fallback: number,
  log: LokiMigrationLog,
): number {
  const value = stored[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const { min, max } = LOKI_BOUNDS[key]
  const clamped = Math.min(max, Math.max(min, Math.round(value)))
  if (clamped !== value) {
    log.warn(`Loki migration: the legacy "${key}" is outside ${min}..${max}; clamped to ${clamped}`)
  }
  return clamped
}

function levelOf(stored: Readonly<Record<string, unknown>>): LokiDestinationBody['level'] {
  const value = stored['level']
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : LOKI_DEFAULT_BODY.level
}

function bodyFrom(
  stored: Readonly<Record<string, unknown>>,
  log: LokiMigrationLog,
): LokiDestinationBody {
  const password = text(stored, 'password', '')
  return {
    name: LOKI_NAME,
    url: text(stored, 'url', LOKI_DEFAULT_BODY.url),
    level: levelOf(stored),
    job: text(stored, 'job', LOKI_DEFAULT_BODY.job),
    extraLabels: text(stored, 'extraLabels', LOKI_DEFAULT_BODY.extraLabels),
    tenantId: text(stored, 'tenantId', LOKI_DEFAULT_BODY.tenantId),
    username: text(stored, 'username', LOKI_DEFAULT_BODY.username),
    ...(password.length > 0 ? { password } : {}),
    batchIntervalMs: bounded(stored, 'batchIntervalMs', LOKI_DEFAULT_BODY.batchIntervalMs, log),
    batchSize: bounded(stored, 'batchSize', LOKI_DEFAULT_BODY.batchSize, log),
    timeoutMs: bounded(stored, 'timeoutMs', LOKI_DEFAULT_BODY.timeoutMs, log),
  }
}

export async function moveConnectionToRecord(
  ports: LokiMigrationPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  const url = text(stored, 'url', '')
  const hasPassword = text(stored, 'password', '').length > 0
  if (url.length === 0 && !hasPassword)
    return { outcome: 'already-done', summary: { moved: false } }
  const id = await ports.ensureIntegration(LOKI_NAME)
  const put = await ports.putRecord(id, bodyFrom(stored, ports))
  if (hasPassword) {
    // The old password is the only copy until the record verifiably holds one: an existing
    // record that has none (or one that cannot be read) leaves it where it is.
    const held = put === 'created' || (await ports.readRecord(id))?.hasPassword === true
    if (held) await ports.clearOldPassword()
    else
      ports.warn(
        'Loki migration: the existing record holds no password; the legacy one is kept, not cleared',
      )
  }
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true, integrationId: id } }
    : { outcome: 'already-done', summary: { moved: false, integrationId: id } }
}

export interface DropMovedSettingsPorts extends LokiMigrationLog {
  /** The id of the `integrations` row for this addon; null when it has none. */
  findIntegration(): Promise<string | null>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<LokiRecordState | null>
  /** The addon's stored settings as written (markers unresolved), unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = [...MOVED_PLAIN_KEYS, 'password'].filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordHoldsLegacy(ports, stored)
  const rowId = (key: string): string => `${LOKI_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The precondition is the rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [rowId(key), { addonId: LOKI_ADDON_ID, key, value: stored[key] }]),
          ),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when the record is confirmed to hold what they carried: the url,
 * and the password when the legacy settings still have one. Otherwise the migration fails, the
 * keys stay, and the next boot retries.
 */
async function confirmRecordHoldsLegacy(
  ports: DropMovedSettingsPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const legacyUrl = text(stored, 'url', '')
  const legacyPassword = 'password' in stored
  if (legacyUrl.length === 0 && !legacyPassword) return
  const refuse = (reason: string): never => {
    ports.warn(`Loki migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy Loki keys are not deleted: ${reason}`)
  }
  const id = await ports.findIntegration()
  if (id === null) return refuse('no integration row exists')
  const record = await ports.readRecord(id)
  if (record === null) return refuse('the destinations record does not exist')
  if (legacyUrl.length > 0 && record.url.length === 0) return refuse('the record holds no url')
  if (legacyPassword && !record.hasPassword) return refuse('the record holds no password')
}
