import type { AddonMigration } from '@camstack/types'
import {
  type MqttBrokerMigrationPorts,
  planDropBrokersKey,
  verifyBrokersAreRecords,
} from './brokers-to-records.js'

export type {
  MqttBrokerMigrationLog,
  MqttBrokerMigrationPorts,
  MqttBrokerRecordState,
} from './brokers-to-records.js'

export const BROKERS_TO_RECORDS_ID = 'mqtt-broker/2026-11-03-brokers-settings-to-records'
export const DROP_BROKERS_KEY_ID = 'mqtt-broker/2026-11-03-drop-brokers-key'

const FIXTURE_MARK = 'a setting key the migration does not know'

/**
 * The `mqtt-broker` catalogue (D987), offered to the engine when the addon initialises. Both
 * entries are `tolerate`: the embedded broker and every record keep working while a legacy key
 * stays where it is.
 */
export const ADDON_MIGRATIONS: readonly AddonMigration<MqttBrokerMigrationPorts>[] = [
  {
    meta: {
      id: BROKERS_TO_RECORDS_ID,
      owner: 'mqtt-broker',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Check that every external broker of the old settings list is a brokers record; never deletes',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: verifyBrokersAreRecords,
  },
  {
    meta: {
      id: DROP_BROKERS_KEY_ID,
      owner: 'mqtt-broker',
      level: 'addon-state',
      seq: 2,
      dependsOn: [BROKERS_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the legacy brokers settings key once every broker is a record',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropBrokersKey,
  },
]
