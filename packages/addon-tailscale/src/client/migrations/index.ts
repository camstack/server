import type { AddonMigration } from '@camstack/types'
import {
  type AuthKeyToInstancePorts,
  type DropMovedKeysPorts,
  moveAuthKeyToRecord,
  planDropMovedKeys,
} from './authkey-to-instance.js'
import { type ClientSettingsPorts, planClientSettingsPerNode } from './settings-per-node.js'

export type { ClientSettingsPorts } from './settings-per-node.js'
export type {
  AuthKeyToInstancePorts,
  DropMovedKeysPorts,
  TailnetMigrationLog,
  TailnetRecordState,
} from './authkey-to-instance.js'

/** Every body reads through ONE port object, so the addon binds the catalogue once. */
export type ClientCataloguePorts = ClientSettingsPorts & AuthKeyToInstancePorts & DropMovedKeysPorts

export const SETTINGS_PER_NODE_ID = 'tailscale-client/2026-11-03-settings-per-node'
export const AUTHKEY_TO_INSTANCE_ID = 'tailscale-client/2026-11-06-authkey-to-instance'
export const DROP_MOVED_KEYS_ID = 'tailscale-client/2026-11-06-drop-moved-keys'

/** The per-node copy alone: its spec runs it against a ledger host that offers no record ports. */
export const SETTINGS_PER_NODE_MIGRATION: AddonMigration<ClientSettingsPorts> = {
  meta: {
    id: SETTINGS_PER_NODE_ID,
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
}

/** The `tailscale-client` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<ClientCataloguePorts>[] = [
  SETTINGS_PER_NODE_MIGRATION,
  {
    meta: {
      id: AUTHKEY_TO_INSTANCE_ID,
      owner: 'tailscale-client',
      level: 'addon-state',
      seq: 2,
      dependsOn: [SETTINGS_PER_NODE_ID],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move the pre-auth key and the hostname of the hub into the tailnet instance record',
      fixtureMark: 'a client setting the migration does not know',
    },
    procedure: moveAuthKeyToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_KEYS_ID,
      owner: 'tailscale-client',
      level: 'addon-state',
      seq: 3,
      dependsOn: [AUTHKEY_TO_INSTANCE_ID],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the pre-auth key and hostname rows that moved into the tailnet record',
      fixtureMark: 'a client setting the migration does not know',
    },
    plan: planDropMovedKeys,
  },
]
