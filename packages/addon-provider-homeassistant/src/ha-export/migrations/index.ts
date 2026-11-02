import type { AddonMigration } from '@camstack/types'
import { type DropPublicBaseUrlPorts, planDropPublicBaseUrl } from './drop-public-base-url.js'

export type { DropPublicBaseUrlPorts } from './drop-public-base-url.js'

/** The `homeassistant-export` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<DropPublicBaseUrlPorts>[] = [
  {
    meta: {
      id: 'homeassistant-export/2026-11-02-drop-public-base-url',
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired publicBaseUrl setting; each instance now chooses a hub address role',
      fixtureMark: 'the reconcile interval the migration does not know',
    },
    plan: planDropPublicBaseUrl,
  },
]
