import type { AddonMigration } from '@camstack/types'
import {
  type CloudflareTunnelMigrationPorts,
  type DropMovedSettingsPorts,
  type LocalOriginToNodePorts,
  moveConnectionToRecord,
  planDropMovedSettings,
  planLocalOriginToNode,
} from './connection-to-records.js'

export type {
  CloudflareTunnelMigrationLog,
  CloudflareTunnelMigrationPorts,
  CloudflareTunnelRecordState,
  DropMovedSettingsPorts,
  LocalOriginToNodePorts,
  TunnelSecretKey,
} from './connection-to-records.js'

/** Every body reads through ONE port object, so the addon binds the catalogue once. */
export type CloudflareTunnelCataloguePorts = CloudflareTunnelMigrationPorts &
  DropMovedSettingsPorts &
  LocalOriginToNodePorts

export const CONNECTION_TO_RECORDS_ID = 'cloudflare-tunnel/2026-11-03-connection-to-records'
export const DROP_MOVED_SETTINGS_ID = 'cloudflare-tunnel/2026-11-03-drop-moved-settings'
export const LOCAL_ORIGIN_TO_NODE_ID = 'cloudflare-tunnel/2026-11-03-local-origin-to-node'

const FIXTURE_MARK = 'a setting key the migration does not know'

/**
 * The `cloudflare-tunnel` catalogue (D987): offered to the engine when the addon initialises.
 * Every entry is `tolerate`: the addon IS the tunnel, so a blocked owner is a dead tunnel, and
 * the addon keeps reading the legacy keys until the record exists.
 */
export const ADDON_MIGRATIONS: readonly AddonMigration<CloudflareTunnelCataloguePorts>[] = [
  {
    meta: {
      id: CONNECTION_TO_RECORDS_ID,
      owner: 'cloudflare-tunnel',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move the Cloudflare tunnel connection (mode, tokens, zone, hostname, TLS, protocol) from the addon settings into a tunnels record',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveConnectionToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_SETTINGS_ID,
      owner: 'cloudflare-tunnel',
      level: 'addon-state',
      seq: 2,
      dependsOn: [CONNECTION_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the Cloudflare tunnel keys that moved into the tunnels record',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedSettings,
  },
  {
    meta: {
      id: LOCAL_ORIGIN_TO_NODE_ID,
      owner: 'cloudflare-tunnel',
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'per-node',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy the tunnel local origin (host, port mode, port) to the hub node rows; the bare rows are kept',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planLocalOriginToNode,
  },
]
