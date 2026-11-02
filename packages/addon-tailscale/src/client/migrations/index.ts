import type { AddonMigration } from '@camstack/types'
import { type ClientSettingsPorts, planClientSettingsPerNode } from './settings-per-node.js'

export type { ClientSettingsPorts } from './settings-per-node.js'

/** The `tailscale-client` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<ClientSettingsPorts>[] = [
  {
    meta: {
      id: 'tailscale-client/2026-11-03-settings-per-node',
      owner: 'tailscale-client',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy each bare client setting to its hub node row; the bare rows stay for a release',
      fixtureMark: 'the auth key marker the migration does not know',
    },
    plan: planClientSettingsPerNode,
  },
]
