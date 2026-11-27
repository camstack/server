/**
 * DeviceMeshCard — the device page's summary of where a device sits in its mesh
 * (`device-mesh`, widget `host/device-mesh`): role, signal, last read, parent
 * router and the node's own error counters, and a link into the Network page
 * focused on this node.
 *
 * Everything shown is what the provider already holds. A battery-powered or
 * sleepy node is never read unasked: "Read now" is the explicit ask, and a
 * figure the node never reported is "—", never `0` (D393).
 */
import { RefreshCw } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import type { MeshNode } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import {
  useDeviceMeshGetNodeDiagnostics,
  useDeviceMeshGetTopology,
  useDeviceMeshReadNow,
} from '../../generated/system-hooks'
import { formatLastSeen } from '../../lib/format-last-seen'
import { hubPath } from '../../lib/hub-mount'
import { Button } from '../../primitives/button'
import { ErrorBox } from '../error-box'
import { Skeleton } from '../../primitives/skeleton'
import { LQI_TONE_TEXT, lqiTone, parentRouterOf } from './device-mesh-model'
import { useMeshRoleLabel } from './mesh-labels'

export interface DeviceMeshCardProps {
  readonly deviceId: number
}

/** The Network section focused on one node. */
export function meshNodeHref(deviceId: number): string {
  return hubPath(`/system/network?tab=device-mesh&node=${deviceId}`)
}

function Row({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <dt className="text-xs text-foreground-subtle shrink-0">{label}</dt>
      <dd className="text-sm text-foreground text-right min-w-0 truncate">{children}</dd>
    </div>
  )
}

export function DeviceMeshCard({ deviceId }: DeviceMeshCardProps): JSX.Element {
  const t = useUiText()
  const roleLabel = useMeshRoleLabel()
  const topology = useDeviceMeshGetTopology({ deviceId })
  const diagnostics = useDeviceMeshGetNodeDiagnostics({ deviceId })
  const readNow = useDeviceMeshReadNow({
    onSuccess: () => {
      void topology.refetch()
      void diagnostics.refetch()
    },
  })

  if (topology.isPending) return <Skeleton className="h-24 w-full" />
  if (topology.isError) {
    return (
      <ErrorBox
        message={t('uiLibrary.deviceMesh.loadFailed', 'The mesh could not be read.')}
        onRetry={() => void topology.refetch()}
      />
    )
  }
  const node: MeshNode | undefined = topology.data.nodes.find((n) => n.deviceId === deviceId)
  if (node === undefined) {
    return (
      <p className="text-sm text-foreground-muted">
        {t('uiLibrary.deviceMesh.notListed', 'This device is not listed in its mesh yet.')}
      </p>
    )
  }
  const parent = parentRouterOf(topology.data, node.nodeKey)
  const asleep = node.power !== 'mains'
  const diag = diagnostics.data
  const never = t('uiLibrary.deviceMesh.never', 'Never')
  const unknown = '—'
  const readError = readNow.data !== undefined && !readNow.data.readOk ? readNow.data.error : null

  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-1">
        <Row label={t('uiLibrary.deviceMesh.role', 'Role')}>{roleLabel(node.role)}</Row>
        <Row label={t('uiLibrary.deviceMesh.rssi', 'Signal (RSSI)')}>
          {node.rssi === null ? unknown : `${node.rssi} dBm`}
        </Row>
        <Row label={t('uiLibrary.deviceMesh.lqi', 'Link quality (LQI)')}>
          <span className={LQI_TONE_TEXT[lqiTone(node.lqi)]}>
            {node.lqi === null ? unknown : node.lqi}
          </span>
        </Row>
        <Row label={t('uiLibrary.deviceMesh.parent', 'Parent router')}>
          {parent === null ? unknown : parent.label}
        </Row>
        <Row label={t('uiLibrary.deviceMesh.faults', 'Network faults')}>
          {diag?.networkFaults == null
            ? unknown
            : diag.networkFaults.length === 0
              ? t('uiLibrary.deviceMesh.noFaults', 'None')
              : diag.networkFaults.join(', ')}
        </Row>
        <Row label={t('uiLibrary.deviceMesh.reboots', 'Reboots')}>
          {diag?.rebootCount == null ? unknown : diag.rebootCount}
        </Row>
        <Row label={t('uiLibrary.deviceMesh.lastRead', 'Last read')}>
          {formatLastSeen(node.lastReadAt, t) ?? never}
        </Row>
      </dl>
      {readError !== null && <ErrorBox variant="warning" message={readError} />}
      {diagnostics.isError && (
        <ErrorBox
          variant="warning"
          message={t(
            'uiLibrary.deviceMesh.diagnosticsFailed',
            'The node diagnostics could not be read.',
          )}
          onRetry={() => void diagnostics.refetch()}
        />
      )}
      {asleep && (
        <p className="text-xs text-foreground-subtle">
          {t(
            'uiLibrary.deviceMesh.asleepHint',
            'A battery device is never read on its own. Figures are what it last reported.',
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={readNow.isPending}
          onClick={() => readNow.mutate({ deviceId })}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t('uiLibrary.deviceMesh.readNow', 'Read now')}
        </Button>
        <a className="text-sm text-primary hover:underline" href={meshNodeHref(deviceId)}>
          {t('uiLibrary.deviceMesh.viewInNetwork', 'View in the network')}
        </a>
      </div>
    </div>
  )
}
