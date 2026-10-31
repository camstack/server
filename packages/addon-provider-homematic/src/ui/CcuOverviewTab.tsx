import { useMemo } from 'react'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  SectionCard,
  Skeleton,
  StatCard,
  StatusBadge,
  type DataColumn,
} from '@camstack/ui-library'
import { Radio, TriangleAlert } from 'lucide-react'
import {
  CcuOverviewSchema,
  OkResultSchema,
  ServiceMessagesResultSchema,
  type CcuOverview,
  type ServiceMessage,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { dateTimeOrDash, percentOrDash, textOrDash } from './format.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

type InterfaceRow = CcuOverview['interfaces'][number]

function connectionStatus(connected: boolean | null): 'online' | 'offline' | 'unknown' {
  if (connected === null) return 'unknown'
  return connected ? 'online' : 'offline'
}

/** CCU overview: what the CCU says about itself, its interfaces and their radio health, and its service messages. */
export function CcuOverviewTab(props: { readonly trpc: CcuTrpc; readonly integrationId: string }) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const overview = useCcuData(trpc, 'ccuOverview', input, CcuOverviewSchema)
  const messages = useCcuData(trpc, 'listServiceMessages', input, ServiceMessagesResultSchema)
  const write = useCcuWrite(trpc)

  const acknowledge = async (message: ServiceMessage): Promise<void> => {
    const done = await write({
      action: 'acknowledgeServiceMessage',
      input: { integrationId, id: message.id },
      schema: OkResultSchema,
      title: t('overview.ackTitle'),
      message: t('overview.ackMessage', {
        type: textOrDash(message.type),
        name: textOrDash(message.name ?? message.address),
      }),
      confirmLabel: t('overview.ackConfirm'),
    })
    if (done !== null) messages.reload()
  }

  const interfaceColumns: readonly DataColumn<InterfaceRow>[] = [
    {
      key: 'name',
      header: t('overview.colInterface'),
      render: (row) => row.name,
      sortValue: (row) => row.name,
    },
    {
      key: 'state',
      header: t('overview.colState'),
      render: (row) => <StatusBadge status={connectionStatus(row.connected)} />,
      sortValue: (row) => (row.connected === null ? null : row.connected ? 1 : 0),
    },
    {
      key: 'duty',
      header: t('overview.colDutyCycle'),
      align: 'right',
      render: (row) => percentOrDash(row.dutyCycle),
      sortValue: (row) => row.dutyCycle,
    },
    {
      key: 'firmware',
      header: t('overview.colFirmware'),
      render: (row) => textOrDash(row.firmware),
      sortValue: (row) => row.firmware,
    },
    {
      key: 'type',
      header: t('overview.colType'),
      render: (row) => textOrDash(row.type ?? row.info),
      sortValue: (row) => row.type ?? row.info,
    },
    {
      key: 'gateways',
      header: t('overview.colGateways'),
      align: 'right',
      render: (row) => row.gateways.length,
      sortValue: (row) => row.gateways.length,
    },
  ]

  const messageColumns: readonly DataColumn<ServiceMessage>[] = [
    {
      key: 'time',
      header: t('overview.colWhen'),
      render: (row) => dateTimeOrDash(row.timestamp),
      sortValue: (row) => row.timestamp,
    },
    {
      key: 'type',
      header: t('overview.colMessage'),
      render: (row) => <Badge variant="warning">{textOrDash(row.type)}</Badge>,
      sortValue: (row) => row.type,
    },
    {
      key: 'device',
      header: t('overview.colDevice'),
      render: (row) => textOrDash(row.name ?? row.address),
      sortValue: (row) => row.name ?? row.address,
    },
    {
      key: 'ack',
      header: '',
      align: 'right',
      notSortableReason: 'Action column',
      render: (row) =>
        row.acknowledgeable ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void acknowledge(row)}>
            {t('overview.ack')}
          </Button>
        ) : null,
    },
  ]

  const info = overview.data?.info ?? null
  return (
    <div className="flex flex-col gap-3">
      {overview.error !== null && (
        <ErrorBox
          title={t('overview.loadFailed')}
          message={overview.error}
          onRetry={overview.reload}
        />
      )}
      <SectionCard headingId="hm-ccu-info" title={t('overview.ccuTitle')} icon={Radio}>
        {overview.loading && overview.data === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : info === null ? (
          <ErrorBox
            variant="warning"
            title={t('overview.infoUnavailable')}
            message={overview.data?.infoError ?? t('overview.infoNoAnswer')}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={t('overview.version')} value={textOrDash(info.version)} />
            <StatCard
              label={t('overview.product')}
              value={textOrDash(info.product)}
              subtext={info.platform ?? undefined}
            />
            <StatCard label={t('overview.hostname')} value={textOrDash(info.hostname)} />
            <StatCard label={t('overview.serial')} value={textOrDash(info.serial)} />
          </div>
        )}
      </SectionCard>
      <SectionCard headingId="hm-ccu-interfaces" title={t('overview.interfacesTitle')}>
        {overview.data?.interfacesError ? (
          <ErrorBox
            variant="warning"
            title={t('overview.interfacesUnavailable')}
            message={overview.data.interfacesError}
          />
        ) : (
          <DataTable
            columns={interfaceColumns}
            rows={overview.data?.interfaces ?? []}
            rowKey={(row) => row.name}
            emptyMessage={overview.loading ? t('common.loading') : t('overview.noInterfaces')}
            minWidthPx={560}
          />
        )}
      </SectionCard>
      <SectionCard
        headingId="hm-ccu-messages"
        title={t('overview.messagesTitle')}
        icon={TriangleAlert}
      >
        {messages.data?.error ? (
          <ErrorBox
            variant="warning"
            title={t('overview.messagesUnavailable')}
            message={messages.data.error}
          />
        ) : messages.error !== null ? (
          <ErrorBox message={messages.error} onRetry={messages.reload} />
        ) : messages.data !== undefined && messages.data.messages.length === 0 ? (
          <EmptyState title={t('overview.noMessages')} />
        ) : (
          <DataTable
            columns={messageColumns}
            rows={messages.data?.messages ?? []}
            rowKey={(row) => row.id}
            emptyMessage={t('common.loading')}
            minWidthPx={520}
            defaultSort={{ columnKey: 'time', dir: 'desc' }}
          />
        )}
      </SectionCard>
    </div>
  )
}
