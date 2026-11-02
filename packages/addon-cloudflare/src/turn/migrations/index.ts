import type { AddonMigration } from '@camstack/types'
import {
  type CloudflareTurnMigrationPorts,
  type DropMovedSettingsPorts,
  moveConnectionToRecord,
  planDropMovedSettings,
} from './connection-to-records.js'

export type {
  CloudflareTurnMigrationLog,
  CloudflareTurnMigrationPorts,
  CloudflareTurnRecordState,
  DropMovedSettingsPorts,
} from './connection-to-records.js'

/** Both bodies read through ONE port object, so the addon binds the catalogue once. */
export type CloudflareTurnCataloguePorts = CloudflareTurnMigrationPorts & DropMovedSettingsPorts

export const CONNECTION_TO_RECORDS_ID = 'cloudflare-turn/2026-11-02-connection-to-records'
export const DROP_MOVED_SETTINGS_ID = 'cloudflare-turn/2026-11-02-drop-moved-settings'

const FIXTURE_MARK = 'a setting key the migration does not know'

/** The `cloudflare-turn` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<CloudflareTurnCataloguePorts>[] = [
  {
    meta: {
      id: CONNECTION_TO_RECORDS_ID,
      owner: 'cloudflare-turn',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the Cloudflare TURN Key ID and API token from the addon settings into an accounts record',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveConnectionToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_SETTINGS_ID,
      owner: 'cloudflare-turn',
      level: 'addon-state',
      seq: 2,
      dependsOn: [CONNECTION_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Delete the Cloudflare TURN keys that moved into the accounts record',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedSettings,
  },
]
