import type { AddonMigration } from '@camstack/types'
import { type HubNodeFieldsPorts, planHubNodeFields } from './hub-node-fields.js'
import { type FixedPinPorts, moveFixedPinToKeychain } from './fixed-pin-to-keychain.js'
import {
  type ExposureToRecordPorts,
  moveExposureToRecord,
  planDropExposureKeys,
} from './exposure-to-record.js'
import {
  type IdentityToInstancePorts,
  moveIdentityToDefaultInstance,
} from './identity-to-instance.js'

export { legacyIdentityOf } from './identity-to-instance.js'
export type { IdentityToInstancePorts } from './identity-to-instance.js'
export type { ExposureToRecordPorts } from './exposure-to-record.js'

export const EXPORT_HAP_ID = 'export-hap'
export const INTERFACE_NAME_PER_NODE_ID = 'export-hap/2026-11-03-interface-name-per-node'
export const FIXED_PIN_TO_KEYCHAIN_ID = 'export-hap/2026-11-03-fixed-pin-to-keychain'

export const IDENTITY_TO_INSTANCE_ID = 'export-hap/2026-11-04-identity-to-default-instance'
export const EXPOSURE_TO_RECORD_ID = 'export-hap/2026-11-04-exposure-to-record'
export const DROP_EXPOSURE_KEYS_ID = 'export-hap/2026-11-04-drop-exposure-keys'

export type HapCataloguePorts = HubNodeFieldsPorts &
  FixedPinPorts &
  IdentityToInstancePorts &
  ExposureToRecordPorts

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
  {
    meta: {
      id: IDENTITY_TO_INSTANCE_ID,
      owner: EXPORT_HAP_ID,
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the bridge identity (username, uuid, setup code) into the default HomeKit instance record, unchanged, then clear the old setting and its keychain entry',
      fixtureMark: 'the bridge name the migration does not know',
    },
    procedure: moveIdentityToDefaultInstance,
  },
  {
    meta: {
      id: EXPOSURE_TO_RECORD_ID,
      owner: EXPORT_HAP_ID,
      level: 'addon-state',
      seq: 4,
      dependsOn: [IDENTITY_TO_INSTANCE_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the exposed devices and actions into the default bridge exposure record, verified by read-back',
      fixtureMark: 'the bridge name the migration does not know',
    },
    procedure: moveExposureToRecord,
  },
  {
    meta: {
      id: DROP_EXPOSURE_KEYS_ID,
      owner: EXPORT_HAP_ID,
      level: 'addon-state',
      seq: 5,
      dependsOn: [EXPOSURE_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the old exposed and exposedActions settings once the record holds exactly what they carried',
      fixtureMark: 'the bridge name the migration does not know',
    },
    plan: planDropExposureKeys,
  },
]
