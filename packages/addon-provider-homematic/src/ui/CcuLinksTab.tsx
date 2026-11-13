import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  DataTable,
  DataTableFilterBar,
  ErrorBox,
  KebabMenu,
  useDataTableFilter,
  type DataColumn,
  type DataTableFilterConfig,
  type KebabMenuItem,
} from '@camstack/ui-library'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  CcuLinksResultSchema,
  OkResultSchema,
  type CcuLink,
  type LinkEndpoint,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { endpointLabel } from './link-labels.js'
import { LinkFormDialog, type LinkDraft } from './LinkFormDialog.js'
import { TableBlock } from './TableBlock.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

type DialogState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'form'; readonly link: CcuLink | null }

export interface CcuLinksTabProps {
  readonly trpc: CcuTrpc
  readonly integrationId: string
}

function linkKey(link: CcuLink): string {
  return `${link.sender.address}>${link.receiver.address}`
}

function linkSearchText(link: CcuLink): readonly string[] {
  const profile =
    link.profile === null
      ? []
      : link.profile.kind === 'switch'
        ? [link.profile.kind, link.profile.short, link.profile.long]
        : [link.profile.kind]
  return [
    link.sender.address,
    link.sender.name ?? '',
    link.sender.deviceName ?? '',
    link.sender.deviceType ?? '',
    link.receiver.address,
    link.receiver.name ?? '',
    link.receiver.deviceName ?? '',
    link.receiver.deviceType ?? '',
    link.name,
    link.description,
    ...profile,
  ]
}

const LINK_FILTER: DataTableFilterConfig<CcuLink> = {
  searchText: linkSearchText,
}

function Endpoint(props: { readonly endpoint: LinkEndpoint }) {
  const { endpoint } = props
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-sm text-foreground">{endpointLabel(endpoint)}</span>
      <span className="text-xs text-foreground-subtle">
        {endpoint.deviceName === null
          ? endpoint.address
          : `${endpoint.deviceName} · ${endpoint.address}`}
      </span>
    </div>
  )
}

/**
 * The CCU's direct links (sender channel → receiver channel). Key → switch
 * actuator links can be created, have their short / long press changed, and be
 * deleted; every write asks the operator first.
 */
