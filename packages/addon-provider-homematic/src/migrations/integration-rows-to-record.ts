/**
 * Every Homematic integration moves from legacy `integration_settings` rows into its own
 * `connections` record under the registry id (planning#416, D1007): the CCU connection the live
 * session dials, the WebUI password a keychain secret declared by the kind. Each integration's
 * record is built from ITS OWN rows, never from another's. Only the integration configuration
 * moves: adopted devices, their stable ids and their history are not touched.
 *
 * Keys nothing reads any more are named in a warning, by key, and dropped with the rows once the
 * record has been read back; a value of the wrong type is left out and named by key as well.
 */
import {
  type AddonProcedureMigration,
  type IntegrationRowsPorts,
  moveIntegrationRowsToRecords,
  type RowsIntegration,
  type RowsMigrationLog,
} from '@camstack/types'
import {
  type HomematicConnectionBody,
  homematicConnectionsEntryKind,
} from '../homematic-instances.js'

export const HOMEMATIC_ROWS_TO_RECORD_ID =
  'provider-homematic/2026-11-05-integration-rows-to-record'

const TEXT_KEYS = ['host', 'username', 'callbackHost'] as const
const FLAG_KEYS = [
  'enableHmipRf',
  'enableBidcosRf',
  'enableGroups',
  'enableBidcosWired',
  'tls',
] as const

function portOf(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/** The record body of one integration, from its resolved legacy rows. Never logs a value. */
export function homematicBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: RowsIntegration,
): HomematicConnectionBody {
  const body: Record<string, unknown> = { name: integration.name }
  const unusable: string[] = []
  const known = new Set<string>(['password', 'callbackPort', ...TEXT_KEYS, ...FLAG_KEYS])
  for (const key of TEXT_KEYS) {
    if (!(key in values)) continue
    const raw = values[key]
    if (typeof raw === 'string') {
      if (raw.trim() !== '') body[key] = raw.trim()
    } else unusable.push(key)
  }
  for (const key of FLAG_KEYS) {
    if (!(key in values)) continue
    const raw = values[key]
    if (typeof raw === 'boolean') body[key] = raw
    else unusable.push(key)
  }
  if ('callbackPort' in values) {
    const raw = values['callbackPort']
    // A blank number field is "unset" (the default port applies), not an unusable value.
    if (raw !== '' && raw !== null) {
      const port = portOf(raw)
      if (port === null) unusable.push('callbackPort')
      else body['callbackPort'] = port
    }
  }
  if ('password' in values) {
    const password = values['password']
    // An empty password is "none" (a CCU without WebUI login), not an unusable value.
    if (typeof password === 'string') {
      if (password.length > 0) body['password'] = password
    } else unusable.push('password')
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
  return homematicConnectionsEntryKind.schema.parse(body)
}

export const HOMEMATIC_ROWS_TO_RECORD_MIGRATION: AddonProcedureMigration<IntegrationRowsPorts> = {
  meta: {
    id: HOMEMATIC_ROWS_TO_RECORD_ID,
    owner: 'provider-homematic',
    level: 'addon-state',
    seq: 1,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'procedure',
    description:
      'Move every Homematic CCU integration into its own connection record keyed by its registry id, the WebUI password as a keychain secret, then clear its legacy integration settings rows; adopted devices are not touched',
    fixtureMark: 'a legacy setting key the migration does not know',
  },
  procedure: (ports) =>
    moveIntegrationRowsToRecords(ports, {
      addonId: 'provider-homematic',
      secretPaths: homematicConnectionsEntryKind.declaration.secretPaths,
      bodyFrom: homematicBodyFromRows,
    }),
}
