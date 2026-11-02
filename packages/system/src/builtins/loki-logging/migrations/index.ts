import type { AddonMigration } from '@camstack/types'
import {
  type DropMovedSettingsPorts,
  type LokiMigrationPorts,
  moveConnectionToRecord,
  planDropMovedSettings,
} from './connection-to-records.js'

export type { DropMovedSettingsPorts, LokiMigrationPorts } from './connection-to-records.js'

/** Both bodies read through ONE port object, so the addon binds the catalogue once. */
export type LokiCataloguePorts = LokiMigrationPorts & DropMovedSettingsPorts

export const CONNECTION_TO_RECORDS_ID = 'loki-logging/2026-11-02-connection-to-records'

/** The `loki-logging` catalogue (D987): offered to the engine when the hub-resident addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<LokiCataloguePorts>[] = [
  {
    meta: {
      id: CONNECTION_TO_RECORDS_ID,
      owner: 'loki-logging',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the Loki connection (url, credentials, labels, batching) from the addon settings into a destinations record under an integrations row',
      fixtureMark: 'the D777 retirement marker the migration does not know',
    },
    procedure: moveConnectionToRecord,
  },
  {
    meta: {
      id: 'loki-logging/2026-11-02-drop-moved-settings',
      owner: 'loki-logging',
      level: 'addon-state',
      seq: 2,
      dependsOn: [CONNECTION_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Delete the connection keys that moved into the destinations record',
      fixtureMark: 'the D777 retirement marker the migration does not know',
    },
    plan: planDropMovedSettings,
  },
]
