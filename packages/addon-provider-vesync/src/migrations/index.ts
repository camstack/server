import type { AddonMigration } from '@camstack/types'
import { migrateVeSyncHubs } from './vesync-hub-to-integration.js'
import type { VeSyncMigrationPorts } from './ports.js'

export type { VeSyncMigrationPorts } from './ports.js'
export {
  VESYNC_ROWS_TO_RECORD_ID,
  VESYNC_ROWS_TO_RECORD_MIGRATION,
} from './integration-rows-to-record.js'

export const VESYNC_HUB_MIGRATION_ID = 'provider-vesync/2026-11-04-hub-to-integration-gateway'

/** The catalogue that needs the persisted devices (D987): offered from `onRestoreDevices`. */
export const ADDON_MIGRATIONS: readonly AddonMigration<VeSyncMigrationPorts>[] = [
  {
    meta: {
      id: VESYNC_HUB_MIGRATION_ID,
      owner: 'provider-vesync',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move each VeSync Hub device into an integration with a Gateway sibling, keeping every purifier deviceId, stableId and persisted field, and retire the hub by tombstone',
      fixtureMark: 'a purifier config field the migration does not know',
    },
    procedure: migrateVeSyncHubs,
  },
]
