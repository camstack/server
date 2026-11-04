import type { AddonMigration } from '@camstack/types'

export const STORAGE_ORCHESTRATOR_ID = 'storage-orchestrator'
export const RESEED_PRUNED_DEFAULTS_ID = 'storage-orchestrator/2026-11-04-reseed-pruned-defaults'

/** What the repair may do: ask the service to re-create the defaults a prune removed. */
export interface ReseedPorts {
  /** Re-seed every declared type whose seed marker survived the loss of all its rows; returns the types restored. */
  reseed(): readonly string[]
}

/** The `storage-orchestrator` catalogue (D987): offered to the engine once the seed state is known. */
export const ADDON_MIGRATIONS: readonly AddonMigration<ReseedPorts>[] = [
  {
    meta: {
      id: RESEED_PRUNED_DEFAULTS_ID,
      owner: STORAGE_ORCHESTRATOR_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // `block-owner` would stop the storage orchestrator, and with it the settings store, from
      // booting over a repair of a default location. A repair that did not run leaves the
      // alert on the Alerts panel; the operator loses nothing the bug had not already taken.
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Re-create the default storage location of a declared type whose seed marker survived the 2026-11-01 prune with no rows left',
      fixtureMark:
        'a type that still has its row and its seed marker, which the repair must not touch',
    },
    procedure: async (ports) => {
      const types = ports.reseed()
      return {
        outcome: types.length > 0 ? 'done' : 'already-done',
        summary: { types: [...types] },
      }
    },
  },
]
