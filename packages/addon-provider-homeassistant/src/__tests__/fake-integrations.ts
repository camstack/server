/** An in-memory migration door: the slice `haInstanceSettingsPortsOver` calls. */
import {
  HA_PROVIDER_ADDON_ID,
  type HaLegacyRowsApi,
} from '../migrations/legacy-integration-rows.js'

export interface FakeIntegrations {
  readonly api: HaLegacyRowsApi
  readonly settingsOf: (id: string) => Record<string, unknown> | undefined
  readonly remove: (id: string) => void
  readonly writes: () => number
}

export function fakeIntegrations(
  initial: Readonly<Record<string, Record<string, unknown>>>,
  addonId: string = HA_PROVIDER_ADDON_ID,
): FakeIntegrations {
  const store = new Map(Object.entries(initial).map(([id, s]) => [id, { ...s }]))
  let writes = 0
  return {
    api: {
      list: { query: async () => [...store.keys()].map((id) => ({ id, addonId })) },
      readLegacyIntegrationRows: {
        query: async ({ integrationId }) => ({ ...store.get(integrationId) }),
      },
      patchLegacyIntegrationRows: {
        mutate: async ({ integrationId, patch }) => {
          const current = store.get(integrationId)
          if (current === undefined) return { written: false }
          store.set(integrationId, { ...current, ...patch })
          writes += 1
          return { written: true }
        },
      },
      deleteLegacyIntegrationRowKeys: {
        mutate: async ({ integrationId, keys }) => {
          const current = store.get(integrationId)
          if (current === undefined) return { present: false, removed: {} }
          const drop = new Set(keys)
          const removed: Record<string, unknown> = {}
          const next: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(current)) {
            if (drop.has(key)) removed[key] = value
            else next[key] = value
          }
          store.set(integrationId, next)
          writes += 1
          return { present: true, removed }
        },
      },
    },
    settingsOf: (id) => store.get(id),
    remove: (id) => void store.delete(id),
    writes: () => writes,
  }
}
