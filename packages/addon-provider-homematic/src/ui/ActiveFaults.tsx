import { useMemo, type ReactNode } from 'react'
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorBox,
  Skeleton,
  type AddonPageProps,
  type DataColumn,
} from '@camstack/ui-library'
import { CcuFaultsResultSchema, type CcuFault, type CcuFaultRow } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { deviceDetailPath } from './device-route.js'
import { dateTimeOrDash } from './format.js'
import { TableBlock } from './TableBlock.js'
import { useCcuData } from './use-ccu-data.js'

/** Errors above warnings: the table's default order. */
export function severityRank(severity: CcuFaultRow['severity']): number {
  return severity === 'error' ? 0 : 1
}

/**
 * The faults CamStack derives from the CCU, one row per device. A failed read
 * is the warning alert, never an empty list: "no faults" is only said by an
 * answer that came back with none.
 */
export function ActiveFaults(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly navigate: AddonPageProps['navigate']
}): ReactNode {
  const { trpc, integrationId, navigate } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const faults = useCcuData(trpc, 'listCcuFaults', input, CcuFaultsResultSchema)

  const columns: readonly DataColumn<CcuFaultRow>[] = [
    {
      key: 'severity',
      header: t('overview.colSeverity'),
      render: (row) => (
        <Badge variant={row.severity === 'error' ? 'danger' : 'warning'}>
          {t(row.severity === 'error' ? 'overview.severityError' : 'overview.severityWarning')}
        </Badge>
      ),
      sortValue: (row) => severityRank(row.severity),
    },
    {
      key: 'device',
      header: t('overview.colDevice'),
      render: (row) => (
        <a
          href={deviceDetailPath(row.address, integrationId)}
          className="text-primary hover:underline"
          onClick={(event) => {
            event.preventDefault()
            navigate(deviceDetailPath(row.address, integrationId))
          }}
        >
          {row.name ?? row.address}
        </a>
      ),
      sortValue: (row) => row.name ?? row.address,
    },
    {
      key: 'fault',
      header: t('overview.colFault'),
      nowrap: false,
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-foreground">{row.label}</span>
          <span className="text-xs text-foreground-subtle">
            {row.code}
            {row.faults.length > 1 &&
              ` ${t('overview.faultsMore', { count: row.faults.length - 1 })}`}
          </span>
        </span>
      ),
      sortValue: (row) => row.code,
    },
    {
      key: 'since',
      header: t('overview.colSince'),
      render: (row) => dateTimeOrDash(row.since),
      sortValue: (row) => row.since,
    },
  ]

  return (
    <TableBlock headingId="hm-ccu-faults" title={t('overview.faultsTitle')}>
      {faults.error !== null ? (
        <ErrorBox
          variant="warning"
          title={t('overview.faultsUnavailable')}
          message={faults.error}
          onRetry={faults.reload}
        />
      ) : faults.data === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : faults.data.faults.length === 0 ? (
        <>
          <GatewayFaultList faults={faults.data.gatewayFaults} />
          {faults.data.gatewayFaults !== null && faults.data.gatewayFaults.length === 0 && (
            <EmptyState title={t('overview.noFaults')} />
          )}
          <Unreported count={faults.data.unreported.length} />
        </>
      ) : (
        <>
          <GatewayFaultList faults={faults.data.gatewayFaults} />
          <DataTable
            columns={columns}
            rows={faults.data.faults}
            rowKey={(row) => row.address}
            minWidthPx={520}
            defaultSort={{ columnKey: 'severity', dir: 'asc' }}
          />
          <Unreported count={faults.data.unreported.length} />
        </>
      )}
    </TableBlock>
  )
}

/**
 * What the CCU box and its radio report (WatchDog, mass unreachable, radio
 * silence): not tied to one device. `null` is unknown (never read, or no source
 * answered) and is said so, never shown as healthy.
 */
function GatewayFaultList(props: { readonly faults: readonly CcuFault[] | null }): ReactNode {
  const { t } = useT()
  if (props.faults === null) {
    return <p className="text-sm text-foreground-subtle">{t('overview.gatewayUnknown')}</p>
  }
  if (props.faults.length === 0) return null
  return (
    <ul aria-label={t('overview.gatewayFaults')} className="flex flex-col gap-1">
      {props.faults.map((fault) => (
        <li key={fault.code} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={fault.severity === 'error' ? 'danger' : 'warning'}>
            {t(fault.severity === 'error' ? 'overview.severityError' : 'overview.severityWarning')}
          </Badge>
          <span className="text-foreground">{t('overview.gatewayLabel')}</span>
          <span className="text-foreground">{fault.label}</span>
          <span className="text-xs text-foreground-subtle">{fault.code}</span>
        </li>
      ))}
    </ul>
  )
}

/** Devices the CCU has not reported yet are unknown, never counted as healthy. */
function Unreported(props: { readonly count: number }): ReactNode {
  const { t } = useT()
  if (props.count === 0) return null
  return (
    <p className="text-sm text-foreground-subtle">
      {t('overview.faultsUnreported', { count: props.count })}
    </p>
  )
}
