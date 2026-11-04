/**
 * The Matter broker records keep their fabric settings flat (planning#408 P3): the nested
 * `connection` object (`threadDataset`, `wifiSsid`, `wifiPassword`, `reconcileIntervalMs`) becomes
 * top-level fields under the SAME record id (`matter_NNN`), so the devices that carry the id keep
 * their fabric. The work is `flattenNestedRecords`: every secret is read before anything is
 * written, read back from its new ref before the nested object goes, and the old refs are
 * deleted last.
 */
import {
  flattenNestedRecords,
  type FlattenRowPorts,
  type MigrationProcedureResult,
} from '@camstack/types'

export const FLATTEN_BROKER_RECORDS_ID = 'matter-broker/2026-11-04-flatten-broker-records'

export async function flattenBrokerRecords(
  ports: FlattenRowPorts,
): Promise<MigrationProcedureResult> {
  return flattenNestedRecords(ports, {
    legacyKey: 'connection',
    flatSecretKeys: ['threadDataset', 'wifiPassword'],
    toFlat: (legacy) =>
      Object.fromEntries(
        ['threadDataset', 'wifiSsid', 'wifiPassword', 'reconcileIntervalMs']
          .filter((key) => legacy[key] !== undefined)
          .map((key): [string, unknown] => [key, legacy[key]]),
      ),
  })
}
