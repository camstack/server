import type { AddonMigration } from '@camstack/types'
import {
  type NodeFieldsPorts,
  type NodeFieldTwin,
  planNodeFields,
} from '../../node-fields-per-node.js'

export const PIPELINE_RUNNER_ID = 'pipeline-runner'
export const NODE_FIELDS_ID = 'pipeline-runner/2026-11-03-unmarked-node-fields-per-node'

/** Fields stored once for the cluster that are facts of one node's runner. */
export const RUNNER_NODE_KEYS: readonly string[] = [
  'maxConcurrentInferences',
  'maxQueueDepth',
  'targetLoadPercent',
  'minThrottledFps',
  'maxConcurrentDecodeSpawns',
]

/**
 * Two keys carried each decode limit. The survivors are the keys the node limits source reads
 * (`decodeBudgetMb`, `maxLiveDecodeWorkers`); `nodeDecodeBudgetMb` and `decodeMaxLiveWorkers`
 * fold in only when the survivor is unset.
 */
export const RUNNER_TWINS: readonly NodeFieldTwin[] = [
  { survivor: 'decodeBudgetMb', loser: 'nodeDecodeBudgetMb' },
  { survivor: 'maxLiveDecodeWorkers', loser: 'decodeMaxLiveWorkers' },
]

/** The `pipeline-runner` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<NodeFieldsPorts>[] = [
  {
    meta: {
      id: NODE_FIELDS_ID,
      owner: PIPELINE_RUNNER_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy the runner tuning to a node row for every node, fold the decode-limit twins into the keys the code reads and park the losers as superseded',
      fixtureMark: 'a setting key the migration does not know',
    },
    plan: (ports) => planNodeFields(PIPELINE_RUNNER_ID, RUNNER_NODE_KEYS, RUNNER_TWINS, ports),
  },
]
