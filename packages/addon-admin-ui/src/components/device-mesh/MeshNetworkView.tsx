/**
 * One mesh network: KPI row, topology map, node table and the detail of the
 * selected node. On a phone the map sits behind a full-screen button.
 */
import {
  Badge,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  ErrorBox,
  formatLastSeen,
  Button,
  LQI_TONE_TEXT,
  lqiTone,
  meshStats,
  StatCard,
  TABLE_SCROLL_MAX_H,
  useIsPhone,
  useMeshRoleLabel,
  useMeshTransportLabel,
  useUiText,
  type DataColumn,
  type MeshNetwork,
} from '@dominevo/ui-library'
import type { MeshNode, MeshTopology } from '@dominevo/types'
import { Map as MapIcon } from 'lucide-react'
import { useState } from 'react'
import { MeshMap } from './MeshMap'
import { MeshNodeDetail } from './MeshNodeDetail'

const UNKNOWN = '—'

export interface MeshNetworkViewProps {
  readonly network: MeshNetwork
  readonly selectedDeviceId: number | null
  readonly onSelectDevice: (deviceId: number | null) => void
  readonly onRetry: () => void
}

export function MeshNetworkView({
  network,
  selectedDeviceId,
  onSelectDevice,
  onRetry,
}: MeshNetworkViewProps) {
  const t = useUiText()
  const topology = network.topology
  if (topology === null) {
    return (
      <ErrorBox
        title={t('uiLibrary.deviceMesh.networkFailed', 'A mesh could not be read')}
        message={
          network.error ?? t('uiLibrary.deviceMesh.loadFailed', 'The mesh could not be read.')
        }
        onRetry={onRetry}
      />
    )
  }
  return (
    <NetworkBody
      topology={topology}
      selectedDeviceId={selectedDeviceId}
      onSelectDevice={onSelectDevice}
    />
  )
}

function NetworkBody({
  topology,
  selectedDeviceId,
  onSelectDevice,
}: {
  readonly topology: MeshTopology
  readonly selectedDeviceId: number | null
  readonly onSelectDevice: (deviceId: number | null) => void
}) {
  const t = useUiText()
  const roleLabel = useMeshRoleLabel()
  const transportLabel = useMeshTransportLabel()
  const isPhone = useIsPhone()
  const [mapOpen, setMapOpen] = useState(false)
  const [selectedPeerKey, setSelectedPeerKey] = useState<string | null>(null)
  const stats = meshStats(topology)
  const transports = [...new Set(topology.nodes.map((n) => n.transport))]
  const selected =
    topology.nodes.find((n) =>
      selectedDeviceId !== null ? n.deviceId === selectedDeviceId : n.nodeKey === selectedPeerKey,
    ) ?? null
  const select = (n: MeshNode): void => {
    setSelectedPeerKey(n.nodeKey)
    onSelectDevice(n.deviceId)
  }
  const selectKey = (nodeKey: string): void => {
    const n = topology.nodes.find((x) => x.nodeKey === nodeKey)
    if (n !== undefined) select(n)
  }

  const columns: readonly DataColumn<MeshNode>[] = [
    {
      key: 'node',
      mobile: 'primary',
      header: t('uiLibrary.deviceMesh.node', 'Node'),
      render: (n) => n.label,
      sortValue: (n) => n.label,
    },
    {
      key: 'role',
      mobile: 'keep',
      header: t('uiLibrary.deviceMesh.role', 'Role'),
      render: (n) => (
        <span className="inline-flex items-center gap-1.5">
          {roleLabel(n.role)}
          {!n.online && (
            <Badge variant="neutral">{t('uiLibrary.deviceMesh.offline', 'Offline')}</Badge>
          )}
        </span>
      ),
      sortValue: (n) => n.role,
    },
    {
      key: 'rssi',
      mobile: 'hidden',
      header: 'RSSI',
      align: 'right',
      render: (n) => (n.rssi === null ? UNKNOWN : `${n.rssi} dBm`),
      sortValue: (n) => n.rssi,
    },
    {
      key: 'lqi',
      mobile: 'keep',
      header: 'LQI',
      align: 'right',
      render: (n) => (
        <span className={LQI_TONE_TEXT[lqiTone(n.lqi)]}>{n.lqi === null ? UNKNOWN : n.lqi}</span>
      ),
      sortValue: (n) => n.lqi,
    },
    {
      key: 'read',
      mobile: 'detail',
      header: t('uiLibrary.deviceMesh.lastRead', 'Last read'),
      render: (n) => formatLastSeen(n.lastReadAt, t) ?? t('uiLibrary.deviceMesh.never', 'Never'),
      sortValue: (n) => n.lastReadAt,
    },
  ]

  const map = (
    <MeshMap topology={topology} selectedKey={selected?.nodeKey ?? null} onSelect={selectKey} />
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard
          label={t('uiLibrary.deviceMesh.kpiNodes', 'Nodes')}
          value={stats.nodes}
          subtext={transports.map(transportLabel).join(', ')}
        />
        <StatCard
          label={t('uiLibrary.deviceMesh.kpiOnline', 'Online')}
          value={stats.online}
          valueClassName={stats.online === stats.nodes ? 'text-success' : 'text-warning'}
        />
        <StatCard label={t('uiLibrary.deviceMesh.kpiRouters', 'Routers')} value={stats.routers} />
        <StatCard
          label={t('uiLibrary.deviceMesh.kpiMedianLqi', 'Median LQI')}
          value={stats.medianLqi === null ? UNKNOWN : stats.medianLqi}
          valueClassName={LQI_TONE_TEXT[lqiTone(stats.medianLqi)]}
        />
      </div>

      {isPhone ? (
        <>
          <Button variant="outline" size="sm" onClick={() => setMapOpen(true)}>
            <MapIcon className="h-3.5 w-3.5" aria-hidden />
            {t('uiLibrary.deviceMesh.showMap', 'Show map')}
          </Button>
          <Dialog open={mapOpen} onOpenChange={setMapOpen}>
            <DialogContent width="full" placement="sheet-on-mobile">
              <DialogHeader title={t('uiLibrary.deviceMesh.mapLabel', 'Mesh topology map')} />
              <DialogBody>
                <div className="h-[70vh]">{map}</div>
              </DialogBody>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <div className="h-96 overflow-hidden rounded-lg border border-border bg-surface">{map}</div>
      )}

      <DataTable
        columns={columns}
        rows={topology.nodes}
        rowKey={(n) => n.nodeKey}
        onRowClick={select}
        rowClassName={(n) => (n.nodeKey === selected?.nodeKey ? 'bg-surface-hover' : undefined)}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'node', dir: 'asc' }}
        emptyMessage={t('uiLibrary.deviceMesh.noNodes', 'No nodes in this mesh yet.')}
      />
      {selected !== null && <MeshNodeDetail node={selected} />}
    </div>
  )
}
