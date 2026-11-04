/**
 * Binds the `homeassistant-export` catalogue to the addon's stores: the settings, the hub's
 * `integrations` capability (the old home of the two flags, read by the migrations only), the
 * retired `ha-export-links` kind and the `ha-export-targets` kind the links move into.
 */
import { RevConflictError, type RecordKindHandle } from '@camstack/types'
import {
  type HaIntegrationsApi,
  haInstanceSettingsPortsOver,
} from '../../migrations/legacy-integration-rows.js'
import { type HaExportTargetBody, readAllTargets } from '../target-records.js'
import { type HaExportLinksBody, readAllLinks } from './legacy-links-kind.js'
import type { HaExportMigrationPorts } from './index.js'

export interface HaExportMigrationDeps {
  readonly readStored: () => Promise<Readonly<Record<string, unknown>>>
  /** The hub api; only its `integrations` capability is read, and only by the migrations. */
  readonly api: { readonly integrations: HaIntegrationsApi }
  /** The retired link records, declared for the migrations. */
  readonly links: RecordKindHandle<HaExportLinksBody>
  readonly targets: RecordKindHandle<HaExportTargetBody>
  /** Delete keys of the addon's settings. */
  readonly clearSettingKeys: (keys: readonly string[]) => Promise<void>
  readonly warn: (message: string) => void
}

export function haExportMigrationPorts(deps: HaExportMigrationDeps): HaExportMigrationPorts {
  return {
    readStored: deps.readStored,
    ...haInstanceSettingsPortsOver(deps.api.integrations),
    warn: deps.warn,
    putLinks: async (brokerId, body) => {
      if ((await deps.links.get(brokerId)) !== null) return 'exists'
      try {
        await deps.links.put({ id: brokerId, data: body }, { ifRev: 0 })
      } catch (err: unknown) {
        if (err instanceof RevConflictError) return 'exists'
        throw err
      }
      return 'created'
    },
    readLinks: () => readAllLinks(deps.links),
    readTargets: () => readAllTargets(deps.targets),
    putTarget: async (id, body) => {
      try {
        await deps.targets.put({ id, data: body }, { ifRev: 0 })
      } catch (err: unknown) {
        if (err instanceof RevConflictError) return 'exists'
        throw err
      }
      return 'created'
    },
    deleteLinks: async (brokerIds) => {
      await deps.links.deleteMany(brokerIds)
    },
    clearSettingKeys: deps.clearSettingKeys,
  }
}
