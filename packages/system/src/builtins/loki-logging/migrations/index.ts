import type { AddonMigration } from '@camstack/types'
import {
  type DropMovedSettingsPorts,
  type LokiMigrationPorts,
  moveConnectionToRecord,
  planDropMovedSettings,
} from './connection-to-records.js'
import { planDropRetiredEnabledFlag, type RetiredEnabledFlagPorts } from './retired-enabled-flag.js'
import {
  moveRegistryToggleToRecord,
  type RegistryToggleMigrationPorts,
} from './registry-toggle-to-record.js'

export {
  RETIRED_ENABLED_KEY,
  RETIREMENT_MARKER_KEY,
  type RetiredEnabledFlagPorts,
} from './retired-enabled-flag.js'
export type { RegistryState, RegistryToggleMigrationPorts } from './registry-toggle-to-record.js'
export type {
  DropMovedSettingsPorts,
  LokiMigrationLog,
  LokiMigrationPorts,
  LokiRecordState,
} from './connection-to-records.js'

/** Both bodies read through ONE port object, so the addon binds the catalogue once. */
export type LokiCataloguePorts = LokiMigrationPorts &
  DropMovedSettingsPorts &
  RegistryToggleMigrationPorts &
  RetiredEnabledFlagPorts

export const CONNECTION_TO_RECORDS_ID = 'loki-logging/2026-11-02-connection-to-records'
export const REGISTRY_TOGGLE_TO_RECORD_ID = 'loki-logging/2026-11-02-registry-toggle-to-record'
export const DROP_RETIRED_ENABLED_ID = 'loki-logging/2026-11-07-drop-retired-enabled-flag'

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
  {
    meta: {
      id: REGISTRY_TOGGLE_TO_RECORD_ID,
      owner: 'loki-logging',
      level: 'addon-state',
      seq: 3,
      dependsOn: [CONNECTION_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      // The provider is registered only after the addon initialises: a first pass can fail on
      // that, and the addon runs the catalogue again once it is registered.
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Carry a Loki provider switched off at the log-destination registry toggle to a destinations record that is off, and turn the registry toggle back on',
      fixtureMark: 'a destinations record field the migration does not know (the job)',
    },
    procedure: moveRegistryToggleToRecord,
  },
  {
    meta: {
      id: DROP_RETIRED_ENABLED_ID,
      owner: 'loki-logging',
      level: 'addon-state',
      seq: 4,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // The key describes nothing in effect, so a pass that cannot run only leaves it for the next boot.
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired `enabled` setting (it gates nothing any more) and the marker its boot-time carry-over left',
      fixtureMark: 'a setting key the migration does not know',
    },
    plan: planDropRetiredEnabledFlag,
  },
]

/**
 * What can be decided while the addon initialises. The registry-toggle migration reads the hub's
 * registry, which holds this provider only AFTER registration, so it is run from `postBrokerStart`
 * (the full {@link ADDON_MIGRATIONS}) and never offered here: a pass that cannot decide is a
 * guaranteed failure and a critical alert for nothing.
 */
export const INITIALIZE_MIGRATIONS: readonly AddonMigration<LokiCataloguePorts>[] =
  ADDON_MIGRATIONS.filter((m) => m.meta.id !== REGISTRY_TOGGLE_TO_RECORD_ID)
