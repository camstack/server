import type { AddonMigration } from '@camstack/types'
import { planDropBrokersKey, verifyBrokersAreRecords } from './brokers-to-records.js'
import {
  type ClientAclMigrationPorts,
  clientsAclToRecords,
  planDropClientsAclKeys,
} from './clients-acl-to-records.js'
import { embeddedToOnboardRecord, planDropEmbeddedKeys } from './embedded-to-onboard.js'

export type {
  MqttBrokerMigrationLog,
  MqttBrokerMigrationPorts,
  MqttBrokerRecordState,
} from './brokers-to-records.js'

export const BROKERS_TO_RECORDS_ID = 'mqtt-broker/2026-11-03-brokers-settings-to-records'
export const DROP_BROKERS_KEY_ID = 'mqtt-broker/2026-11-03-drop-brokers-key'
export const EMBEDDED_TO_ONBOARD_ID = 'mqtt-broker/2026-11-05-embedded-broker-to-onboard-record'
export const DROP_EMBEDDED_KEYS_ID = 'mqtt-broker/2026-11-05-drop-embedded-keys'
export const CLIENTS_ACL_TO_RECORDS_ID = 'mqtt-broker/2026-11-08-clients-acl-settings-to-records'
export const DROP_CLIENTS_ACL_KEYS_ID = 'mqtt-broker/2026-11-08-drop-clients-acl-keys'

export type {
  ClientAclMigrationPorts,
  LegacyAcl,
  LegacyClient,
} from './clients-acl-to-records.js'
export type {
  EmbeddedMigrationPorts,
  LegacyEmbedded,
  OnboardRecordBody,
} from './embedded-to-onboard.js'

const FIXTURE_MARK = 'a setting key the migration does not know'

/**
 * The `mqtt-broker` catalogue (D987), offered to the engine when the addon initialises. Both
 * entries are `tolerate`: the embedded broker and every record keep working while a legacy key
 * stays where it is.
 */
export const ADDON_MIGRATIONS: readonly AddonMigration<ClientAclMigrationPorts>[] = [
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
  {
    meta: {
      id: EMBEDDED_TO_ONBOARD_ID,
      owner: 'mqtt-broker',
      level: 'addon-state',
      seq: 3,
      dependsOn: [DROP_BROKERS_KEY_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'The legacy embedded broker (flat embedded* keys) becomes an onboard brokers record under the same id; never overwrites a record',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: embeddedToOnboardRecord,
  },
  {
    meta: {
      id: DROP_EMBEDDED_KEYS_ID,
      owner: 'mqtt-broker',
      level: 'addon-state',
      seq: 4,
      dependsOn: [EMBEDDED_TO_ONBOARD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the flat embedded broker keys once the onboard record holds them',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropEmbeddedKeys,
  },
  {
    meta: {
      id: CLIENTS_ACL_TO_RECORDS_ID,
      owner: 'mqtt-broker',
      level: 'addon-state',
      seq: 5,
      dependsOn: [DROP_EMBEDDED_KEYS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'The embedded clients and ACL rules of the settings lists become records under the ids the stores always used; never overwrites a record',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: clientsAclToRecords,
  },
  {
    meta: {
      id: DROP_CLIENTS_ACL_KEYS_ID,
      owner: 'mqtt-broker',
      level: 'addon-state',
      seq: 6,
      dependsOn: [CLIENTS_ACL_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the embeddedClients and embeddedAcl keys once every entry is a record',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropClientsAclKeys,
  },
]
