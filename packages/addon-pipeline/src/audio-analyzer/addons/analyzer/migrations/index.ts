import type { AddonMigration } from '@camstack/types'
import { type NodeFieldsPorts, planNodeFields } from '../../../../node-fields-per-node.js'

export const AUDIO_ANALYZER_ID = 'audio-analyzer'
export const NODE_FIELDS_ID = 'audio-analyzer/2026-11-03-unmarked-node-fields-per-node'

/** Fields stored once for the cluster that are facts of one node's analyzer. */
export const ANALYZER_NODE_KEYS: readonly string[] = ['audioBackend']

/** The `audio-analyzer` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<NodeFieldsPorts>[] = [
  {
    meta: {
      id: NODE_FIELDS_ID,
      owner: AUDIO_ANALYZER_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Copy the audio backend choice to a node row for every node',
      fixtureMark: 'a setting key the migration does not know',
    },
    plan: (ports) => planNodeFields(AUDIO_ANALYZER_ID, ANALYZER_NODE_KEYS, [], ports),
  },
]
