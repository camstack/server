import type { AddonMigration } from '@camstack/types'
import { type IngressSettingsPorts, planIngressSettingsPerNode } from './settings-per-node.js'

export type { IngressSettingsPorts } from './settings-per-node.js'

/** The `tailscale-ingress` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<IngressSettingsPorts>[] = [
  {
    meta: {
      id: 'tailscale-ingress/2026-11-03-settings-per-node',
      owner: 'tailscale-ingress',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy each bare ingress setting to its hub node row; the bare rows stay for a release',
      fixtureMark: 'the target path the migration does not know',
    },
    plan: planIngressSettingsPerNode,
  },
]
