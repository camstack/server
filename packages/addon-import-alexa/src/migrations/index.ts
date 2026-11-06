import {
  type AddonMigration,
  type BrokerLinkPorts,
  type FlattenRowPorts,
  moveBrokerLinksToConnections,
} from '@camstack/types'
import {
  INTEGRATION_ROWS_TO_RECORD_ID,
  moveAlexaIntegrationRows,
  type AlexaIntegrationRowsPorts,
} from './integration-rows-to-record.js'
import { FLATTEN_BROKER_RECORDS_ID, flattenBrokerRecords } from './flatten-broker-records.js'
import {
  alexaBrokerLinkPorts,
  BROKER_LINKS_TO_CONNECTIONS_ID,
} from './broker-links-to-connections.js'
import {
  stripEchoTargetVolumeAndMode,
  type EchoTargetMigrationPorts,
} from './strip-echo-target-volume-and-mode.js'

import {
  ECHO_TARGETS_TO_RECORDS_ID,
  type EchoRecordPorts,
  moveEchoTargetsToRecords,
} from './echo-targets-to-records.js'

export { ECHO_TARGETS_TO_RECORDS_ID } from './echo-targets-to-records.js'
export type { EchoRecordPorts } from './echo-targets-to-records.js'
export type { EchoTargetMigrationPorts } from './strip-echo-target-volume-and-mode.js'
export { FLATTEN_BROKER_RECORDS_ID } from './flatten-broker-records.js'
export { alexaBrokerLinkPorts, BROKER_LINKS_TO_CONNECTIONS_ID }
export {
  INTEGRATION_ROWS_TO_RECORD_ID,
  alexaIntegrationRowsPorts,
} from './integration-rows-to-record.js'

/** What the catalogue's migrations read and write through. */
export type AlexaMigrationPorts = EchoTargetMigrationPorts &
  FlattenRowPorts &
  AlexaIntegrationRowsPorts &
  BrokerLinkPorts &
  EchoRecordPorts

/** The `import-alexa` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<AlexaMigrationPorts>[] = [
  {
    meta: {
      id: 'import-alexa/2026-11-01-strip-echo-target-volume-and-mode',
      owner: 'import-alexa',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description: 'Remove the retired volume and mode from every stored Echo target',
      fixtureMark: 'the Echo id and the name the migration does not know',
    },
    procedure: stripEchoTargetVolumeAndMode,
  },
  {
    meta: {
      id: FLATTEN_BROKER_RECORDS_ID,
      owner: 'import-alexa',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move each Alexa account from a nested connection object to flat top-level fields under the same id, reading every secret back first',
      fixtureMark: 'the integration link and the amazon domain of each account',
    },
    procedure: flattenBrokerRecords,
  },
  {
    meta: {
      id: INTEGRATION_ROWS_TO_RECORD_ID,
      owner: 'import-alexa',
      level: 'addon-state',
      seq: 3,
      dependsOn: [FLATTEN_BROKER_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Stamp the integration link from the legacy brokerId row onto its broker record when the broker has none, then clear the legacy integration settings rows',
      fixtureMark: 'the name of the broker and the integration it already names',
    },
    procedure: moveAlexaIntegrationRows,
  },
  {
    meta: {
      id: BROKER_LINKS_TO_CONNECTIONS_ID,
      owner: 'import-alexa',
      level: 'addon-state',
      seq: 4,
      dependsOn: [INTEGRATION_ROWS_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Write each integration a connections record naming its Alexa account (keyed by the integration id), then clear the integration link on the account; stray registry-keyed account rows are counted and logged, never deleted',
      fixtureMark: 'the name and the extra field of the account that keeps its record',
    },
    procedure: moveBrokerLinksToConnections,
  },
  {
    meta: {
      id: ECHO_TARGETS_TO_RECORDS_ID,
      owner: 'import-alexa',
      level: 'addon-state',
      seq: 5,
      dependsOn: ['import-alexa/2026-11-01-strip-echo-target-volume-and-mode'],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move each Echo target from the echoTargets setting to a notify-alexa-echo record under the same id, the switch carried, read back before its row leaves the setting; a row that fails stays in the setting and is still served; a record that exists is never overwritten',
      fixtureMark: 'the switch (off) and the id of an Echo target',
    },
    procedure: moveEchoTargetsToRecords,
  },
]

/** The migrations that rewrite the broker records: they run BEFORE anything reads or persists one. */
export const BROKER_RECORD_MIGRATION_IDS: readonly string[] = [
  FLATTEN_BROKER_RECORDS_ID,
  INTEGRATION_ROWS_TO_RECORD_ID,
  BROKER_LINKS_TO_CONNECTIONS_ID,
]
