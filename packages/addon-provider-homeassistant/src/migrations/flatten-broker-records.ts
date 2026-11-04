/**
 * The Home Assistant broker records keep their connection flat (planning#408 P3): the nested
 * `auth` object (`{ kind, baseUrl, accessToken }` or `{ kind, supervisorToken }`) becomes the top
 * level `authKind`, `baseUrl`, `accessToken` and `supervisorToken`, under the SAME record id, so
 * the devices that carry `ha_NNN` keep their broker. The work is `flattenNestedRecords`: every
 * secret is read before anything is written, read back from its new keychain ref before the
 * nested object goes, and the old refs are deleted last.
 */
import {
  flattenNestedRecords,
  type FlattenRowPorts,
  type MigrationProcedureResult,
} from '@camstack/types'

export const FLATTEN_BROKER_RECORDS_ID = 'provider-homeassistant/2026-11-04-flatten-broker-records'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function flattenBrokerRecords(
  ports: FlattenRowPorts,
): Promise<MigrationProcedureResult> {
  return flattenNestedRecords(ports, {
    legacyKey: 'auth',
    flatSecretKeys: ['accessToken', 'supervisorToken'],
    toFlat: (legacy) => {
      const kind = legacy['kind'] === 'supervisor' ? 'supervisor' : 'long-lived'
      const baseUrl = text(legacy['baseUrl'])
      const accessToken = text(legacy['accessToken'])
      const supervisorToken = text(legacy['supervisorToken'])
      return {
        authKind: kind,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(accessToken !== undefined ? { accessToken } : {}),
        ...(supervisorToken !== undefined ? { supervisorToken } : {}),
      }
    },
  })
}
