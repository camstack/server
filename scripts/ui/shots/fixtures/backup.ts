/**
 * System → Data → Backup (`/system/data?tab=backup`): two destinations, the
 * nightly schedule (settings, no `databases` = legacy), the seeded weekly
 * (events + history), archives of both kinds, and a hub whose history database
 * does not exist yet.
 */
import { defineFixtures } from './_define'
import { D, H, MINUTE, NOW } from './_time'

const DEST_LOCAL = 'backups:default'
const DEST_NAS = 'backups:nas'

const destination = (id: string, displayName: string, kind: string) => ({
  id,
  addonId: 'local-backup',
  subId: id,
  displayName,
  kind,
  triggerSupported: true,
  restoreSupported: true,
  enabled: true,
  retentionCount: 7,
  lastSuccessAt: NOW - 8 * H,
  lastSuccessSizeBytes: 1_300_000_000,
})

const archives = [
  {
    id: 'arc-n3',
    filename: 'nightly-3.tar.gz',
    createdAt: NOW - 6 * H,
    sizeBytes: 1_310_000_000,
    label: 'Nightly',
    locations: ['config.yaml', 'addons', 'addons-data', 'tls'],
    databases: ['settings'],
  },
  {
    id: 'arc-w1',
    filename: 'weekly-1.tar.gz',
    createdAt: NOW - 2 * D,
    sizeBytes: 212_000_000,
    label: 'Weekly — events & history',
    locations: [],
    databases: ['events', 'history'],
  },
  {
    id: 'arc-n2',
    filename: 'nightly-2.tar.gz',
    createdAt: NOW - 1 * D - 6 * H,
    sizeBytes: 1_290_000_000,
    label: 'Nightly',
    locations: ['config.yaml', 'addons', 'addons-data', 'tls'],
  },
]

export default defineFixtures({
  area: 'backup',
  description: 'Backup page: schedules, destinations, archives with and without database lists',
  handlers: {
    'backup.listDestinations': [
      destination(DEST_LOCAL, 'Local backups', 'local'),
      destination(DEST_NAS, 'NAS share', 'smb'),
    ],
    'backup.listSchedules': [
      {
        id: 'nightly',
        label: 'Nightly',
        cron: '0 3 * * *',
        enabled: true,
        locationIds: [DEST_LOCAL, DEST_NAS],
        retentionCount: 7,
        lastSuccessAt: NOW - 6 * H,
        nextRunAt: NOW + 17 * H,
      },
      {
        id: 'weekly-events-history',
        label: 'Weekly — events & history',
        cron: '0 4 * * 0',
        enabled: true,
        locationIds: [DEST_LOCAL, DEST_NAS],
        retentionCount: 4,
        databases: ['events', 'history'],
        lastSuccessAt: NOW - 2 * D,
        nextRunAt: NOW + 5 * D,
      },
      {
        id: 'monthly-full',
        label: 'Monthly — everything',
        cron: '0 5 1 * *',
        enabled: false,
        locationIds: [DEST_NAS],
        retentionCount: 3,
        databases: ['settings', 'events', 'history'],
        lastSuccessAt: NOW - 20 * D,
        nextRunAt: NOW + 10 * D,
      },
    ],
    // `history` is not open yet on this fixture hub: shown disabled, not hidden.
    'backup.listAvailableDatabases': { answered: true, databases: ['settings', 'events'] },
    'backup.listArchives': archives,
    'backup.listRuns': [
      {
        id: 'run-1',
        state: 'succeeded',
        phase: 'done',
        destinationIds: [DEST_LOCAL],
        label: 'Nightly',
        requestedAt: NOW - 6 * H,
        startedAt: NOW - 6 * H,
        finishedAt: NOW - 6 * H + 4 * MINUTE,
        stagedBytes: 1_310_000_000,
        archiveSizeBytes: 1_310_000_000,
        uploadedBytes: 1_310_000_000,
        completedDestinationIds: [DEST_LOCAL],
        failedDestinationIds: [],
      },
    ],
    'backup.getEncryption': { enabled: false, active: null, keys: [] },
    'backup.getEntries': [],
  },
})
