/**
 * The one table of a collection of connections (Logs → Destinations, Connectivity → Email, …):
 * a row per instance of each provider that keeps `integration-instances` records, and a fixed
 * row per provider that has none. A pill per record-holding provider filters it, and Add is
 * offered for every `multiple` provider however many rows it already has. Every row, name and switch is derived from the
 * capabilities; the page names only the function cap and its wording.
 *
 * Loading, failed and empty are three different answers (D315): the empty message appears only
 * once every query has answered with nothing.
 */
import {
  Badge,
  Button,
  DataTable,
  PageHeaderActions,
  EmptyState,
  ErrorBox,
  IconButton,
  SectionCard,
  Switch,
  useAddonsSetCapabilityProviderEnabled,
  useConfirm,
  useInstancesOfCap,
  useItemFormUrl,
  useSystem,
  type DataColumn,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, Link2Off, Loader2, Pencil, Play, Plus, Trash2, type LucideIcon } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fillBrokerConnectPath, startServerNavigation } from '../../lib/broker-oauth-popup'
import {
  TestVerdictBanner,
  toTestVerdict,
  type TestVerdict,
} from '../integrations/connection-test-verdict'
import { pushToast } from '../ui/toast-bus'
import { RestartButton } from '../integration-hub/addon-controls'
import { IntegrationActivity } from '../integration-hub/IntegrationActivity'
import { FixedRowSettingsDialog } from './FixedRowSettingsDialog'
import { InstanceEditorDialog } from './InstanceEditorDialog'
import { InstanceProviderPills, type InstanceInstallLink } from './InstanceProviderPills'
import { ProviderPickerDialog } from './ProviderPickerDialog'
import {
  creatableProviders,
  filterRows,
  formatEditRef,
  parseEditRef,
  providerPills,
  providersOf,
  statusText,
  targetsPinning,
  type InstanceRow,
  type PanelRow,
  type TypedIdRuleFor,
} from './instances-model'
import { useSetInstanceEnabled } from './use-set-instance-enabled'
import { HOLDER_QUERY_KEY, useInstancesData, type InstancesData } from './use-instances-data'

/** The `?<key>=` that holds an open instance in the URL. */
const EDIT_KEY = 'instance'

export interface InstancesTableProps {
  /** The function capability whose providers are listed (`log-destination`, `smtp-provider`). */
  readonly functionCap: string
  readonly icon: LucideIcon
  readonly title: string
  readonly subtitle: string
  readonly emptyTitle: string
  readonly emptyDescription: string
  readonly addLabel: string
  /** The add-on catalogue link at the right of the sub-header, when the function has providers to install. */
  readonly install?: InstanceInstallLink
  /**
   * Columns a page adds after On and before the row actions (a count, a link). The table owns
   * the built-in ones; the page owns the cap-specific cell.
   */
  readonly extraColumns?: readonly DataColumn<PanelRow>[]
  /** A block at the top of an instance's edit dialog (setup, pairing). Called per record. */
  readonly lead?: (row: InstanceRow) => ReactNode
  /**
   * Controls a page adds to an instance row's action cell, before Edit (a join, a drain, a
   * re-pair). Called per instance row; a fixed row has none.
   */
  readonly rowActions?: (row: InstanceRow) => ReactNode
  /** The kinds whose new record is named by the operator, not minted (an immutable typed id). */
  readonly typedId?: TypedIdRuleFor
}

/** The badge tooltip: the provider's detail and, when known, when the remote was last probed. */
function statusTitle(row: InstanceRow): string | undefined {
  const parts = [
    row.status?.detail,
    row.lastCheckedAt !== undefined ? new Date(row.lastCheckedAt).toLocaleString() : undefined,
  ].filter((p): p is string => p !== undefined && p.length > 0)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function StateCell({ row }: { readonly row: InstanceRow }): ReactElement {
  const { t } = useTranslation()
  // A switched-off row is quiet, not broken (D62): one neutral badge, no status of its own.
  if (!row.enabled) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant="default">{t('providerInstances.off', 'Off')}</Badge>
      </span>
    )
  }
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
          title={statusTitle(row)}
        >
          {statusText(row.status)}
        </Badge>
      )}
    </span>
  )
}

