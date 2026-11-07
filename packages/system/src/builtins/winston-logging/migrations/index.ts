import type { AddonMigration } from '@camstack/types'
import { type NodeFieldsPorts, planNodeFields } from './node-fields.js'

export const WINSTON_LOGGING_ID = 'winston-logging'
export const SETTINGS_PER_NODE_ID = 'winston-logging/2026-11-07-settings-per-node'

/** The two fields of the form: how much THIS node's files hold and for how long. */
export const WINSTON_NODE_KEYS: readonly string[] = ['level', 'retentionDays']

/** The `winston-logging` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<NodeFieldsPorts>[] = [
  {
    meta: {
      id: SETTINGS_PER_NODE_ID,
      owner: WINSTON_LOGGING_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy the log level and the retention to a node row for every node; the bare rows stay for a release',
      fixtureMark: 'a setting key the migration does not know',
    },
    plan: (ports) => planNodeFields(WINSTON_LOGGING_ID, WINSTON_NODE_KEYS, ports),
  },
]
