import type { AddonMigration } from '@camstack/types'
import { type HubNodeFieldsPorts, planHubNodeFields } from './hub-node-fields.js'

export const LOCAL_NETWORK_ID = 'local-network'
export const LAN_SETTINGS_PER_NODE_ID = 'local-network/2026-11-03-lan-settings-per-node'

/** The LAN access fields: how THIS host listens and announces itself. */
export const LAN_SETTING_KEYS: readonly string[] = [
  'httpEnabled',
  'httpPort',
  'tlsEnabled',
  'mdnsAdvertise',
  'passiveDiscovery',
  'localHostname',
]

/** The `local-network` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<HubNodeFieldsPorts>[] = [
  {
    meta: {
      id: LAN_SETTINGS_PER_NODE_ID,
      owner: LOCAL_NETWORK_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy each bare LAN access setting to its hub node row; the bare rows stay for a release',
      fixtureMark: 'the allowed addresses list the migration does not know',
    },
    plan: (ports) => planHubNodeFields(LOCAL_NETWORK_ID, LAN_SETTING_KEYS, ports),
  },
]
