/**
 * Mesh Networks page (Network → Mesh Networks): an `<InstancesTable>` over `mesh-network`. The
 * tailnet credentials (pre-auth key, hostname) are an `integration-instances` record; the table
 * owns the list, the switch, Test and the editor. This page contributes what is mesh-specific,
 * as the `lead` of an instance's edit dialog:
 *   • the join card — Connect (browser login) / Disconnect / Log out and the Joined badge;
 *   • the status grid, endpoints and peers table.
 *
 * Routing: `mesh-network` is a collection cap; every method (`getStatus`, `startLogin`,
 * `leave`, `logout`, `listPeers`) accepts an optional `addonId` that targets the provider.
 */
import { Network as NetworkIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../../components/instances/InstancesTable'
import { MeshStatusBadges } from '../../components/mesh/MeshStatusBadges'
import { MeshJoinCard } from '../../components/mesh/MeshJoinCard'
import { MeshStatusPanel } from '../../components/mesh/MeshStatusPanel'

const CAPABILITY = 'mesh-network'

export function MeshNetworksPage(): ReactElement {
  const { t } = useTranslation()
  return (
    <InstancesTable
      functionCap={CAPABILITY}
      icon={NetworkIcon}
      title={t('system.meshNetworks.meshNetworks2', 'Mesh Networks')}
      subtitle={t(
        'system.meshNetworks.privateVpnMeshesThatConnect',
        'Private VPN meshes that connect CamStack to your other devices (Tailscale, Headscale, …). Each provider can also expose this hub publicly via its ingress (Tailscale Funnel).',
      )}
      emptyTitle={t(
        'system.meshNetworks.noMeshNetworkProvidersInstalled',
        'No mesh-network providers installed',
      )}
      emptyDescription={t(
        'system.meshNetworks.installAMeshAddonE',
        'Install a mesh addon (e.g. @camstack/addon-tailscale) to join this hub into a private VPN mesh.',
      )}
      addLabel={t('system.meshNetworks.addMesh', 'Add mesh')}
      install={{ capability: CAPABILITY, label: t('system.meshNetworks.addMesh', 'Add mesh') }}
      extraColumns={[
        {
          key: 'mesh-state',
          header: t('system.meshNetworks.connectionState', 'Mesh'),
          notSortableReason: t(
            'system.meshNetworks.connectionStateNotSortable',
            'Live state of the tailnet, not a stored value.',
          ),
          render: (row) => <MeshStatusBadges addonId={row.addonId} />,
        },
      ]}
      lead={(row) => (
        <div className="flex flex-col gap-3">
          <MeshJoinCard addonId={row.addonId} />
          <MeshStatusPanel addonId={row.addonId} />
        </div>
      )}
    />
  )
}
