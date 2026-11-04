/**
 * Every Reolink integration moves from legacy `integration_settings` rows into its own
 * `connections` record under the registry id (planning#416, D1007). An NVR / Home Hub integration
 * carries its connection (host, ports, username, transport, uid, the two debug fields) and its
 * password, a keychain secret declared by the kind; the default integration carries a name only.
 * Each integration's record is built from ITS OWN rows, never from another's.
 *
 * Keys nothing reads any more are named in a warning, by key, and dropped with the rows once the
 * record has been read back. A value of the wrong type is left out and named by key as well.
 */
import {
  type AddonProcedureMigration,
  type IntegrationRowsPorts,
  moveIntegrationRowsToRecords,
  type RowsIntegration,
  type RowsMigrationLog,
} from '@camstack/types'
import { ReolinkSocketDebugFlagSchema } from '../schema.js'
import { type ReolinkConnectionBody, reolinkConnectionsEntryKind } from '../reolink-instances.js'

export const REOLINK_ROWS_TO_RECORD_ID = 'provider-reolink/2026-11-05-integration-rows-to-record'

const TEXT_KEYS = ['host', 'username', 'uid'] as const
const PORT_KEYS = ['port', 'rtspPort'] as const

function portOf(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The record body of one integration, from its resolved legacy rows. Never logs a value. */
export function reolinkBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: RowsIntegration,
): ReolinkConnectionBody {
  const body: Record<string, unknown> = { name: integration.name }
  const unusable: string[] = []
  const known = new Set<string>([
    ...TEXT_KEYS,
    ...PORT_KEYS,
    'password',
    'transport',
    'debugGeneral',
    'debugSocketLogs',
  ])
  for (const key of TEXT_KEYS) {
    if (!(key in values)) continue
    const text = textOf(values[key])
    if (text === null) unusable.push(key)
    else body[key] = text
  }
  for (const key of PORT_KEYS) {
    if (!(key in values)) continue
    const port = portOf(values[key])
    if (port === null) unusable.push(key)
    else body[key] = port
  }
  if ('password' in values) {
    const password = values['password']
    if (typeof password === 'string' && password.length > 0) body['password'] = password
    else unusable.push('password')
  }
  if ('transport' in values) {
    const transport = values['transport']
    if (transport === 'tcp' || transport === 'udp') body['transport'] = transport
    else unusable.push('transport')
  }
  if ('debugGeneral' in values) {
    const flag = values['debugGeneral']
    if (typeof flag === 'boolean') body['debugGeneral'] = flag
    else unusable.push('debugGeneral')
  }
  if ('debugSocketLogs' in values) {
    const flags = values['debugSocketLogs']
    const parsed = Array.isArray(flags)
      ? flags.map((f) => ReolinkSocketDebugFlagSchema.safeParse(f))
      : null
    if (parsed !== null && parsed.every((p) => p.success)) {
      body['debugSocketLogs'] = parsed.flatMap((p) => (p.success ? [p.data] : []))
    } else unusable.push('debugSocketLogs')
  }
  const unknown = Object.keys(values).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${unknown.join(', ')}`,
    )
  }
  if (unusable.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings with an unusable value are left out: ${unusable.join(', ')}`,
    )
  }
  return reolinkConnectionsEntryKind.schema.parse(body)
}

export const REOLINK_ROWS_TO_RECORD_MIGRATION: AddonProcedureMigration<IntegrationRowsPorts> = {
  meta: {
    id: REOLINK_ROWS_TO_RECORD_ID,
    owner: 'provider-reolink',
    level: 'addon-state',
    seq: 4,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'procedure',
    description:
      'Move every Reolink integration (the default one and each NVR / Home Hub) into its own connection record keyed by its registry id, the password as a keychain secret, then clear its legacy integration settings rows',
    fixtureMark: 'a legacy setting key the migration does not know',
  },
  procedure: (ports) =>
    moveIntegrationRowsToRecords(ports, {
      addonId: 'provider-reolink',
      secretPaths: reolinkConnectionsEntryKind.declaration.secretPaths,
      bodyFrom: reolinkBodyFromRows,
    }),
}
