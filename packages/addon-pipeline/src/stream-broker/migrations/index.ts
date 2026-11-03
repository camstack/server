import type { AddonMigration } from '@camstack/types'
import { type NodeFieldsPorts, planNodeFields } from '../../node-fields-per-node.js'

export const STREAM_BROKER_ID = 'stream-broker'
export const NODE_FIELDS_ID = 'stream-broker/2026-11-03-unmarked-node-fields-per-node'

/** Fields stored once for the cluster that are facts of one node's broker. */
export const BROKER_NODE_KEYS: readonly string[] = ['rtspPort']

/** The `stream-broker` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<NodeFieldsPorts>[] = [
  {
    meta: {
      id: NODE_FIELDS_ID,
      owner: STREAM_BROKER_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Copy the RTSP restream port to a node row for every node',
      fixtureMark: 'a setting key the migration does not know',
    },
    plan: (ports) => planNodeFields(STREAM_BROKER_ID, BROKER_NODE_KEYS, [], ports),
  },
]