export function CcuLinksTab(props: CcuLinksTabProps) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const result = useCcuData(trpc, 'listCcuLinks', input, CcuLinksResultSchema)
  const write = useCcuWrite(trpc)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
  const links = result.data?.links ?? []
  const filter = useDataTableFilter(links, LINK_FILTER)

  const describe = (sender: string, receiver: string): string => {
    const all = [...(result.data?.senders ?? []), ...(result.data?.receivers ?? [])]
    const label = (address: string): string => {
      const found = all.find((endpoint) => endpoint.address === address)
      return found === undefined ? address : endpointLabel(found)
    }
    return `${label(sender)} → ${label(receiver)}`
  }

  const save = async (link: CcuLink | null, draft: LinkDraft): Promise<void> => {
    const actions = {
      short: t(`links.action_${draft.short}`),
      long: t(`links.action_${draft.long}`),
    }
    const done = await write({
      action: link === null ? 'createCcuLink' : 'setCcuLinkProfile',
      input: { integrationId, ...draft },
      schema: OkResultSchema,
      title: link === null ? t('links.createTitle') : t('links.profileTitle'),
      message: t(link === null ? 'links.createMessage' : 'links.profileMessage', {
        link: describe(draft.sender, draft.receiver),
        ...actions,
      }),
      confirmLabel: link === null ? t('links.createConfirm') : t('links.profileConfirm'),
    })
    if (done !== null) {
      setDialog({ kind: 'closed' })
      result.reload()
    }
  }

  const remove = async (link: CcuLink): Promise<void> => {
    const done = await write({
      action: 'deleteCcuLink',
      input: { integrationId, sender: link.sender.address, receiver: link.receiver.address },
      schema: OkResultSchema,
      title: t('links.deleteTitle'),
      message: t('links.deleteMessage', {
        link: `${endpointLabel(link.sender)} → ${endpointLabel(link.receiver)}`,
      }),
      confirmLabel: t('links.deleteConfirm'),
      variant: 'danger',
    })
    if (done !== null) result.reload()
  }

  const profileCell = (link: CcuLink) => {
    if (link.profile === null) return <span className="text-foreground-subtle">—</span>
    if (link.profile.kind === 'custom') return <Badge>{t('links.profileCustom')}</Badge>
    return (
      <span className="text-sm text-foreground">
        {t('links.profileSwitch', {
          short: t(`links.action_${link.profile.short}`),
          long: t(`links.action_${link.profile.long}`),
        })}
      </span>
    )
  }

  const menu = (link: CcuLink): KebabMenuItem[] => [
    ...(link.profile?.kind === 'switch'
      ? [
          {
            id: 'edit',
            label: t('links.editProfile'),
            icon: Pencil,
            onClick: () => setDialog({ kind: 'form', link }),
          },
        ]
      : []),
    {
      id: 'delete',
      label: t('links.delete'),
      icon: Trash2,
      onClick: () => void remove(link),
    },
  ]

  const columns: readonly DataColumn<CcuLink>[] = [
    {
      key: 'sender',
      header: t('links.colSender'),
      nowrap: false,
      render: (row) => <Endpoint endpoint={row.sender} />,
      sortValue: (row) => endpointLabel(row.sender),
    },
    {
      key: 'receiver',
      header: t('links.colReceiver'),
      nowrap: false,
      render: (row) => <Endpoint endpoint={row.receiver} />,
      sortValue: (row) => endpointLabel(row.receiver),
    },
    {
      key: 'name',
      header: t('links.colName'),
      render: (row) => row.name || '—',
      sortValue: (row) => row.name,
    },
    {
      key: 'profile',
      header: t('links.colProfile'),
      nowrap: false,
      render: profileCell,
      sortValue: (row) => (row.profile === null ? '' : row.profile.kind),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Action column',
      render: (row) => <KebabMenu items={menu(row)} />,
    },
  ]

  if (result.error !== null) {
    return <ErrorBox title={t('links.loadFailed')} message={result.error} onRetry={result.reload} />
  }
  const data = result.data
  const failures = data?.failures ?? []
  return (
    <div className="flex flex-col gap-3">
      <TableBlock
        headingId="hm-links"
        title={t('links.title')}
        actions={
          <Button
            type="button"
            size="sm"
            disabled={data === undefined}
            onClick={() => setDialog({ kind: 'form', link: null })}
          >
            <Plus className="h-4 w-4" />
            {t('links.newLink')}
          </Button>
        }
      >
        <p className="text-xs text-foreground-muted">{t('links.hint')}</p>
        {failures.length > 0 && (
          <ErrorBox
            variant="warning"
            title={t('links.partial', { count: failures.length })}
            message={failures
              .map((failure) => `${failure.deviceName ?? failure.address}: ${failure.error}`)
              .join('\n')}
          />
        )}
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={{
            searchPlaceholder: t('links.searchPlaceholder'),
            searchLabel: t('links.searchLabel'),
            facetsLabel: t('links.facetsLabel'),
            clearLabel: t('links.clearFilters'),
          }}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
        <DataTable
          columns={columns}
          rows={filter.rows}
          rowKey={linkKey}
          minWidthPx={640}
          defaultSort={{ columnKey: 'sender', dir: 'asc' }}
          emptyMessage={
            result.loading
              ? t('common.loading')
              : filter.active
                ? t('links.noMatch')
                : t('links.none')
          }
        />
      </TableBlock>
      {dialog.kind === 'form' && data !== undefined && (
        <LinkFormDialog
          link={dialog.link}
          senders={data.senders}
          receivers={data.receivers}
          onClose={() => setDialog({ kind: 'closed' })}
          onSave={(draft) => save(dialog.link, draft)}
        />
      )}
    </div>
  )
}
