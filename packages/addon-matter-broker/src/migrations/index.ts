import {
  type AddonMigration,
  type BrokerLinkPorts,
  type FlattenRowPorts,
  moveBrokerLinksToConnections,
} from '@camstack/types'
import { FLATTEN_BROKER_RECORDS_ID, flattenBrokerRecords } from './flatten-broker-records.js'
import {
  BROKER_LINKS_TO_CONNECTIONS_ID,
  matterBrokerLinkPorts,
} from './broker-links-to-connections.js'

export { FLATTEN_BROKER_RECORDS_ID } from './flatten-broker-records.js'
export { BROKER_LINKS_TO_CONNECTIONS_ID, matterBrokerLinkPorts }

export type MatterMigrationPorts = FlattenRowPorts & BrokerLinkPorts

/** The `matter-broker` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<MatterMigrationPorts>[] = [
  {
    meta: {
      id: FLATTEN_BROKER_RECORDS_ID,
      owner: 'matter-broker',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move each Matter fabric from a nested connection object to flat top-level fields under the same id, reading every secret back first',
      fixtureMark: 'the integration link and the Wi-Fi SSID of each fabric',
    },
    procedure: flattenBrokerRecords,
  },
  {
    meta: {
      id: BROKER_LINKS_TO_CONNECTIONS_ID,
      owner: 'matter-broker',
      level: 'addon-state',
      seq: 2,
      dependsOn: [FLATTEN_BROKER_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Write each integration a connections record naming its Matter fabric (keyed by the integration id), then clear the integration link on the fabric; stray registry-keyed fabric rows are counted and logged, never deleted',
      fixtureMark: 'the name and the Wi-Fi SSID of the fabric that keeps its record',
    },
    procedure: moveBrokerLinksToConnections,
  },
]
