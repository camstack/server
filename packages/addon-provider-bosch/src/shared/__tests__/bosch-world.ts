import {
  type AddonMigration,
  defineAddonMigrations,
  type IntegrationRowsApi,
  type IntegrationRowsPorts,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  type RecordsAccess,
} from '@camstack/types'

interface WorldSpec {
  readonly addonId: string
  readonly declare: (records: RecordsAccess) => Promise<unknown>
  readonly migrations: readonly AddonMigration<IntegrationRowsPorts>[]
  readonly ports: (deps: {
    readonly api: IntegrationRowsApi
    readonly records: RecordsAccess
    readonly warn: (message: string) => void
  }) => IntegrationRowsPorts
  readonly integration: { readonly id: string; readonly addonId: string; readonly name: string }
  readonly rows: Readonly<Record<string, unknown>>
}

/** A hub holding one integration's legacy rows and an in-memory records world for the addon. */
export async function boschWorld(spec: WorldSpec) {
  const rows = new Map<string, Record<string, unknown>>([[spec.integration.id, { ...spec.rows }]])
  const warnings: string[] = []
  const mem = makeInMemoryRecords(spec.addonId)
  await spec.declare(mem.records)
  const api: IntegrationRowsApi = {
    list: async () => [spec.integration],
    getSettings: async ({ id }) => ({ ...rows.get(id) }),
    clearSettings: async ({ id }) => {
      rows.set(id, {})
    },
  }
  const ports = spec.ports({ api, records: mem.records, warn: (m) => warnings.push(m) })
  const run = async (): Promise<readonly MigrationOwnerResult[]> =>
    Promise.all(defineAddonMigrations(spec.migrations, ports).map((m) => m.execute()))
  return { rows, warnings, mem, run }
}
