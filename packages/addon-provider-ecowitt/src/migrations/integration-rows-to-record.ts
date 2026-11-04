/**
 * Every Ecowitt integration moves from legacy `integration_settings` rows into its own
 * `connections` record under the registry id (planning#416, D1007): the connection the live client
 * dials, the password a keychain secret declared by the kind. Each integration's record is built
 * from ITS OWN rows, never from another's. Only the integration configuration moves: devices, their
 * stable ids and their history are not touched.
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
import { type EcowittConnectionBody, ecowittConnectionsEntryKind } from '../ecowitt-instances.js'

export const ECOWITT_ROWS_TO_RECORD_ID = 'provider-ecowitt/2026-11-05-integration-rows-to-record'

const TEXT_KEYS = ['host', 'listenHost', 'stationId'] as const
const NUMBER_KEYS = [
  ['port', 1, 65535],
  ['pollIntervalMs', 1000, 3_600_000],
  ['mappingIntervalMs', 10_000, 86_400_000],
  ['listenPort', 1, 65535],
] as const

function numberOf(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** The record body of one integration, from its resolved legacy rows. Never logs a value. */
export function ecowittBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: RowsIntegration,
): EcowittConnectionBody {
  const body: Record<string, unknown> = { name: integration.name }
  const unusable: string[] = []
  const known = new Set<string>([
    'transport',
    'password',
    ...TEXT_KEYS,
    ...NUMBER_KEYS.map(([key]) => key),
  ])
  if ('transport' in values) {
    const transport = values['transport']
    if (transport === 'local' || transport === 'listener') body['transport'] = transport
    else unusable.push('transport')
  }
  for (const key of TEXT_KEYS) {
    if (!(key in values)) continue
    const raw = values[key]
    // A blank bind host or station id is "unset", not an unusable value.
    if (typeof raw === 'string') {
      if (raw.trim() !== '') body[key] = raw.trim()
    } else unusable.push(key)
  }
  for (const [key, min, max] of NUMBER_KEYS) {
    if (!(key in values)) continue
    const n = numberOf(values[key], min, max)
    if (n === null) unusable.push(key)
    else body[key] = n
  }
  if ('password' in values) {
    const password = values['password']
    // An empty password is "none" (the gateway has none), not an unusable value.
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
  return ecowittConnectionsEntryKind.schema.parse(body)
}

export const ECOWITT_ROWS_TO_RECORD_MIGRATION: AddonProcedureMigration<IntegrationRowsPorts> = {
  meta: {
    id: ECOWITT_ROWS_TO_RECORD_ID,
    owner: 'provider-ecowitt',
    level: 'addon-state',
    seq: 2,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'procedure',
    description:
      'Move every Ecowitt gateway integration into its own connection record keyed by its registry id, the password as a keychain secret, then clear its legacy integration settings rows; devices are not touched',
    fixtureMark: 'a legacy setting key the migration does not know',
  },
  procedure: (ports) =>
    moveIntegrationRowsToRecords(ports, {
      addonId: 'provider-ecowitt',
      secretPaths: ecowittConnectionsEntryKind.declaration.secretPaths,
      bodyFrom: ecowittBodyFromRows,
    }),
}
