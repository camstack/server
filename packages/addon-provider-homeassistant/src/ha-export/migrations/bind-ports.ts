/**
 * Binds the `homeassistant-export` catalogue to the addon's stores: the settings, the hub's
 * `integrations` capability (the old home of the two flags, read by the migrations only) and the
 * `ha-export-links` kind.
 */
import { RevConflictError, type RecordKindHandle } from '@camstack/types'
import { type HaIntegrationsApi, haInstanceSettingsPortsOver } from '../../ha-instance-settings.js'
import { type HaExportLinksBody, readAllLinks } from '../link-records.js'
import type { HaExportMigrationPorts } from './index.js'

export interface HaExportMigrationDeps {
  readonly readStored: () => Promise<Readonly<Record<string, unknown>>>
  /** The hub api; only its `integrations` capability is read, and only by the migrations. */
  readonly api: { readonly integrations: HaIntegrationsApi }
  readonly links: RecordKindHandle<HaExportLinksBody>
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
  }
}
