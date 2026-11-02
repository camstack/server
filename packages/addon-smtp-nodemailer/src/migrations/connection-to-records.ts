/**
 * The SMTP relay moves from the addon's settings into a `relays` record (D985, D996): an
 * integration row in the registry, a record under that id, and the password re-bound to the
 * record's keychain slot. The old keys are deleted by the second migration of the catalogue
 * (`planDropMovedSettings`), only after this one succeeded and the record is confirmed.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are read
 * in full (a password that cannot be resolved aborts the pass); an existing record is never
 * overwritten; the old password is cleared only once the record verifiably holds it.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { RELAY_DEFAULT_BODY, RELAY_PORT_BOUNDS, type SmtpRelayBody } from '../relay-record-kinds.js'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const SMTP_ADDON_ID = 'smtp-nodemailer'

/**
 * Where the addon's global settings live: the canonical `addon-settings` table, one row per
 * key, id `<addonId>.<key>`, data `{ addonId, key, value }` (never a per-addon scoped table,
 * which exists only when something lazily declared it).
 */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The connection keys the record now owns. `password` is the secret, cleared separately. */
export const MOVED_PLAIN_KEYS: readonly string[] = [
  'host',
  'port',
  'secure',
  'username',
  'fromAddress',
  'fromName',
]

/** What the migrations say about a decision they took; never carries a value. */
export interface SmtpMigrationLog {
  warn(message: string): void
}

/** What the relay record holds, as far as the migrations care. */
export interface SmtpRecordState {
  readonly host: string
  readonly hasPassword: boolean
}

export interface SmtpMigrationPorts extends SmtpMigrationLog {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** The id of the `integrations` row for this addon, created when absent. */
  ensureIntegration(name: string): Promise<string>
  /** Put the record under `id` with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(id: string, body: SmtpRelayBody): Promise<'created' | 'exists'>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<SmtpRecordState | null>
  /** Remove the old password and its keychain value. */
  clearOldPassword(): Promise<void>
}

const RELAY_NAME = 'Email (SMTP)'

function text(stored: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * A whole port inside the kind's own bounds: an out-of-range legacy value would make the record
 * write throw and block the owner, so it is clamped, and the clamp is named. A numeric string
 * (an older form wrote one) is read as the number it spells.
 */
function portOf(stored: Readonly<Record<string, unknown>>, log: SmtpMigrationLog): number {
  const value = stored['port']
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return RELAY_DEFAULT_BODY.port
  const { min, max } = RELAY_PORT_BOUNDS
  const clamped = Math.min(max, Math.max(min, Math.round(numeric)))
  if (clamped !== numeric) {
    log.warn(`SMTP migration: the legacy "port" is outside ${min}..${max}; clamped to ${clamped}`)
  }
  return clamped
}

function secureOf(stored: Readonly<Record<string, unknown>>): boolean {
  const value = stored['secure']
  if (typeof value === 'boolean') return value
  return value === 'true' ? true : RELAY_DEFAULT_BODY.secure
}

function bodyFrom(stored: Readonly<Record<string, unknown>>, log: SmtpMigrationLog): SmtpRelayBody {
  const password = text(stored, 'password', '')
  return {
    name: RELAY_NAME,
    host: text(stored, 'host', RELAY_DEFAULT_BODY.host),
    port: portOf(stored, log),
    secure: secureOf(stored),
    username: text(stored, 'username', RELAY_DEFAULT_BODY.username),
    ...(password.length > 0 ? { password } : {}),
    fromAddress: text(stored, 'fromAddress', RELAY_DEFAULT_BODY.fromAddress),
    fromName: text(stored, 'fromName', RELAY_DEFAULT_BODY.fromName),
  }
}

export async function moveConnectionToRecord(
  ports: SmtpMigrationPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  const host = text(stored, 'host', '')
  const hasPassword = text(stored, 'password', '').length > 0
  if (host.length === 0 && !hasPassword)
    return { outcome: 'already-done', summary: { moved: false } }
  const id = await ports.ensureIntegration(RELAY_NAME)
  const put = await ports.putRecord(id, bodyFrom(stored, ports))
  if (hasPassword) {
    // The old password is the only copy until the record verifiably holds one: an existing
    // record that has none (or one that cannot be read) leaves it where it is.
    const held = put === 'created' || (await ports.readRecord(id))?.hasPassword === true
    if (held) await ports.clearOldPassword()
    else
      ports.warn(
        'SMTP migration: the existing record holds no password; the legacy one is kept, not cleared',
      )
  }
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true, integrationId: id } }
    : { outcome: 'already-done', summary: { moved: false, integrationId: id } }
}

export interface DropMovedSettingsPorts extends SmtpMigrationLog {
  /** The id of the `integrations` row for this addon; null when it has none. */
  findIntegration(): Promise<string | null>
  /** The record under `id`, secret resolved; null when absent. Throws when it cannot be read. */
  readRecord(id: string): Promise<SmtpRecordState | null>
  /** The addon's stored settings as written (markers unresolved), unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = [...MOVED_PLAIN_KEYS, 'password'].filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordHoldsLegacy(ports, stored)
  const rowId = (key: string): string => `${SMTP_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The precondition is the rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [rowId(key), { addonId: SMTP_ADDON_ID, key, value: stored[key] }]),
          ),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when the record is confirmed to hold what they carried: the host,
 * and the password when the legacy settings still have one. Otherwise the migration fails, the
 * keys stay, and the next boot retries.
 */
async function confirmRecordHoldsLegacy(
  ports: DropMovedSettingsPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const legacyHost = text(stored, 'host', '')
  const legacyPassword = 'password' in stored
  if (legacyHost.length === 0 && !legacyPassword) return
  const refuse = (reason: string): never => {
    ports.warn(`SMTP migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy SMTP keys are not deleted: ${reason}`)
  }
  const id = await ports.findIntegration()
  if (id === null) return refuse('no integration row exists')
  const record = await ports.readRecord(id)
  if (record === null) return refuse('the relays record does not exist')
  if (legacyHost.length > 0 && record.host.length === 0) return refuse('the record holds no host')
  if (legacyPassword && !record.hasPassword) return refuse('the record holds no password')
}
