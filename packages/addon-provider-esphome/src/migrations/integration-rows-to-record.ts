/**
 * Every ESPHome integration moves from legacy `integration_settings` rows into its own
 * `connections` record under the registry id (planning#416, D1007). The body is the `boards` list
 * the rows held: each board keeps its id (the live session id and the owner id of its devices) and
 * its own encryption key and password, which become keychain secrets declared by the kind
 * (`boards[<id>].encryptionKey`, `boards[<id>].password`).
 *
 * The single-board layout kept its board in a separate `brokers` record that an integration named
 * by `brokerId`. That board joins the record of the integration that named it, with the same id
 * and secrets; the old record is deleted only after the integration's record has been read back
 * with the same host and secrets. A board no integration names is left as it is, and said so.
 *
 * Never logs or throws a secret value: messages name integration and board ids only.
 */
import {
  type AddonProcedureMigration,
  type IntegrationRowsPorts,
  moveIntegrationRowsToRecords,
  REDACTED_SECRET,
  type RowsIntegration,
  type RowsMigrationLog,
} from '@camstack/types'
import { type EspBrokerEntry, espBoardRowSchema, rowOfEntry } from '../config.js'
import { type EspConnectionsBody, espConnectionsEntryKind } from '../esphome-instances.js'

export const ESPHOME_ROWS_TO_RECORD_ID = 'provider-esphome/2026-11-05-integration-rows-to-record'

/** What the move crosses beyond the rows and the records: the single-board layout's records. */
export interface EspRowsPorts extends IntegrationRowsPorts {
  /** The old single-board records with their secrets resolved. */
  listLegacy(): Promise<readonly EspBrokerEntry[]>
  /** Delete old single-board records. */
  removeLegacy(ids: readonly string[]): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The record body of one integration, from its resolved legacy rows and the old single-board
 * records. A board that cannot be read faithfully stops the move (the integration is named, the
 * rows stay) rather than being dropped or half-copied.
 */
export function espBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: RowsIntegration,
  legacy: readonly EspBrokerEntry[],
): EspConnectionsBody {
  const boards: ReturnType<typeof espBoardRowSchema.parse>[] = []
  const raw = values['boards']
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = isRecord(item) && typeof item['id'] === 'string' ? item['id'] : '(no id)'
    const parsed = espBoardRowSchema.safeParse(item)
    if (!parsed.success) {
      throw new Error(
        `integration '${integration.id}': board '${id}' is not a usable row - nothing moved`,
      )
    }
    boards.push(parsed.data)
  }
  const brokerId = values['brokerId']
  const record = typeof brokerId === 'string' ? legacy.find((r) => r.id === brokerId) : undefined
  if (record !== undefined && !boards.some((b) => b.id === record.id)) {
    if (
      record.connection.noisePsk === REDACTED_SECRET ||
      record.connection.password === REDACTED_SECRET
    ) {
      throw new Error(
        `integration '${integration.id}': the secrets of the old board '${record.id}' cannot be read - nothing moved`,
      )
    }
    boards.push(espBoardRowSchema.parse(rowOfEntry(record)))
  }
  const known = new Set<string>(['boards', 'brokerId'])
  const unknown = Object.keys(values).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${unknown.join(', ')}`,
    )
  }
  return espConnectionsEntryKind.schema.parse({
    name: integration.name,
    ...(boards.length > 0 ? { boards } : {}),
  })
}

/** Remove the old single-board records the move has carried into a record, verified by read-back. */
async function removeMovedLegacy(ports: EspRowsPorts, legacy: readonly EspBrokerEntry[]) {
  if (legacy.length === 0) return
  const moved = new Set<string>()
  for (const integration of await ports.listIntegrations('provider-esphome')) {
    const back = await ports.readRecord(integration.id)
    const parsed = back === null ? null : espConnectionsEntryKind.schema.safeParse(back)
    for (const board of parsed?.success ? (parsed.data.boards ?? []) : []) {
      const old = legacy.find((r) => r.id === board.id)
      if (
        old !== undefined &&
        old.connection.host === board.host &&
        old.connection.noisePsk === board.encryptionKey &&
        old.connection.password === board.password
      ) {
        moved.add(old.id)
      }
    }
  }
  if (moved.size > 0) await ports.removeLegacy([...moved])
  const left = legacy.filter((r) => !moved.has(r.id)).map((r) => r.id)
  if (left.length > 0) {
    ports.warn(`boards without an integration are left as they are: ${left.join(', ')}`)
  }
}

export const ESPHOME_ROWS_TO_RECORD_MIGRATION: AddonProcedureMigration<EspRowsPorts> = {
  meta: {
    id: ESPHOME_ROWS_TO_RECORD_ID,
    owner: 'provider-esphome',
    level: 'addon-state',
    seq: 1,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'procedure',
    description:
      'Move every ESPHome integration into its own connection record keyed by its registry id, each board keeping its id and its own encryption key and password as keychain secrets, then clear its legacy integration settings rows; the old single-board records join their integration; devices are not touched',
    fixtureMark: 'a board row whose host the migration must carry unchanged',
  },
  procedure: async (ports) => {
    const legacy = await ports.listLegacy()
    const result = await moveIntegrationRowsToRecords(ports, {
      addonId: 'provider-esphome',
      secretPaths: espConnectionsEntryKind.declaration.secretPaths,
      secretArrayKeys: espConnectionsEntryKind.declaration.secretArrayKeys ?? {},
      bodyFrom: (values, log, integration) => espBodyFromRows(values, log, integration, legacy),
    })
    await removeMovedLegacy(ports, legacy)
    return result
  },
}
