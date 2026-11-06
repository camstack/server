/**
 * A hub's `storage-orchestrator` records on the real records provider, pre-filled with the
 * locations a previous boot persisted. A row is given in the legacy column spelling
 * (`display_name`, `provider_id`, ...) the specs were written in and lands as a location body.
 */
import { createRecordsAccess, type RecordsAccess } from '@camstack/types'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { SqliteLocationStore } from '../../location-store.js'
import { storageOrchestratorRecordKinds } from '../../record-kinds.js'

export interface SeedLocationRow {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
}

export async function seededLocationRecords(
  rows: readonly SeedLocationRow[],
): Promise<RecordsAccess> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'storage-orchestrator',
    transport: world.transportFor('storage-orchestrator'),
    secrets: null,
  })
  await records.declare(storageOrchestratorRecordKinds)
  const kind = SqliteLocationStore.recordStoresOf(records)
  for (const row of rows) {
    const d = row.data
    await kind.put({
      id: row.id,
      data: storageOrchestratorRecordKinds.locations.schema.parse({
        type: d['type'],
        displayName: d['display_name'],
        providerId: d['provider_id'],
        config: d['config'],
        isSystem: d['is_system'] === 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    })
  }
  return records
}
