/**
 * The ports of `location-secrets-to-record`, bound over the locations record kind and the
 * addon's own keychain handle. Kept apart from the addon so the real-SQLite spec drives the
 * very same code the boot runs.
 */
import type { RecordKindHandle, SecretsAccess, SecretMarker } from '@camstack/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import { isLegacyLocationMarker } from './legacy-location-secret-refs.js'
import type { StorageLocationBody } from '../record-kinds.js'
import type {
  LegacyLocationRow,
  LegacySecretRead,
  LocationSecretPorts,
} from './location-secrets-to-record.js'

export interface LocationSecretPortsDeps {
  readonly locations: RecordKindHandle<StorageLocationBody>
  readonly secrets: SecretsAccess
  /** The running service re-reads the markers its locations carry. */
  readonly refreshLocations: () => Promise<unknown>
}

export function locationSecretPortsOver(deps: LocationSecretPortsDeps): LocationSecretPorts {
  const { locations, secrets } = deps
  return {
    async readLegacy(): Promise<readonly LegacyLocationRow[]> {
      const rows = await readAllRows(locations)
      return rows.map((row) => {
        const legacy: Record<string, SecretMarker> = {}
        for (const [key, value] of Object.entries(row.data.config)) {
          if (isLegacyLocationMarker(row.id, value)) legacy[key] = value
        }
        return { id: row.id, legacy, recorded: Object.keys(row.data.secrets ?? {}) }
      })
    },
    async resolveLegacy(refs): Promise<ReadonlyMap<string, LegacySecretRead>> {
      const answer = await secrets.resolve(refs)
      const out = new Map<string, LegacySecretRead>()
      for (const ref of refs) {
        const entry = answer[ref]
        if (entry?.kind === 'value') out.set(ref, { kind: 'value', value: entry.value })
        else
          out.set(ref, {
            kind: entry?.kind === 'missing' ? 'missing' : 'unavailable',
          })
      }
      return out
    },
    async moveToRecord(id, moved): Promise<void> {
      const removed: Record<string, null> = {}
      for (const key of Object.keys(moved)) removed[key] = null
      await locations.patch(id, { secrets: moved, config: removed })
    },
    async readMoved(id) {
      const row = await locations.getResolved(id)
      if (row === null) return null
      return {
        secrets: row.data.secrets ?? {},
        configKeys: Object.keys(row.data.config),
      }
    },
    async releaseLegacy(refs): Promise<void> {
      await secrets.delete(refs)
    },
    async refreshLocations(): Promise<void> {
      await deps.refreshLocations()
    },
  }
}
