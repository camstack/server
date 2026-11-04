/**
 * The Alexa broker records keep their account flat (planning#408 P3): the nested `connection`
 * object (`amazonDomain`, `cookie`, `refreshToken`, `macDms`, `pollIntervalMs`) becomes top-level
 * fields under the SAME record id (`alexa_NNN`). `macDms`, which used to be stored in plain text,
 * becomes a keychain secret. The work is `flattenNestedRecords`: every secret is read before
 * anything is written, read back from its new ref before the nested object goes, and the old refs
 * are deleted last.
 */
import {
  flattenNestedRecords,
  type FlattenRowPorts,
  type MigrationProcedureResult,
} from '@camstack/types'

export const FLATTEN_BROKER_RECORDS_ID = 'import-alexa/2026-11-04-flatten-broker-records'

export async function flattenBrokerRecords(
  ports: FlattenRowPorts,
): Promise<MigrationProcedureResult> {
  return flattenNestedRecords(ports, {
    legacyKey: 'connection',
    flatSecretKeys: ['cookie', 'refreshToken', 'macDms'],
    toFlat: (legacy) =>
      Object.fromEntries(
        ['amazonDomain', 'cookie', 'refreshToken', 'macDms', 'pollIntervalMs']
          .filter((key) => legacy[key] !== undefined)
          .map((key): [string, unknown] => [key, legacy[key]]),
      ),
  })
}
