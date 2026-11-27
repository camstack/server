import type { MeshNetworkInfo, MeshRole, MeshTransport } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'

/** Role words of a mesh node; one place so the table, the map and the widget agree. */
export function useMeshRoleLabel(): (role: MeshRole) => string {
  const t = useUiText()
  return (role) => {
    switch (role) {
      case 'border-router':
        return t('uiLibrary.deviceMesh.roleBorderRouter', 'Border router')
      case 'router':
        return t('uiLibrary.deviceMesh.roleRouter', 'Router')
      case 'end-device':
        return t('uiLibrary.deviceMesh.roleEndDevice', 'End device')
      case 'sleepy-end-device':
        return t('uiLibrary.deviceMesh.roleSleepy', 'Sleepy end device')
      case 'coordinator':
        return t('uiLibrary.deviceMesh.roleCoordinator', 'Coordinator')
      case 'unknown':
        return t('uiLibrary.deviceMesh.roleUnknown', 'Unknown')
    }
  }
}

export function useMeshTransportLabel(): (transport: MeshTransport) => string {
  const t = useUiText()
  return (transport) => {
    switch (transport) {
      case 'thread':
        return 'Thread'
      case 'wifi':
        return 'Wi-Fi'
      case 'ethernet':
        return 'Ethernet'
      case 'zigbee':
        return 'Zigbee'
      case 'unknown':
        return t('uiLibrary.deviceMesh.roleUnknown', 'Unknown')
    }
  }
}

/**
 * Title of one mesh network: its own name, else "Thread network <short id>",
 * else "Network N". Never a name the provider did not report.
 */
export function useMeshNetworkTitle(): (info: MeshNetworkInfo | null, index: number) => string {
  const t = useUiText()
  return (info, index) => {
    if (info?.name != null && info.name.trim() !== '') return info.name
    if (info?.technology === 'thread') {
      return t('uiLibrary.deviceMesh.threadNetwork', 'Thread network {{id}}', {
        id: info.id.slice(-4),
      })
    }
    return t('uiLibrary.deviceMesh.networkN', 'Network {{n}}', { n: index + 1 })
  }
}
