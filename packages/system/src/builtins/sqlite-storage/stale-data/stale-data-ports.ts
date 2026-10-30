/**
 * The production wiring of the stale-data audit's ports: the addon list and the
 * owning addon's own answers through `ctx.api` (never a hub-side copy of what an
 * addon declares), the record catalog through the engine, the stored settings
 * through the backend this addon owns.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import type { RecordsProvider } from '../records/records-provider.js'
import type { SqliteSettingsBackend } from '../sqlite-settings-backend.js'
import type { StaleDataPorts } from './stale-data-audit.js'

export interface StaleDataPortDeps {
  readonly api: AddonApi
  readonly backend: Pick<SqliteSettingsBackend, 'getAllAddon'>
  readonly records: Pick<RecordsProvider, 'listKinds' | 'markKindsOrphaned' | 'dropKind'>
  readonly logger: IScopedLogger
}

export function createStaleDataPorts(deps: StaleDataPortDeps): StaleDataPorts {
  const { api, backend, records, logger } = deps
  return {
    listAddons: async () => {
      try {
        const items = await api.addons.list.query({})
        return items.map((item) => ({
          id: item.manifest.id,
          running: item.process?.state === 'running',
        }))
      } catch (err) {
        logger.warn('stale-data: the addon list could not be read', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
    },
    listKinds: async () => (await records.listKinds({})).kinds,
    markOrphaned: (kinds) => records.markKindsOrphaned(kinds),
    dropKind: (ref) => records.dropKind(ref),
    storedSettings: async (addonId) => backend.getAllAddon(addonId),
    declaredKeys: async (addonId) => {
      try {
        const answer = await api.addonSettings.getDeclaredSettingsKeys.query({ addonId })
        return answer === null ? null : answer.keys
      } catch {
        // An addon that cannot answer is `unknown` to the audit - never stale.
        return null
      }
    },
    unsetKeys: (addonId, keys) =>
      api.addonSettings.unsetStoredSettingsKeys.mutate({ addonId, keys: [...keys] }),
    releaseSecrets: async (refs, userId) =>
      (await api.keychain.releaseRecordRefs.mutate({ refs: [...refs], onBehalfOf: userId }))
        .released,
    logger,
    now: () => Date.now(),
  }
}
