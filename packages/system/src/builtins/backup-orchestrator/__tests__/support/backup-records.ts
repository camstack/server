/**
 * The backup orchestrator's records on the REAL engine (in-memory SQLite),
 * for specs: the access an addon gets as `ctx.records`, and its kind handles.
 */
import { createRecordsAccess, type RecordsAccess } from '@camstack/types'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import {
  backupOrchestratorRecordKinds,
  type BackupRecordStores,
  backupRecordStoresOf,
} from '../../record-kinds.js'

export interface BackupRecordsFixture {
  /** What the addon receives as `ctx.records` (it declares the kinds itself). */
  readonly records: RecordsAccess
  /** The kind handles, declared. */
  readonly stores: BackupRecordStores
}

export async function makeBackupRecords(): Promise<BackupRecordsFixture> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'backup-orchestrator',
    transport: world.transportFor('backup-orchestrator'),
    secrets: null,
  })
  await records.declare(backupOrchestratorRecordKinds)
  return { records, stores: backupRecordStoresOf(records) }
}
