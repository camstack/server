import type { ISettingsStoreProvider } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { BackupDestinationPolicyService } from '../destination-policy.js'
import { BackupEncryptionKeyStore } from '../encryption-key-store.js'
import { BackupScheduleService } from '../schedule-store.js'
import { generateBackupKeyPair } from '../../system-backup/backup-encryption.js'
import { BackupSeedMarkerStore } from '../seed-marker-store.js'
import { makeBackupRecords } from './support/backup-records.js'

describe('backup-orchestrator — records path', () => {
  it('every store round-trips through its kind; the key store declares no legacy table', async () => {
    const declared: string[] = []
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a settings-store stand-in that only records declarations
    const legacy = {
      declareCollection: async ({ collection }: { collection: string }) => {
        declared.push(collection)
      },
      query: async () => [],
      insert: async () => {},
      deleteWhere: async () => {},
      set: async () => {},
      get: async () => null,
      update: async () => {},
      delete: async () => {},
    } as unknown as ISettingsStoreProvider
    const { stores: kinds } = await makeBackupRecords()
    const schedules = new BackupScheduleService(kinds.schedules)
    await schedules.upsert({
      id: 'sched-1',
      label: 'Nightly',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:default'],
      retentionCount: 7,
    })
    const policies = new BackupDestinationPolicyService(kinds.destinationPolicies)
    await policies.upsert({
      locationId: 'backups:default',
      enabled: true,
      retentionCount: 7,
    })
    const keys = new BackupEncryptionKeyStore(legacy, () => 1_000, kinds.encryptionKeys)
    const keyPair = generateBackupKeyPair()
    await keys.activate({ publicKey: keyPair.publicKey })
    const markers = new BackupSeedMarkerStore(kinds.seedMarkers, () => 1_000)
    await markers.mark('weekly-events-history')
    expect(declared).toEqual([])
    expect((await schedules.list())[0]?.id).toBe('sched-1')
    expect((await policies.get('backups:default'))?.enabled).toBe(true)
    expect(await keys.active()).not.toBeNull()
    expect(await markers.has('weekly-events-history')).toBe(true)
  })
})
