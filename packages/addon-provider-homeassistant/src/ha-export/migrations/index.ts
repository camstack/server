import type { AddonMigration } from '@camstack/types'
import { type DropPublicBaseUrlPorts, planDropPublicBaseUrl } from './drop-public-base-url.js'
import {
  copyFlagsToIntegrations,
  type PerBrokerFlagsPorts,
  planDropPerBrokerFlags,
} from './per-broker-flags.js'

export type { DropPublicBaseUrlPorts } from './drop-public-base-url.js'
export type { PerBrokerFlagsPorts } from './per-broker-flags.js'

/** Everything the `homeassistant-export` catalogue reads and writes. */
export type HaExportMigrationPorts = DropPublicBaseUrlPorts & PerBrokerFlagsPorts

/** The `homeassistant-export` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<HaExportMigrationPorts>[] = [
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
  {
    meta: {
      id: 'homeassistant-export/2026-11-03-per-broker-flags-to-integration',
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy each exportTo:<broker> and mediaRole:<broker> key to the settings of the integration that links the broker',
      fixtureMark: 'the broker link stored beside the flags of an integration',
    },
    procedure: copyFlagsToIntegrations,
  },
  {
    meta: {
      id: 'homeassistant-export/2026-11-03-drop-per-broker-flags',
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 3,
      dependsOn: ['homeassistant-export/2026-11-03-per-broker-flags-to-integration'],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the per-broker keys once the integration shows the same flag',
      fixtureMark: 'a legacy flag parked when the integration holds a different one',
    },
    plan: planDropPerBrokerFlags,
  },
]
