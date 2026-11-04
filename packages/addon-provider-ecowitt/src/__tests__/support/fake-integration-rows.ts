/**
 * An in-memory stand-in for the two stores `moveIntegrationRowsToRecords` crosses: the legacy
 * `integration_settings` rows (secrets in a per-integration keychain) and the addon's records
 * (secret leaves in a per-record keychain). The secrets are really moved: a record read gives a
 * secret back only if THAT record's keychain entry holds it, so a body copied from another
 * integration's rows cannot pass the read-back.
 */
import type { IntegrationRowsPorts, RowsIntegration } from '@camstack/types'

export interface FakeIntegration extends RowsIntegration {
  readonly addonId: string
  /** The legacy rows with every secret already resolved. */
  readonly rows: Readonly<Record<string, unknown>>
  /** The row keys whose value lives in the keychain. */
  readonly secretRowKeys: readonly string[]
}

export interface FakeRowsWorld {
  readonly ports: IntegrationRowsPorts
  readonly warnings: string[]
  readonly rows: Map<string, Record<string, unknown>>
  /** `<integrationId>/<key>` of every keychain value of a legacy row still held. */
  readonly rowKeychain: Set<string>
  readonly records: Map<string, Record<string, unknown>>
  /** `<recordId>/<key>` -> secret value of the records' keychain. */
  readonly recordKeychain: Map<string, string>
}

export function fakeRowsWorld(
  integrations: readonly FakeIntegration[],
  secretKeys: readonly string[],
): FakeRowsWorld {
  const rows = new Map(integrations.map((i) => [i.id, { ...i.rows }]))
  const rowKeychain = new Set(
    integrations.flatMap((i) => i.secretRowKeys.map((key) => `${i.id}/${key}`)),
  )
  const records = new Map<string, Record<string, unknown>>()
  const recordKeychain = new Map<string, string>()
  const warnings: string[] = []
  const ports: IntegrationRowsPorts = {
    warn: (message) => warnings.push(message),
    listIntegrations: async (addonId) =>
      integrations.filter((i) => i.addonId === addonId).map((i) => ({ id: i.id, name: i.name })),
    readRows: async (id) => Object.assign({}, rows.get(id)),
    putRecord: async (id, body) => {
      if (records.has(id)) return 'exists'
      const open: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(body)) {
        if (secretKeys.includes(key) && typeof value === 'string') {
          recordKeychain.set(`${id}/${key}`, value)
        } else open[key] = value
      }
      records.set(id, open)
      return 'created'
    },
    readRecord: async (id) => {
      const open = records.get(id)
      if (open === undefined) return null
      const body: Record<string, unknown> = { ...open }
      for (const key of secretKeys) {
        const value = recordKeychain.get(`${id}/${key}`)
        if (value !== undefined) body[key] = value
      }
      return body
    },
    deleteRecord: async (id) => {
      records.delete(id)
      for (const key of secretKeys) recordKeychain.delete(`${id}/${key}`)
    },
    clearRows: async (id) => {
      rows.set(id, {})
      for (const entry of [...rowKeychain])
        if (entry.startsWith(`${id}/`)) rowKeychain.delete(entry)
    },
  }
  return { ports, warnings, rows, rowKeychain, records, recordKeychain }
}
