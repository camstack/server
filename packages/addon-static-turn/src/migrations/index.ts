import type { AddonMigration } from '@camstack/types'
import {
  type DropMovedSettingsPorts,
  type TurnMigrationPorts,
  moveConnectionToRecord,
  planDropMovedSettings,
} from './connection-to-records.js'

export type {
  DropMovedSettingsPorts,
  TurnMigrationLog,
  TurnMigrationPorts,
  TurnRecordState,
} from './connection-to-records.js'

/** Both bodies read through ONE port object, so the addon binds the catalogue once. */
export type TurnCataloguePorts = TurnMigrationPorts & DropMovedSettingsPorts

export const CONNECTION_TO_RECORDS_ID = 'static-turn/2026-11-02-connection-to-records'
export const DROP_MOVED_SETTINGS_ID = 'static-turn/2026-11-02-drop-moved-settings'

const FIXTURE_MARK = 'a setting key the migration does not know'

/** The `static-turn` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<TurnCataloguePorts>[] = [
  {
    meta: {
      id: CONNECTION_TO_RECORDS_ID,
      owner: 'static-turn',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the static TURN server (urls, username, credential) from the addon settings into a servers record',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveConnectionToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_SETTINGS_ID,
      owner: 'static-turn',
      level: 'addon-state',
      seq: 2,
      dependsOn: [CONNECTION_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Delete the TURN keys that moved into the servers record',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedSettings,
  },
]
