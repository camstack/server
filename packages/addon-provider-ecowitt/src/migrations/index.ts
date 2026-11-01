import type { AddonMigration } from '@camstack/types'
import { migrateEcowittHubs } from './ecowitt-hub-to-integration.js'
import type { EcowittMigrationPorts } from './ports.js'

export type { EcowittMigrationPorts } from './ports.js'

/** The Ecowitt catalogue (D987): offered to the engine from `onRestoreDevices`. */
export const ADDON_MIGRATIONS: readonly AddonMigration<EcowittMigrationPorts>[] = [
  {
    meta: {
      id: 'provider-ecowitt/2026-11-01-hub-to-integration-gateway',
      owner: 'provider-ecowitt',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move each Ecowitt Hub device into an integration with a Gateway sibling, keeping every child deviceId, stableId and persisted field, and retire the hub by tombstone',
      fixtureMark: 'a sensor config field the migration does not know',
    },
    procedure: migrateEcowittHubs,
  },
]
