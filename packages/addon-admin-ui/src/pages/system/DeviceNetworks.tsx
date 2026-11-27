/**
 * Network → Device networks: every mesh network of every provider of the
 * `device-mesh` capability (a Matter fabric over Thread or Wi-Fi today, Zigbee
 * later). Cap-derived: nothing here names a protocol. The selected node lives in
 * the URL (`?node=<deviceId>`), so a device page can link straight to it.
 *
 * A sibling of "Mesh networks" (the VPN meshes), not a kind of it: those are
 * integration instances with credentials; these are read from devices.
 */
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Skeleton,
  useMeshNetworks,
  useMeshNetworkTitle,
  useMeshTransportLabel,
  useUiText,
  networkHasDevice,
  SECTION_BODY,
} from '@camstack/ui-library'
import { RefreshCw, Waypoints } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { MeshNetworkView } from '../../components/device-mesh/MeshNetworkView'

export function parseNodeParam(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export function DeviceNetworksPage() {
  const t = useUiText()
  const [params, setParams] = useSearchParams()
  const mesh = useMeshNetworks()
  const networkTitle = useMeshNetworkTitle()
  const transportLabel = useMeshTransportLabel()
  const focused = parseNodeParam(params.get('node'))

  const select = (deviceId: number | null): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (deviceId === null) next.delete('node')
        else next.set('node', String(deviceId))
        return next
      },
      { replace: true },
    )
  }

  if (
    mesh.presence === 'pending' ||
    (mesh.presence === 'present' && mesh.networks === undefined && !mesh.isError)
  ) {
    return <Skeleton className="h-40 w-full" />
  }
  if (mesh.presence === 'unknown' || mesh.isError) {
    return (
      <ErrorBox
        message={t('uiLibrary.deviceMesh.loadFailed', 'The mesh could not be read.')}
        onRetry={mesh.refetch}
      />
    )
  }
  if (mesh.presence === 'absent' || mesh.networks === undefined || mesh.networks.length === 0) {
    return (
      <EmptyState
        icon={Waypoints}
        title={t('uiLibrary.deviceMesh.emptyTitle', 'No device networks')}
        description={t(
          'uiLibrary.deviceMesh.emptyDescription',
          'Matter and Zigbee devices that report their mesh appear here once an integration that provides it is set up.',
        )}
      />
    )
  }
  const focusedMissing =
    focused !== null && !mesh.networks.some((n) => networkHasDevice(n, focused))
  return (
    <div className={`flex flex-col gap-6 ${SECTION_BODY}`}>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={mesh.isFetching} onClick={mesh.refetch}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t('uiLibrary.deviceMesh.refresh', 'Refresh')}
        </Button>
      </div>
      {focusedMissing && (
        <ErrorBox
          variant="warning"
          message={t(
            'uiLibrary.deviceMesh.nodeNotFound',
            'This device does not appear in the topology that was read.',
          )}
        />
      )}
      {mesh.truncated && (
        <ErrorBox
          variant="warning"
          message={t(
            'uiLibrary.deviceMesh.truncated',
            'Only the first devices were checked; some networks may be missing.',
          )}
        />
      )}
      {mesh.networks.map((network, index) => (
        <section key={network.rootDeviceId} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              {networkTitle(network.topology?.network ?? null, index)}
            </h2>
            {network.topology?.network != null && (
              <>
                <Badge variant="neutral">
                  {transportLabel(network.topology.network.technology)}
                </Badge>
                {network.topology.network.channel !== null && (
                  <Badge variant="neutral">
                    {t('uiLibrary.deviceMesh.channel', 'Channel {{n}}', {
                      n: network.topology.network.channel,
                    })}
                  </Badge>
                )}
              </>
            )}
          </div>
          <MeshNetworkView
            network={network}
            selectedDeviceId={
              focused !== null && networkHasDevice(network, focused) ? focused : null
            }
            onSelectDevice={select}
            onRetry={mesh.refetch}
          />
        </section>
      ))}
    </div>
  )
}
