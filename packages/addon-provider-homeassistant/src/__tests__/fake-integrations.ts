/** An in-memory `integrations` api: the slice `haInstanceSettingsPortsOver` calls. */
import {
  HA_PROVIDER_ADDON_ID,
  type HaIntegrationsApi,
} from '../migrations/legacy-integration-rows.js'

export interface FakeIntegrations {
  readonly api: HaIntegrationsApi
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
      getSettings: { query: async ({ id }) => ({ ...store.get(id) }) },
      setSettings: {
        mutate: async ({ id, settings }) => {
          if (!store.has(id)) return { success: false }
          store.set(id, { ...settings })
          writes += 1
          return { success: true }
        },
      },
    },
    settingsOf: (id) => store.get(id),
    remove: (id) => void store.delete(id),
    writes: () => writes,
  }
}
