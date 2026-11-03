import type { AddonMigration } from '@camstack/types'
import { type HubNodeFieldsPorts, planHubNodeFields } from './hub-node-fields.js'
import { type FixedPinPorts, moveFixedPinToKeychain } from './fixed-pin-to-keychain.js'

export const EXPORT_HAP_ID = 'export-hap'
export const INTERFACE_NAME_PER_NODE_ID = 'export-hap/2026-11-03-interface-name-per-node'
export const FIXED_PIN_TO_KEYCHAIN_ID = 'export-hap/2026-11-03-fixed-pin-to-keychain'

export type HapCataloguePorts = HubNodeFieldsPorts & FixedPinPorts

/** The `export-hap` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<HapCataloguePorts>[] = [
  {
    meta: {
      id: INTERFACE_NAME_PER_NODE_ID,
      owner: EXPORT_HAP_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy the bare network interface setting to its hub node row; the bare row stays for a release',
      fixtureMark: 'the bridge name the migration does not know',
    },
    plan: (ports) => planHubNodeFields(EXPORT_HAP_ID, ['interfaceName'], ports),
  },
  {
    meta: {
      id: FIXED_PIN_TO_KEYCHAIN_ID,
      owner: EXPORT_HAP_ID,
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move the fixed setup code from an inline setting into the keychain, where a password field keeps it',
      fixtureMark: 'the bridge name the migration does not know',
    },
    procedure: moveFixedPinToKeychain,
  },
]
