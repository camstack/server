/**
 * The Loki connection moves from the addon's settings into a `destinations` record (D985):
 * an integration row in the registry, a record under that id, and the password re-bound to
 * the record's keychain slot. The old keys are deleted by the second migration of the
 * catalogue (`dropMovedSettings`), only after this one succeeded.
 *
 * Idempotent and ordered so a crash is safe: nothing is written before the old settings are
 * read in full (a password that cannot be resolved aborts the pass); an existing record is
 * never overwritten; the old password is cleared on every pass that still finds one.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { LOKI_DEFAULT_BODY, type LokiDestinationBody } from '../loki-record-kinds.js'

/** The settings scope of this addon (`<addonId>:addon-settings`). */
export const LOKI_SETTINGS_SCOPE = 'loki-logging:addon-settings'

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

export interface LokiMigrationPorts {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** The id of the `integrations` row for this addon, created when absent. */
  ensureIntegration(name: string): Promise<string>
  /** Put the record under `id` with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(id: string, body: LokiDestinationBody): Promise<'created' | 'exists'>
  /** Remove the old password and its keychain value. */
  clearOldPassword(): Promise<void>
}

const LOKI_NAME = 'Loki'

function text(stored: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value : fallback
}

function whole(stored: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = stored[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function levelOf(stored: Readonly<Record<string, unknown>>): LokiDestinationBody['level'] {
  const value = stored['level']
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : LOKI_DEFAULT_BODY.level
}

function bodyFrom(stored: Readonly<Record<string, unknown>>): LokiDestinationBody {
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
    batchIntervalMs: whole(stored, 'batchIntervalMs', LOKI_DEFAULT_BODY.batchIntervalMs),
    batchSize: whole(stored, 'batchSize', LOKI_DEFAULT_BODY.batchSize),
    timeoutMs: whole(stored, 'timeoutMs', LOKI_DEFAULT_BODY.timeoutMs),
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
  const put = await ports.putRecord(id, bodyFrom(stored))
  if (hasPassword) await ports.clearOldPassword()
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true, integrationId: id } }
    : { outcome: 'already-done', summary: { moved: false, integrationId: id } }
}

export interface DropMovedSettingsPorts {
  /** The addon's stored settings as written (markers unresolved), unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = [...MOVED_PLAIN_KEYS, 'password'].filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: LOKI_SETTINGS_SCOPE,
        keys: present,
        precondition: preconditionOf(Object.fromEntries(present.map((key) => [key, stored[key]]))),
      },
    ],
  }
}
