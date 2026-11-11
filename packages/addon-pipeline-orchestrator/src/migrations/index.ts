import type { AddonMigration, MigrationPlan } from '@camstack/types'
import { type BlobToRowsPorts, planBlobToDeviceRows, planBlobToNodeRows } from './blob-to-rows.js'
import { type DropKeysPorts, planDropKeys } from './drop-keys.js'

export const PIPELINE_ORCHESTRATOR_ID = 'pipeline-orchestrator'
export const DROP_BINDINGS_MIGRATION_FLAG_ID =
  'pipeline-orchestrator/2026-11-03-drop-bindings-migration-flag'
export const NODE_BINDINGS_TO_NODE_ROWS_ID =
  'pipeline-orchestrator/2026-11-03-node-bindings-to-node-rows'
export const AGENT_SETTINGS_TO_NODE_ROWS_ID =
  'pipeline-orchestrator/2026-11-03-agent-settings-to-node-rows'
export const CAMERA_SETTINGS_TO_DEVICE_ROWS_ID =
  'pipeline-orchestrator/2026-11-03-camera-settings-to-device-rows'
export const DROP_MOVED_MAPS_ID = 'pipeline-orchestrator/2026-11-11-drop-moved-maps'

/** The three id-keyed maps the movers copied into rows; nothing reads them. */
export const NODE_BINDINGS_FIELD = 'nodeBindings'
export const AGENT_SETTINGS_FIELD = 'agentSettings'
export const CAMERA_SETTINGS_FIELD = 'cameraSettings'

/** The one-shot flag of the retired legacy-flags-to-bindings carry-over; the D987 ledger replaces it. */
export const RETIRED_FLAG_KEYS: readonly string[] = ['bindingsMigration_v1_done']

/**
 * The flag is `true` once the carry-over ran, and the carry-over is deleted with it: a flag that
 * is stored but not `true` means an install that never ran it, whose legacy flags would be lost.
 * That refuses (the migration fails, the row stays, the next boot retries); an absent flag has
 * nothing to delete.
 */
async function planDropFlag(ports: DropKeysPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored(RETIRED_FLAG_KEYS)
  for (const key of RETIRED_FLAG_KEYS) {
    if (key in stored && stored[key] !== true) {
      throw new Error(
        `${key} is ${JSON.stringify(stored[key])}, not true: the legacy-flags carry-over has not run on this install, so the flag is kept`,
      )
    }
  }
  return planDropKeys(PIPELINE_ORCHESTRATOR_ID, RETIRED_FLAG_KEYS, ports)
}

/** The `pipeline-orchestrator` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<BlobToRowsPorts>[] = [
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
    plan: planDropFlag,
  },
  {
    meta: {
      id: NODE_BINDINGS_TO_NODE_ROWS_ID,
      owner: PIPELINE_ORCHESTRATOR_ID,
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      // The readers read the rows: an owner that could not move the map must not serve.
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Explode the node-keyed nodeBindings map into one node row per node',
      fixtureMark: 'a capability binding of one node, and a node that only this map holds',
    },
    plan: (ports) => planBlobToNodeRows(PIPELINE_ORCHESTRATOR_ID, NODE_BINDINGS_FIELD, ports),
  },
  {
    meta: {
      id: AGENT_SETTINGS_TO_NODE_ROWS_ID,
      owner: PIPELINE_ORCHESTRATOR_ID,
      level: 'addon-state',
      seq: 3,
      dependsOn: [NODE_BINDINGS_TO_NODE_ROWS_ID],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Explode the node-keyed agentSettings map into one node row per node',
      fixtureMark: 'a detection weight and a pinned model of one node',
    },
    plan: (ports) => planBlobToNodeRows(PIPELINE_ORCHESTRATOR_ID, AGENT_SETTINGS_FIELD, ports),
  },
  {
    meta: {
      id: CAMERA_SETTINGS_TO_DEVICE_ROWS_ID,
      owner: PIPELINE_ORCHESTRATOR_ID,
      level: 'addon-state',
      seq: 4,
      dependsOn: [AGENT_SETTINGS_TO_NODE_ROWS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Explode the device-keyed cameraSettings map into one device row per camera',
      fixtureMark: 'a step toggle and a step setting of one camera',
    },
    plan: (ports) => planBlobToDeviceRows(PIPELINE_ORCHESTRATOR_ID, CAMERA_SETTINGS_FIELD, ports),
  },
  {
    // The maps go here and not through `retired-settings-keys.ts`: that purge runs when the
    // settings engine boots, BEFORE this catalogue, so an install that jumps over the release
    // of the movers (or a restored older backup) would lose the maps before they were copied.
    // A ledgered step after the three movers deletes a map only once its copy is applied.
    meta: {
      id: DROP_MOVED_MAPS_ID,
      owner: PIPELINE_ORCHESTRATOR_ID,
      level: 'addon-state',
      seq: 5,
      dependsOn: [
        NODE_BINDINGS_TO_NODE_ROWS_ID,
        AGENT_SETTINGS_TO_NODE_ROWS_ID,
        CAMERA_SETTINGS_TO_DEVICE_ROWS_ID,
      ],
      store: 'settings',
      scope: 'cluster',
      // Nothing reads the maps: a failed delete leaves dead rows, it must not stop the owner.
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the nodeBindings, agentSettings and cameraSettings maps once their rows are written',
      fixtureMark: 'a marked field of each map, read back from the row its mover wrote',
    },
    plan: (ports) =>
      planDropKeys(
        PIPELINE_ORCHESTRATOR_ID,
        [NODE_BINDINGS_FIELD, AGENT_SETTINGS_FIELD, CAMERA_SETTINGS_FIELD],
        ports,
      ),
  },
]
