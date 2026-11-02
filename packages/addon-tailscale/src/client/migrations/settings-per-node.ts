import { planSettingsPerNode, type SettingsPerNodePorts } from '../../settings-per-node.js'

export const CLIENT_ADDON_ID = 'tailscale-client'

/** Every field of the client form. */
export const CLIENT_SETTING_KEYS: readonly string[] = [
  'clientMode',
  'hostname',
  'acceptRoutes',
  'acceptDns',
  'advertisedRoutes',
  'advertisedTags',
  'exitNodeId',
  'shieldsUp',
  'ssh',
  'authKey',
]

export type ClientSettingsPorts = SettingsPerNodePorts

export const planClientSettingsPerNode = (ports: ClientSettingsPorts) =>
  planSettingsPerNode(CLIENT_ADDON_ID, CLIENT_SETTING_KEYS, ports)
