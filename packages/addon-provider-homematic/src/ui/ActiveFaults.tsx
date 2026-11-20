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
import { CcuFaultsResultSchema, type CcuFaultRow } from '../ccu/ccu-schemas.js'
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
        <EmptyState title={t('overview.noFaults')} />
      ) : (
        <DataTable
          columns={columns}
          rows={faults.data.faults}
          rowKey={(row) => row.address}
          minWidthPx={520}
          defaultSort={{ columnKey: 'severity', dir: 'asc' }}
        />
      )}
    </TableBlock>
  )
}
