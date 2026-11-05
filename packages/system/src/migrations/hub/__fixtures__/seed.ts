/**
 * The legacy data the hub catalogue meets on a node that last ran an old release: written by
 * hand, in the shape that release stored it, with a MARK in every row so a migration that
 * rewrote a row instead of re-keying it is caught by the replay
 * (`migration-catalogue-replay.spec.ts`).
 */
import type Database from 'better-sqlite3'
import { integrationRegistryRecordKinds } from '../../../builtins/sqlite-storage/integration-record-kinds.js'
import { ensureLegacyIntegrationRowsTable } from '../../../builtins/sqlite-storage/migrations/legacy-integration-rows-door.js'
import {
  declareKind,
  ensureRecordsSchema,
} from '../../../builtins/sqlite-storage/records/records-catalog.js'
import { RECORDS_SCHEMA_SQL } from '../../../builtins/sqlite-storage/records/records-sql.js'

export interface HubSeedMarks {
  /** `addon-settings` row id to its mark; every one of them gains a `nodeId`. */
  readonly nodeRows: Readonly<Record<string, string>>
  /** The integration-registry row stamped `addon:<id>`: it keeps its id and mark, gains the bare id. */
  readonly integration: { readonly id: string; readonly bareAddonId: string; readonly mark: string }
  /** A record row of a grouped runner's kind, as `<owner>/<kind>/<id>` after the re-own. */
  readonly regrouped: { readonly key: string; readonly mark: string }
}

const INSERT_RECORD =
  'INSERT INTO records(kind_id, id, rev, updated_at, data) VALUES (?, ?, 3, 100, jsonb(?))'

export function seedHubCatalogue(db: Database.Database): HubSeedMarks {
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)').run(
    'detector.backend@agent-1',
    JSON.stringify({ addonId: 'detector', key: 'backend@agent-1', value: 'npu', mark: 'node-1' }),
  )
  // the legacy per-integration settings table of the release, empty: nothing left to drop
  ensureLegacyIntegrationRowsTable(db)
  ensureRecordsSchema(db)
  db.exec(RECORDS_SCHEMA_SQL)
  const declaration = integrationRegistryRecordKinds.integrations.declaration
  const registry = declareKind(db, 'integration-registry', 'integrations', declaration, undefined)
  db.prepare(INSERT_RECORD).run(
    registry.row.kindId,
    'int_0001',
    JSON.stringify({
      addonId: 'addon:provider-spec',
      name: 'Spec',
      enabled: true,
      info: {},
      createdAt: 1,
      updatedAt: 2,
      mark: 'integration-1',
    }),
  )
  const grouped = declareKind(db, 'net-access', 'servers', declaration, undefined)
  db.prepare(INSERT_RECORD).run(grouped.row.kindId, 'a', JSON.stringify({ mark: 'grouped-1' }))
  return {
    nodeRows: { 'detector.backend@agent-1': 'node-1' },
    integration: { id: 'int_0001', bareAddonId: 'provider-spec', mark: 'integration-1' },
    regrouped: { key: 'static-turn/servers/a', mark: 'grouped-1' },
  }
}
