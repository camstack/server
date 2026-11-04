/**
 * The rows-to-record migration of a device addon whose integrations hold REAL settings
 * (planning#416, S-B): every integration of the addon becomes a record of the addon's own kind
 * under its registry id, the record body built from the legacy `integration_settings` rows, and
 * the rows and their keychain values are cleared once the record is read back
 * (`moveIntegrationRowsToRecords`). The addon declares ONE entry kind; this file turns that kind
 * into the body, the migration and its ports, so an addon states nothing but the kind.
 *
 * It runs in the addon process through the hub API, BEFORE the addon registers its
 * `integration-instances` provider, and nothing reads the old rows afterwards.
 */
import { z } from 'zod'
import { isSecretMarkerLike } from '../keychain/secret-marker.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordsAccess } from '../records/records-access.js'
import type { AddonProcedureMigration } from './addon-migration.js'
import {
  type IntegrationRowsApi,
  integrationRowsPortsOverApi,
} from './integration-rows-api-ports.js'
import {
  type IntegrationRowsPorts,
  moveIntegrationRowsToRecords,
  type RowsIntegration,
  type RowsMigrationLog,
} from './integration-rows-to-record.js'

/**
 * The record body of one integration from its resolved legacy rows. A key the kind has no field
 * for, or whose value the field refuses, is dropped and named in a warning (keys only, never a
 * value); a blank value is no value. A secret the keychain could not serve (a marker, not a
 * string) throws: moving it would lose it, and the rows are still there.
 */
export function integrationBodyFromRows<S extends z.ZodObject>(
  kind: DefinedRecordKind<S>,
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: RowsIntegration,
): z.infer<S> {
  const fields = new Map(Object.entries(kind.schema.shape))
  const body: Record<string, unknown> = { name: integration.name }
  const dropped: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (isSecretMarkerLike(value)) {
      throw new Error(
        `integration '${integration.id}': ${key} could not be read from the keychain - nothing moved`,
      )
    }
    if (value === undefined || value === null || value === '') continue
    const field = key === 'name' ? undefined : fields.get(key)
    if (field === undefined || !field.safeParse(value).success) {
      dropped.push(key)
      continue
    }
    body[key] = value
  }
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings the ${kind.name} record has no valid field for are dropped: ${dropped.join(', ')}`,
    )
  }
  return kind.schema.parse(body)
}

export function integrationRowsToRecordId(addonId: string, date: string): string {
  return `${addonId}/${date}-integration-rows-to-record`
}

export function integrationRowsMigration<S extends z.ZodObject>(spec: {
  readonly addonId: string
  /** `yyyy-mm-dd` of the migration id. */
  readonly date: string
  readonly kind: DefinedRecordKind<S>
  /** The legacy row key the spec marks, to prove it survived the move. */
  readonly fixtureMark: string
}): AddonProcedureMigration<IntegrationRowsPorts> {
  return {
    meta: {
      id: integrationRowsToRecordId(spec.addonId, spec.date),
      owner: spec.addonId,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move every integration of the addon into a typed instance record keyed by its registry id, with its connection settings and secrets, then clear the legacy integration settings rows',
      fixtureMark: spec.fixtureMark,
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: spec.addonId,
        secretPaths: spec.kind.declaration.secretPaths,
        secretArrayKeys: spec.kind.declaration.secretArrayKeys,
        bodyFrom: (values, log, integration) =>
          integrationBodyFromRows(spec.kind, values, log, integration),
      }),
  }
}

/** The hub and records sides of {@link integrationRowsMigration}. */
export function integrationRowsPortsOver(deps: {
  readonly api: IntegrationRowsApi
  readonly records: Pick<RecordsAccess, 'kind'>
  readonly kind: DefinedRecordKind
  readonly warn: (message: string) => void
}): IntegrationRowsPorts {
  return integrationRowsPortsOverApi({
    api: deps.api,
    // The move reads and writes the body as it is stored, so the handle takes any object.
    records: deps.records.kind({
      name: deps.kind.name,
      declaration: deps.kind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
}
