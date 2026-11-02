/**
 * One list for everything that provides a function (Logs → Destinations, Connectivity →
 * Email): a row per instance of each provider that keeps `integration-instances` records, and a
 * fixed row per provider that has none. Every row, name and switch is derived from the
 * capabilities; the page names only the function cap and its wording.
 *
 * Loading, failed and empty are three different answers (D315): the empty message appears only
 * once every query has answered with nothing.
 */
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorBox,
  SectionCard,
  Switch,
  useAddonsSetCapabilityProviderEnabled,
  type DataColumn,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, type LucideIcon } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstanceRow, PanelRow } from './provider-instances-model'
import { useProviderInstancesData } from './use-provider-instances-data'

export interface ProviderInstancesPanelProps {
  /** The function capability whose providers are listed (`log-destination`, `smtp-provider`). */
  readonly functionCap: string
  readonly icon: LucideIcon
  readonly title: string
  readonly subtitle: string
  readonly emptyTitle: string
  readonly emptyDescription: string
  readonly addLabel: string
  /** The `?<key>=` that holds an open instance in the URL. Defaults to `instance`. */
  readonly editKey?: string
}

function StateCell({ row }: { readonly row: InstanceRow }): ReactElement {
  const { t } = useTranslation()
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant={row.configured ? 'success' : 'default'}>
        {row.configured
          ? t('providerInstances.configured', 'Configured')
          : t('providerInstances.notConfigured', 'Not configured')}
      </Badge>
      {row.status !== undefined && (
        <Badge
          variant={
            row.status.state === 'error'
              ? 'danger'
              : row.status.state === 'ok'
                ? 'success'
                : 'default'
          }
          title={row.status.detail}
        >
          {row.status.state}
        </Badge>
      )}
    </span>
  )
}

function EnableCell({
  row,
  functionCap,
}: {
  readonly row: Extract<PanelRow, { kind: 'fixed' }>
  readonly functionCap: string
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const setEnabled = useAddonsSetCapabilityProviderEnabled({
    onSuccess: () => void queryClient.invalidateQueries(),
  })
  return (
    <Switch
      checked={row.isActive}
      disabled={setEnabled.isPending}
      aria-label={t('providerInstances.enable', 'Enable {{name}}', {
        name: row.providerName,
      })}
      onCheckedChange={(enabled) =>
        setEnabled.mutate({
          capName: functionCap,
          addonId: row.addonId,
          enabled,
        })
      }
    />
  )
}

export function ProviderInstancesPanel({
  functionCap,
  icon,
  title,
  subtitle,
  emptyTitle,
  emptyDescription,
}: ProviderInstancesPanelProps): ReactElement {
  const { t } = useTranslation()
  const data = useProviderInstancesData(functionCap)

  const columns = useMemo<readonly DataColumn<PanelRow>[]>(
    () => [
      {
        key: 'name',
        // A fixed row's description is prose: it wraps inside the cell instead of widening the table.
        nowrap: false,
        header: t('providerInstances.colName', 'Name'),
        sortValue: (row) => row.name,
        render: (row) => (
          <span className="flex flex-col">
            <span className="font-medium text-foreground">{row.name}</span>
            {row.kind === 'fixed' && row.description.length > 0 && (
              <span
                className="line-clamp-2 text-[11px] text-foreground-subtle"
                title={row.description}
              >
                {row.description}
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'provider',
        header: t('providerInstances.colProvider', 'Provider'),
        sortValue: (row) => row.providerName,
        render: (row) => <span className="text-foreground-muted">{row.providerName}</span>,
      },
      {
        key: 'state',
        header: t('providerInstances.colState', 'State'),
        notSortableReason: t(
          'providerInstances.stateNotSortable',
          'A row carries a badge, not a value to order by.',
        ),
        render: (row) => (row.kind === 'instance' ? <StateCell row={row} /> : null),
      },
      {
        key: 'on',
        header: t('providerInstances.colOn', 'On'),
        notSortableReason: t(
          'providerInstances.onNotSortable',
          'A switch is not a value to order by.',
        ),
        render: (row) =>
          row.kind === 'fixed' ? <EnableCell row={row} functionCap={functionCap} /> : null,
      },
    ],
    [functionCap, t],
  )

  let body: ReactElement
  if (data.state === 'error') {
    body = (
      <div className="p-3">
        <ErrorBox
          title={t('providerInstances.loadFailed', 'Could not load the list')}
          message={data.error ?? ''}
          onRetry={data.refetch}
        />
      </div>
    )
  } else if (data.state === 'pending') {
    body = (
      <div className="flex items-center gap-2 p-3 text-xs text-foreground-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('providerInstances.loading', 'Loading…')}
      </div>
    )
  } else if (data.rows.length === 0) {
    body = <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} />
  } else {
    body = (
      <DataTable columns={columns} rows={data.rows} rowKey={(row) => row.key} bordered={false} />
    )
  }

  return (
    <SectionCard headingId={`provider-instances-${functionCap}`} title={title} icon={icon}>
      <p className="px-3 pt-2 text-xs text-foreground-muted">{subtitle}</p>
      {body}
    </SectionCard>
  )
}