function InstanceSwitchCell({
  row,
  pinning,
}: {
  readonly row: InstanceRow
  readonly pinning: number
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const setEnabled = useSetInstanceEnabled({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] }),
  })
  return (
    <span className="flex flex-col gap-1">
      <Switch
        checked={row.enabled}
        disabled={setEnabled.isPending}
        aria-label={t('providerInstances.enable', 'Enable {{name}}', {
          name: row.name,
        })}
        onCheckedChange={(enabled) =>
          setEnabled.mutate({ addonId: row.addonId, id: row.id, enabled })
        }
      />
      {pinning > 0 && (
        <span className="text-[11px] text-foreground-subtle">
          {t('providerInstances.pinnedBy', { count: pinning })}
        </span>
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

export function InstancesTable({
  functionCap,
  icon,
  title,
  subtitle,
  emptyTitle,
  emptyDescription,
  addLabel,
  install,
  extraColumns,
  lead,
  rowActions,
  typedId,
}: InstancesTableProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const data = useInstancesData(functionCap)
  const form = useItemFormUrl({ editKey: EDIT_KEY, newKey: `${EDIT_KEY}-new` })
  const [testing, setTesting] = useState<string | null>(null)
  const [lastTest, setLastTest] = useState<{
    readonly name: string
    readonly verdict: TestVerdict
  } | null>(null)

  // The notification targets, read as the instances of `notification-output`: what pins a relay.
  const targets = useInstancesOfCap({ functionCap: 'notification-output' })
  const pinningCount = useCallback(
    (id: string): number => targetsPinning(targets.data ?? [], id).length,
    [targets.data],
  )
  const [activityAddon, setActivityAddon] = useState<string | null>(null)
  const [providerFilter, setProviderFilter] = useState<string | null>(null)

  const creatable = useMemo(() => creatableProviders(data.holders), [data.holders])
  const pills = useMemo(
    () => providerPills(data.functionProviders, data.rows, data.displayNames),
    [data.functionProviders, data.rows, data.displayNames],
  )
  // A filter whose provider left the list falls back to nothing selected (every provider).
  const activeFilter = pills.some((p) => p.addonId === providerFilter) ? providerFilter : null
  const visibleRows = useMemo(() => filterRows(data.rows, activeFilter), [data.rows, activeFilter])
  const nameOf = useCallback(
    (addonId: string): string => data.displayNames.get(addonId) ?? addonId,
    [data.displayNames],
  )

  const runTest = useCallback(
    async (row: InstanceRow): Promise<void> => {
      setTesting(row.key)
      setLastTest(null)
      try {
        const result = await system.trpcClient.integrationInstances.testInstance.mutate({
          addonId: row.addonId,
          id: row.id,
          values: {},
        })
        setLastTest({ name: row.name, verdict: toTestVerdict(result) })
      } catch (err: unknown) {
        // A transport failure of the CALL is not a verdict on the credentials.
        const message = err instanceof Error ? err.message : String(err)
        setLastTest({
          name: row.name,
          verdict: { status: 'inconclusive', error: message },
        })
      } finally {
        setTesting(null)
      }
    },
    [system],
  )

  const runDelete = useCallback(
    async (row: InstanceRow): Promise<void> => {
      // A failed look-up only drops the warning below; the delete itself still asks.
      const pinning = targetsPinning(targets.data ?? [], row.id)
      const pinned =
        pinning.length > 0
          ? ` ${t(
              'providerInstances.deletePinned',
              'These notification targets use it and will stop delivering: {{names}}.',
              { names: pinning.join(', ') },
            )}`
          : ''
      const ok = await confirm({
        title: t('providerInstances.deleteTitle', 'Delete {{name}}?', {
          name: row.name,
        }),
        message: `${t(
          'providerInstances.deleteMessage',
          'The record and its stored credentials are removed.',
        )}${pinned}`,
        confirmLabel: t('common.delete', 'Delete'),
        variant: 'danger',
      })
      if (!ok) return
      try {
        await system.trpcClient.integrationInstances.deleteInstance.mutate({
          addonId: row.addonId,
          id: row.id,
        })
        await queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      } catch (err: unknown) {
        pushToast({
          title: t('providerInstances.deleteFailed', 'Could not delete'),
          message: `${row.name}: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'critical',
        })
      }
    },
    [confirm, queryClient, system, t, targets.data],
  )

  const showKind = useMemo(
    () => data.rows.some((row) => row.kind === 'instance' && row.kindLabel !== undefined),
    [data.rows],
  )
  // An interactive link or unlink opens the provider's own route; the list refreshes when it ends.
  const runLink = useCallback(
    (path: string | undefined, id: string): void => {
      if (path === undefined) return
      startServerNavigation(fillBrokerConnectPath(path, id), () => {
        void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      })
    },
    [queryClient],
  )

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
            <span
              className={`font-medium ${
                row.kind === 'instance' && !row.enabled
                  ? 'text-foreground-muted'
                  : 'text-foreground'
              }`}
            >
              {row.name}
            </span>
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
      ...(showKind
        ? [
            {
              key: 'kind',
              header: t('providerInstances.colKind', 'Kind'),
              sortValue: (row: PanelRow) => (row.kind === 'instance' ? (row.kindLabel ?? '') : ''),
              render: (row: PanelRow) => (
                <span className="text-foreground-muted">
                  {row.kind === 'instance' ? (row.kindLabel ?? '') : ''}
                </span>
              ),
            },
          ]
        : []),
      {
        key: 'state',
        header: t('instances.colStatus', 'Status'),
        notSortableReason: t(
          'providerInstances.stateNotSortable',
          'A row carries a badge, not a value to order by.',
        ),
        render: (row) =>
          row.kind === 'instance' ? (
            <StateCell row={row} />
          ) : (
            <Badge variant={row.isActive ? 'success' : 'default'}>
              {row.isActive ? t('instances.active', 'Active') : t('providerInstances.off', 'Off')}
            </Badge>
          ),
      },
      {
        key: 'on',
        header: t('providerInstances.colOn', 'On'),
        notSortableReason: t(
          'providerInstances.onNotSortable',
          'A switch is not a value to order by.',
        ),
        render: (row) =>
          row.kind === 'fixed' ? (
            <EnableCell row={row} functionCap={functionCap} />
          ) : (
            <InstanceSwitchCell row={row} pinning={pinningCount(row.id)} />
          ),
      },
      ...(extraColumns ?? []),
      {
        key: 'actions',
        align: 'right',
        notSortableReason: t('providerInstances.actionsNotSortable', 'Row actions are not values.'),
        render: (row) => (
          <span className="inline-flex items-center gap-1">
            {row.kind === 'instance' && row.connectPath !== undefined && (
              <IconButton
                icon={Link2}
                variant="ghost"
                size="sm"
                aria-label={t('providerInstances.connectRow', 'Connect {{name}}', {
                  name: row.name,
                })}
                onClick={() => runLink(row.connectPath, row.id)}
              />
            )}
            {row.kind === 'instance' && row.disconnectPath !== undefined && (
              <IconButton
                icon={Link2Off}
                variant="ghost"
                size="sm"
                aria-label={t('providerInstances.disconnectRow', 'Disconnect {{name}}', {
                  name: row.name,
                })}
                onClick={() => runLink(row.disconnectPath, row.id)}
              />
            )}
            {row.kind === 'instance' && row.canTest && (
              <IconButton
                icon={testing === row.key ? Loader2 : Play}
                variant="ghost"
                size="sm"
                aria-label={t('providerInstances.testRow', 'Test {{name}}', {
                  name: row.name,
                })}
                disabled={testing !== null}
                onClick={() => void runTest(row)}
              />
            )}
            {row.kind === 'instance' && rowActions?.(row)}
            <IconButton
              icon={Pencil}
              variant="ghost"
              size="sm"
              aria-label={t('providerInstances.editRow', 'Edit {{name}}', {
                name: row.name,
              })}
              onClick={() =>
                form.openEdit(
                  formatEditRef(row.addonId, row.kind === 'instance' ? row.id : undefined),
                )
              }
            />
            <RestartButton
              iconOnly
              addonId={row.addonId}
              displayName={row.providerName}
              description={t(
                'providerInstances.restartConfirm',
                'Restarts the addon on the hub. If it shares a runner group, every addon in that group restarts with it.',
              )}
            />
            {row.kind === 'instance' && (
              <IconButton
                icon={Trash2}
                variant="ghost"
                size="sm"
                aria-label={t('providerInstances.deleteRow', 'Delete {{name}}', { name: row.name })}
                onClick={() => void runDelete(row)}
              />
            )}
          </span>
        ),
      },
    ],
    [
      extraColumns,
      form,
      functionCap,
      pinningCount,
      rowActions,
      runDelete,
      runLink,
      runTest,
      showKind,
      t,
      testing,
    ],
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
      <DataTable
        columns={columns}
        rows={visibleRows}
        rowKey={(row) => row.key}
        bordered={false}
        emptyMessage={t('instances.noneForProvider', 'This provider has no instance yet.')}
      />
    )
  }

  // Add stays visible; when nothing is creatable it is disabled and says why.
  const blocked = data.holders.filter((h) => !creatable.includes(h)).map((h) => nameOf(h.addonId))
  const addDisabledReason =
    creatable.length > 0
      ? undefined
      : blocked.length > 0
        ? t(
            'instances.addBlocked',
            '{{names}}: only one instance is allowed and it already exists.',
            {
              names: blocked.join(', '),
            },
          )
        : t('instances.addNone', 'No provider here can hold instances.')

  const onAdd = (): void => {
    // A selected pill adds to its own provider; otherwise the picker, unless there is no choice.
    const chosen = creatable.find((h) => h.addonId === activeFilter)
    const only = chosen ?? (creatable.length === 1 ? creatable[0] : undefined)
    if (only !== undefined) form.openEdit(formatEditRef(only.addonId, null))
    else form.openNew()
  }

  return (
    <SectionCard headingId={`provider-instances-${functionCap}`} title={title} icon={icon}>
      <p className="px-3 pt-2 text-xs text-foreground-muted">{subtitle}</p>
      {data.state === 'ready' && addDisabledReason !== undefined && (
        <p className="px-3 pt-1 text-[11px] text-foreground-subtle">{addDisabledReason}</p>
      )}
      {data.state === 'ready' && (
        <>
          <PageHeaderActions>
            <Button
              size="sm"
              variant="primary"
              disabled={addDisabledReason !== undefined}
              title={addDisabledReason}
              onClick={onAdd}
            >
              <Plus className="h-3.5 w-3.5" />
              {addLabel}
            </Button>
          </PageHeaderActions>
          <InstanceProviderPills
            pills={pills}
            selected={activeFilter}
            onSelect={setProviderFilter}
            fallbackIcon={icon}
            {...(install !== undefined ? { install } : {})}
          />
        </>
      )}
      {body}
      {data.state === 'ready' && data.rows.length > 0 && (
        <ProviderActivity rows={data.rows} selected={activityAddon} onSelect={setActivityAddon} />
      )}
      {lastTest !== null && (
        <div className="space-y-1 p-3">
          <p className="text-[11px] font-medium text-foreground">{lastTest.name}</p>
          <TestVerdictBanner verdict={lastTest.verdict} />
        </div>
      )}
      {data.state === 'ready' && form.state.mode === 'new' && (
        <ProviderPickerDialog
          title={addLabel}
          providers={creatable.map((h) => ({
            addonId: h.addonId,
            name: nameOf(h.addonId),
            description: data.descriptions.get(h.addonId) ?? '',
          }))}
          onPick={(addonId) => form.openEdit(formatEditRef(addonId, null))}
          onCancel={form.close}
        />
      )}
      {data.state === 'ready' && form.state.mode === 'edit' && (
        <EditDialog
          key={form.state.id}
          refValue={form.state.id}
          data={data}
          nameOf={nameOf}
          onClose={form.close}
          {...(lead !== undefined ? { lead } : {})}
          {...(typedId !== undefined ? { typedId } : {})}
        />
      )}
    </SectionCard>
  )
}

function ProviderActivity({
  rows,
  selected,
  onSelect,
}: {
  readonly rows: readonly PanelRow[]
  readonly selected: string | null
  readonly onSelect: (addonId: string) => void
}): ReactElement | null {
  const { t } = useTranslation()
  const chips = useMemo(() => providersOf(rows), [rows])
  const first = chips[0]
  if (first === undefined) return null
  // A selection whose provider left the list falls back to the first row's provider.
  const current = chips.find((c) => c.addonId === selected) ?? first
  return (
    <div className="p-3">
      <IntegrationActivity
        addonId={current.addonId}
        switcher={
          chips.length > 1 ? (
            <div
              role="group"
              aria-label={t('providerInstances.activityProvider', 'Activity of')}
              className="flex flex-wrap items-center gap-1"
            >
              {chips.map((chip) => (
                <Button
                  key={chip.addonId}
                  variant="unstyled"
                  type="button"
                  aria-pressed={chip.addonId === current.addonId}
                  onClick={() => onSelect(chip.addonId)}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    chip.addonId === current.addonId
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                  }`}
                >
                  {chip.name}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />
    </div>
  )
}

function EditDialog({
  refValue,
  data,
  nameOf,
  onClose,
  lead,
  typedId,
}: {
  readonly refValue: string
  readonly data: InstancesData
  readonly nameOf: (addonId: string) => string
  readonly onClose: () => void
  readonly lead?: (row: InstanceRow) => ReactNode
  readonly typedId?: TypedIdRuleFor
}): ReactElement | null {
  const ref = parseEditRef(refValue)
  if (ref.kind === 'fixed') {
    return (
      <FixedRowSettingsDialog addonId={ref.addonId} title={nameOf(ref.addonId)} onClose={onClose} />
    )
  }
  const holder = data.holders.find((h) => h.addonId === ref.addonId)
  if (holder === undefined) return null
  const instance =
    ref.kind === 'instance' ? (holder.instances.find((i) => i.id === ref.id) ?? null) : null
  // A link to a record that no longer exists opens nothing.
  if (ref.kind === 'instance' && instance === null) return null
  const leadRow = data.rows.find(
    (row): row is InstanceRow =>
      row.kind === 'instance' && row.addonId === ref.addonId && row.id === instance?.id,
  )
  return (
    <InstanceEditorDialog
      addonId={ref.addonId}
      {...(lead !== undefined && leadRow !== undefined ? { lead: lead(leadRow) } : {})}
      providerName={nameOf(ref.addonId)}
      description={holder.description}
      instance={instance}
      onClose={onClose}
      {...(typedId !== undefined ? { typedId } : {})}
    />
  )
}
