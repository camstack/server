/**
 * `BrokerManager` — generic, kind-agnostic admin surface for the unified
 * `broker` cap. One table lists the registered brokers (all kinds, or one
 * provider's with `addonId`); operators add, edit, test and delete them.
 *
 * Add and Edit are `BrokerEditorDialog` — the same dialog the integration
 * wizard opens for "Create new…" — so there is one create / edit / sign-in
 * path. This file holds the table and per-row actions only; kind values are
 * data from `listProviders` (see `broker-kinds.ts`), never control flow.
 *
 * Ownership routing: `BrokerInfo.addonId` names the provider that OWNS each
 * broker; every id-keyed call threads it as the `{ addonId }` selector.
 *
 * Delete guard: `BrokerInfo` exposes no in-use flag, so delete is
 * unconditional (gate the button on it here if the cap later surfaces one).
 */
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogIn, LogOut, Plus, Pencil, Trash2, Wifi } from 'lucide-react'
import {
  Badge,
  Button,
  useBrokerList,
  useBrokerTestConnection,
  useBrokerRemove,
  useConfirm,
} from '@camstack/ui-library'
import type { UnifiedBrokerInfo, UnifiedBrokerStatus } from '@camstack/types'
import { BrokerEditorDialog } from './BrokerEditorDialog'
import { asBrokerList, useBrokerKinds } from './broker-kinds'
import { startBrokerInteractiveConnect } from '../../lib/broker-oauth-popup'
import { useTranslation } from 'react-i18next'

// ── Per-broker status pill ───────────────────────────────────────────
const STATUS_VARIANT: Record<UnifiedBrokerStatus, 'success' | 'warning' | 'default' | 'danger'> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'default',
  'auth-failed': 'danger',
  unreachable: 'danger',
  // i18n-ignore: tone token, not display text
  error: 'danger',
}

export function BrokerStatusPill({ status }: { readonly status: UnifiedBrokerStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="text-[10px]">
      {status}
    </Badge>
  )
}

