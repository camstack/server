import type { AddonMigration } from '@camstack/types'
import {
  type DropMovedSettingsPorts,
  type ModalMigrationPorts,
  moveEntriesToRecords,
  planDropMovedSettings,
} from './entries-to-records.js'

export type {
  DropMovedSettingsPorts,
  ModalMigrationLog,
  ModalMigrationPorts,
  ModalRecordState,
} from './entries-to-records.js'

/** Both bodies read through ONE port object, so the addon binds the catalogue once. */
export type ModalCataloguePorts = ModalMigrationPorts & DropMovedSettingsPorts

export const ENTRIES_TO_RECORDS_ID = 'training-modal/2026-11-04-entries-to-records'
export const DROP_MOVED_SETTINGS_ID = 'training-modal/2026-11-04-drop-moved-settings'

const FIXTURE_MARK = 'a setting key the migration does not know'

/** The `training-modal` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<ModalCataloguePorts>[] = [
  {
    meta: {
      id: ENTRIES_TO_RECORDS_ID,
      owner: 'training-modal',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description: 'Move the Modal accounts from the addon settings into training-account records',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveEntriesToRecords,
  },
  {
    meta: {
      id: DROP_MOVED_SETTINGS_ID,
      owner: 'training-modal',
      level: 'addon-state',
      seq: 2,
      dependsOn: [ENTRIES_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Delete the Modal account keys that moved into training-account records',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedSettings,
  },
]
