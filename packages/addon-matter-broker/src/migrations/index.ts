import type { AddonMigration, FlattenRowPorts } from '@camstack/types'
import { FLATTEN_BROKER_RECORDS_ID, flattenBrokerRecords } from './flatten-broker-records.js'

export { FLATTEN_BROKER_RECORDS_ID } from './flatten-broker-records.js'

/** The `matter-broker` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<FlattenRowPorts>[] = [
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
]
