import type { AddonMigration, FlattenRowPorts } from '@camstack/types'
import {
  INTEGRATION_ROWS_TO_RECORD_ID,
  moveAlexaIntegrationRows,
  type AlexaIntegrationRowsPorts,
} from './integration-rows-to-record.js'
import { FLATTEN_BROKER_RECORDS_ID, flattenBrokerRecords } from './flatten-broker-records.js'
import {
  stripEchoTargetVolumeAndMode,
  type EchoTargetMigrationPorts,
} from './strip-echo-target-volume-and-mode.js'

export type { EchoTargetMigrationPorts } from './strip-echo-target-volume-and-mode.js'
export { FLATTEN_BROKER_RECORDS_ID } from './flatten-broker-records.js'
export {
  INTEGRATION_ROWS_TO_RECORD_ID,
  alexaIntegrationRowsPorts,
} from './integration-rows-to-record.js'

/** What the catalogue's migrations read and write through. */
export type AlexaMigrationPorts = EchoTargetMigrationPorts &
  FlattenRowPorts &
  AlexaIntegrationRowsPorts

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
]
