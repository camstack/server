import type { AddonMigration } from '@camstack/types'
import { type DropKeysPorts, planDropKeys } from './drop-keys.js'

export const PIPELINE_ORCHESTRATOR_ID = 'pipeline-orchestrator'
export const DROP_BINDINGS_MIGRATION_FLAG_ID =
  'pipeline-orchestrator/2026-11-03-drop-bindings-migration-flag'

/** The one-shot flag of the retired legacy-flags-to-bindings carry-over; the D987 ledger replaces it. */
export const RETIRED_FLAG_KEYS: readonly string[] = ['bindingsMigration_v1_done']

/** The `pipeline-orchestrator` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<DropKeysPorts>[] = [
  {
    meta: {
      id: DROP_BINDINGS_MIGRATION_FLAG_ID,
      owner: PIPELINE_ORCHESTRATOR_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the one-shot flag of the retired legacy-flags-to-bindings carry-over',
      fixtureMark: 'a setting the migration does not know',
    },
    plan: (ports) => planDropKeys(PIPELINE_ORCHESTRATOR_ID, RETIRED_FLAG_KEYS, ports),
  },
]
