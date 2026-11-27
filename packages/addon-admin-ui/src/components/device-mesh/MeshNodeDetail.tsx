/**
 * Detail of one mesh node: identity and counters, fabrics, and the Thread
 * neighbours and routes it reports. What the provider holds is shown as it is;
 * a field the node did not report is "—", a failed read an error, never `0`.
 * "Read now" is the only way a battery node is asked anything.
 */
import {
  Button,
  DataTable,
  ErrorBox,
  formatLastSeen,
  SectionCard,
  Skeleton,
  useDeviceMeshGetNodeDiagnostics,
  useDeviceMeshReadNow,
  useUiText,
  type DataColumn,
} from '@camstack/ui-library'
import type { MeshNode, MeshThreadNeighbor, MeshThreadRoute } from '@camstack/types'
import { RefreshCw } from 'lucide-react'

const UNKNOWN = '—'
const num = (v: number | null): string => (v === null ? UNKNOWN : String(v))

export function MeshNodeDetail({ node }: { readonly node: MeshNode }) {
  const t = useUiText()
  if (node.deviceId === null) return <PeerOnlyDetail node={node} />
  return <DeviceNodeDetail node={node} deviceId={node.deviceId} />
}

function PeerOnlyDetail({ node }: { readonly node: MeshNode }) {
  const t = useUiText()
  return (
    <SectionCard
      headingId="mesh-node-detail"
      title={t('uiLibrary.deviceMesh.nodeDetail', 'Node: {{label}}', { label: node.label })}
    >
      <p className="p-3 text-sm text-foreground-muted">
        {t(
          'uiLibrary.deviceMesh.peerOnly',
          'This node is on the mesh but was not added by CamStack, so only its links are known.',
        )}
      </p>
    </SectionCard>
  )
}

function DeviceNodeDetail({
  node,
  deviceId,
}: {
  readonly node: MeshNode
  readonly deviceId: number
}) {
  const t = useUiText()
  const diagnostics = useDeviceMeshGetNodeDiagnostics({ deviceId })
  const readNow = useDeviceMeshReadNow({
    onSuccess: () => void diagnostics.refetch(),
  })
  const title = t('uiLibrary.deviceMesh.nodeDetail', 'Node: {{label}}', {
    label: node.label,
  })

  const d = diagnostics.data
  const readError = readNow.data !== undefined && !readNow.data.readOk ? readNow.data.error : null
  const neighborColumns: readonly DataColumn<MeshThreadNeighbor>[] = [
    {
      key: 'ext',
      mobile: 'primary',
      header: t('uiLibrary.deviceMesh.extAddress', 'Address'),
      render: (r) => r.extAddress,
    },
    {
      key: 'lqi',
      mobile: 'keep',
      header: 'LQI',
      align: 'right',
      render: (r) => num(r.lqi),
      sortValue: (r) => r.lqi,
    },
    {
      key: 'rssi',
      mobile: 'detail',
      header: 'RSSI',
      align: 'right',
      render: (r) => num(r.averageRssi),
      sortValue: (r) => r.averageRssi,
    },
    {
      key: 'child',
      mobile: 'hidden',
      header: t('uiLibrary.deviceMesh.child', 'Child'),
      render: (r) =>
        r.isChild === null
          ? UNKNOWN
          : r.isChild
            ? t('uiLibrary.deviceMesh.yes', 'Yes')
            : t('uiLibrary.deviceMesh.no', 'No'),
      notSortableReason: 'Yes / No',
    },
  ]
  const routeColumns: readonly DataColumn<MeshThreadRoute>[] = [
    {
      key: 'ext',
      mobile: 'primary',
      header: t('uiLibrary.deviceMesh.extAddress', 'Address'),
      render: (r) => r.extAddress,
    },
    {
      key: 'cost',
      mobile: 'keep',
      header: t('uiLibrary.deviceMesh.pathCost', 'Path cost'),
      align: 'right',
      render: (r) => num(r.pathCost),
      sortValue: (r) => r.pathCost,
    },
    {
      key: 'in',
      mobile: 'detail',
      header: t('uiLibrary.deviceMesh.lqiIn', 'LQI in'),
      align: 'right',
      render: (r) => num(r.lqiIn),
      sortValue: (r) => r.lqiIn,
    },
    {
      key: 'out',
      mobile: 'detail',
      header: t('uiLibrary.deviceMesh.lqiOut', 'LQI out'),
      align: 'right',
      render: (r) => num(r.lqiOut),
      sortValue: (r) => r.lqiOut,
    },
  ]
  return (
    <SectionCard
      headingId="mesh-node-detail"
      title={title}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={readNow.isPending}
          onClick={() => readNow.mutate({ deviceId })}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t('uiLibrary.deviceMesh.readNow', 'Read now')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        {readError !== null && <ErrorBox variant="warning" message={readError} />}
        {diagnostics.isPending && <Skeleton className="h-24 w-full" />}
        {diagnostics.isError && (
          <ErrorBox
            message={t('uiLibrary.deviceMesh.diagFailed', 'The node report could not be read.')}
            onRetry={() => void diagnostics.refetch()}
          />
        )}
        {d !== undefined && (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 text-sm">
              <Fact
                label={t('uiLibrary.deviceMesh.product', 'Product')}
                value={[d.vendor, d.product].filter((x) => x !== null).join(' ') || UNKNOWN}
              />
              <Fact
                label={t('uiLibrary.deviceMesh.software', 'Software')}
                value={d.softwareVersion ?? UNKNOWN}
              />
              <Fact
                label={t('uiLibrary.deviceMesh.uptime', 'Uptime')}
                value={d.uptimeS === null ? UNKNOWN : `${Math.round(d.uptimeS / 3600)} h`}
              />
              <Fact
                label={t('uiLibrary.deviceMesh.reboots', 'Reboots')}
                value={num(d.rebootCount)}
              />
              <Fact
                label={t('uiLibrary.deviceMesh.faults', 'Network faults')}
                value={
                  d.networkFaults === null
                    ? UNKNOWN
                    : d.networkFaults.length === 0
                      ? t('uiLibrary.deviceMesh.noFaults', 'None')
                      : d.networkFaults.join(', ')
                }
              />
              <Fact
                label={t('uiLibrary.deviceMesh.fabrics', 'Fabrics')}
                value={
                  d.fabrics === null
                    ? UNKNOWN
                    : d.fabrics.map((f) => f.label ?? `#${f.fabricIndex}`).join(', ') || UNKNOWN
                }
              />
              <Fact
                label={t('uiLibrary.deviceMesh.lastRead', 'Last read')}
                value={formatLastSeen(d.readAt, t) ?? t('uiLibrary.deviceMesh.never', 'Never')}
              />
            </dl>
            {d.thread !== null && d.thread.neighbors !== null && d.thread.neighbors.length > 0 && (
              <DataTable
                columns={neighborColumns}
                rows={d.thread.neighbors}
                rowKey={(r) => r.extAddress}
                pageSize={10}
              />
            )}
            {d.thread !== null && d.thread.routes !== null && d.thread.routes.length > 0 && (
              <DataTable
                columns={routeColumns}
                rows={d.thread.routes}
                rowKey={(r) => r.extAddress}
                pageSize={10}
              />
            )}
          </>
        )}
      </div>
    </SectionCard>
  )
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <dt className="text-xs text-foreground-subtle shrink-0">{label}</dt>
      <dd className="text-foreground text-right min-w-0 truncate" title={value}>
        {value}
      </dd>
    </div>
  )
}