// ── Row ──────────────────────────────────────────────────────────────
function BrokerRow({
  broker,
  interactiveConnectPath,
  interactiveDisconnectPath,
  kindLabel,
  onEdit,
}: {
  readonly broker: UnifiedBrokerInfo
  /** From `listProviders` for this broker's kind — undefined = no Sign-in. */
  readonly interactiveConnectPath?: string
  /** From `listProviders` — undefined = no Sign-out. */
  readonly interactiveDisconnectPath?: string
  readonly kindLabel: string
  readonly onEdit: (broker: UnifiedBrokerInfo) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [testResult, setTestResult] = useState<{
    ok: boolean
    error?: string
  } | null>(null)

  const test = useBrokerTestConnection({
    onSuccess: (result) =>
      setTestResult(result.ok ? { ok: true } : { ok: false, error: result.error }),
    onError: (err) =>
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
  })
  const remove = useBrokerRemove({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
    },
  })

  const handleDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: t('brokers.brokerManager.deleteBroker', 'Delete broker'),
      message: t(
        'brokers.brokerManager.deleteBrokerIntegrationsThatDepend',
        'Delete broker "{{name}}"? Integrations that depend on it will stop working.',
        { name: broker.name },
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    remove.mutate({ id: broker.id, addonId: broker.addonId })
  }

  const needsSignIn =
    interactiveConnectPath !== undefined &&
    interactiveConnectPath.length > 0 &&
    broker.status !== 'connected'
  const canSignOut =
    interactiveDisconnectPath !== undefined &&
    interactiveDisconnectPath.length > 0 &&
    broker.status === 'connected'

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 text-xs text-foreground font-medium">{broker.name}</td>
      <td className="px-3 py-2 text-xs text-foreground-subtle">{kindLabel}</td>
      <td className="px-3 py-2">
        <BrokerStatusPill status={broker.status} />
        {testResult && (
          <span className={`ml-2 text-[10px] ${testResult.ok ? 'text-success' : 'text-danger'}`}>
            {testResult.ok ? 'OK' : (testResult.error ?? t('common.failedWord'))}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1.5">
          {needsSignIn && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                startBrokerInteractiveConnect(interactiveConnectPath, broker.id, () => {
                  void queryClient.invalidateQueries({
                    queryKey: [['broker', 'list']],
                  })
                })
              }}
              title={t(
                'brokers.brokerManager.signInOpensAPopup',
                'Sign in — opens a popup that closes when done',
              )}
            >
              <LogIn className="h-3 w-3" /> {t('brokers.brokerManager.signIn')}
            </Button>
          )}
          {canSignOut && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                startBrokerInteractiveConnect(interactiveDisconnectPath, broker.id, () => {
                  void queryClient.invalidateQueries({
                    queryKey: [['broker', 'list']],
                  })
                })
              }}
              title={t(
                'brokers.brokerManager.signOutClearsTheLinked',
                'Sign out — clears the linked Google account on this broker',
              )}
            >
              <LogOut className="h-3 w-3" /> {t('brokers.brokerManager.signOut')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate({ id: broker.id, addonId: broker.addonId })}
            disabled={test.isPending}
            title={t('brokers.brokerManager.testConnection', 'Test connection')}
          >
            {test.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wifi className="h-3 w-3" />
            )}
            {t('brokers.brokerManager.test', 'Test')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(broker)}
            title={t('common.edit', 'Edit')}
          >
            <Pencil className="h-3 w-3" /> {t('common.edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-danger/40 text-danger hover:bg-danger/10"
            onClick={() => {
              void handleDelete()
            }}
            disabled={remove.isPending}
            title={t('common.delete', 'Delete')}
          >
            {remove.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            {t('common.delete', 'Delete')}
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ── Manager ──────────────────────────────────────────────────────────
export interface BrokerManagerProps {
  /**
   * Narrow to ONE provider: only the connections it owns, and only the kinds
   * it serves in the Add picker. Omit to manage every broker.
   */
  readonly addonId?: string
}

export function BrokerManager({ addonId }: BrokerManagerProps = {}) {
  const { t } = useTranslation()
  const listQuery = useBrokerList({})
  const brokers = useMemo(
    () =>
      asBrokerList(listQuery.data).filter((b) => addonId === undefined || b.addonId === addonId),
    [listQuery.data, addonId],
  )
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<UnifiedBrokerInfo | null>(null)

  // The creatable kinds come from LIVE `listProviders()` data (see `broker-kinds.ts`).
  const { options: kinds } = useBrokerKinds(addonId !== undefined ? { addonId } : {})
  const labelByKind = useMemo(() => new Map(kinds.map((k) => [k.kind, k.label])), [kinds])

  /** kind → connect/disconnect paths from listProviders (first match). */
  const pathsByKind = useMemo(() => {
    const map = new Map<string, { readonly connect?: string; readonly disconnect?: string }>()
    for (const k of kinds) {
      if (map.has(k.kind)) continue
      map.set(k.kind, {
        ...(k.interactiveConnectPath !== undefined ? { connect: k.interactiveConnectPath } : {}),
        ...(k.interactiveDisconnectPath !== undefined
          ? { disconnect: k.interactiveDisconnectPath }
          : {}),
      })
    }
    return map
  }, [kinds])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={() => setAdding(true)}
          disabled={kinds.length === 0}
          title={
            kinds.length === 0
              ? t(
                  'brokers.brokerManager.noBrokerProvidersAvailable',
                  'No broker providers available',
                )
              : undefined
          }
        >
          <Plus className="h-3.5 w-3.5" /> {t('brokers.brokerManager.addBroker')}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-surface overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse">
          <thead>
            <tr className="border-b border-border bg-background/50">
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                {t('brokers.brokerManager.name', 'Name')}
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                {t('brokers.brokerManager.kind', 'Kind')}
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                {t('brokers.brokerManager.status', 'Status')}
              </th>
              <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                {t('brokers.brokerManager.actions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {listQuery.isLoading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-foreground-subtle">
                  <Loader2 className="inline h-4 w-4 animate-spin" />{' '}
                  {t('brokers.brokerManager.loadingBrokers')}
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-danger">
                  {t('brokers.brokerManager.failedToLoadBrokers', 'Failed to load brokers:')}{' '}
                  {listQuery.error instanceof Error
                    ? listQuery.error.message
                    : t('brokers.brokerManager.unknownError', 'Unknown error')}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && !listQuery.isError && brokers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-foreground-subtle">
                  {t(
                    'brokers.brokerManager.noBrokersRegisteredYetAdd',
                    'No brokers registered yet. Add one to publish device events for downstream automations.',
                  )}
                </td>
              </tr>
            )}
            {brokers.map((b) => {
              const paths = pathsByKind.get(b.kind)
              return (
                <BrokerRow
                  key={b.id}
                  broker={b}
                  {...(paths?.connect !== undefined
                    ? { interactiveConnectPath: paths.connect }
                    : {})}
                  {...(paths?.disconnect !== undefined
                    ? { interactiveDisconnectPath: paths.disconnect }
                    : {})}
                  kindLabel={labelByKind.get(b.kind) ?? b.kind}
                  onEdit={setEditing}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {adding && (
        <BrokerEditorDialog
          {...(addonId !== undefined ? { addonId } : {})}
          onClose={() => setAdding(false)}
          onSaved={() => setAdding(false)}
        />
      )}
      {editing && (
        <BrokerEditorDialog
          broker={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  )
}
