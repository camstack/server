import { planSettingsPerNode, type SettingsPerNodePorts } from '../../settings-per-node.js'

export const INGRESS_ADDON_ID = 'tailscale-ingress'

/** Every field of the ingress form. */
export const INGRESS_SETTING_KEYS: readonly string[] = [
  'mode',
  'sourcePort',
  'targetPath',
  'upstreamScheme',
]

export type IngressSettingsPorts = SettingsPerNodePorts

export const planIngressSettingsPerNode = (ports: IngressSettingsPorts) =>
  planSettingsPerNode(INGRESS_ADDON_ID, INGRESS_SETTING_KEYS, ports)
