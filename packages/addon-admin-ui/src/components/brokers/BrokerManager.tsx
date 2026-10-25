/**
 * `BrokerManager` — generic, kind-agnostic admin surface for the unified
 * `broker` cap. One table lists EVERY registered broker across kinds
 * (`home-assistant`, `mqtt`, future Zigbee2MQTT, …); operators add, edit,
 * test, and delete connections. The `<BrokerForm>` it mounts is purely
 * schema-driven, so this component never branches on a specific kind —
 * kind VALUES are data (the `BROKER_KINDS` catalog + whatever kinds the
 * registry already reports), never `if (kind === 'home-assistant')`
 * control flow.
 *
 * Kind sourcing:
 *   `broker.listProviders()` enumerates, per registered provider, which
 *   broker kind(s) it can create (`[{ addonId, kinds: [{kind,label}] }]`).
 *   The Add picker draws from that LIVE data so each pickable kind
 *   carries its owning `addonId` — the create flow then routes
 *   `getSettingsSchema` / `testSettings` / `add` to that exact provider
 *   via the `{ addonId }` selector. A tiny static fallback catalog labels
 *   any kind that shows up in `list()` but not in `listProviders()` (so
 *   an installed-but-unadvertised kind still round-trips on edit).
 *
 * Ownership routing (the fix):
 *   `BrokerInfo.addonId` names the provider that OWNS each broker. Every
 *   id-keyed call (get / getSettings / setSettings / testConnection /
 *   remove) threads it as the `{ addonId }` selector so the call hits the
 *   owning provider instead of defaulting to the first-registered one.
 *
 * Scoped to one provider (`addonId` prop):
 *   Connectivity shows one broker ADDON at a time (Home Assistant, Homematic,
 *   MQTT, …), so the manager can be narrowed to the connections that addon
 *   owns and to the kinds it serves. Unscoped, it lists every broker.
 *
 * Form builder throughout:
 *   The Add dialog's own fields (kind, name, restore-under-original-id) are a
 *   `ConfigUISchema` (`broker-identity-schema.ts`) drawn by the same
 *   `FormBuilder` as the kind's connection settings, not hand-rolled inputs.
 *
 * Delete guard:
 *   `BrokerInfo` exposes no `integrationId` / `inUse` flag today, so the
 *   manager cannot know whether an integration FKs a broker — delete is
 *   unconditional. (If the cap later surfaces an in-use flag, gate the
 *   button on it here.)
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogIn, LogOut, Plus, Pencil, Trash2, Wifi } from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  useBrokerList,
  useBrokerListProviders,
  useBrokerGetSettings,
  useBrokerAdd,
  useBrokerSetSettings,
  useBrokerTestConnection,
  useBrokerRemove,
  useConfirm,
} from '@camstack/ui-library'
import type { UnifiedBrokerInfo, UnifiedBrokerStatus, BrokerProviderInfo } from '@camstack/types'
import { FormBuilder } from '../form-builder/FormBuilder'
import { BrokerForm } from './BrokerForm'
import {
  IDENTITY_KIND,
  IDENTITY_NAME,
  IDENTITY_RESTORE,
  IDENTITY_RESTORE_ID,
  buildBrokerIdentitySchema,
  readBrokerIdentity,
} from './broker-identity-schema'
import { startBrokerInteractiveConnect } from '../../lib/broker-oauth-popup'
import { useTranslation } from 'react-i18next'

// ── Kind catalog ─────────────────────────────────────────────────────
// Each pickable entry is a `(addonId, kind, label)` triple. `addonId`
// is the provider that serves the kind — threaded as the system-
// collection selector so create routes to the owning provider. A static
// fallback supplies a human label for kinds that appear on existing
// brokers but aren't advertised by `listProviders` (addonId unknown).
//
// Connect/disconnect paths come ONLY from `listProviders` (cap data) —
// never from a kind/addonId branch in this file.
interface KindOption {
  readonly addonId?: string
  readonly kind: string
  readonly label: string
  readonly interactiveConnectPath?: string
  readonly interactiveDisconnectPath?: string
}

const STATIC_KIND_LABELS: Readonly<Record<string, string>> = {
  'home-assistant': 'Home Assistant',
  mqtt: 'MQTT',
}

function labelForKind(kind: string): string {
  return STATIC_KIND_LABELS[kind] ?? kind
}

// ── listProviders narrowing ──────────────────────────────────────────
// `useBrokerListProviders` is wire-typed by codegen; narrow defensively.
export function asProviderList(data: unknown): readonly BrokerProviderInfo[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (p): p is BrokerProviderInfo =>
      p !== null &&
      typeof p === 'object' &&
      typeof (p as { addonId?: unknown }).addonId === 'string' &&
      Array.isArray((p as { kinds?: unknown }).kinds),
  )
}

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

// ── List narrowing ───────────────────────────────────────────────────
// `useBrokerList` is wire-typed by codegen; narrow the array defensively
// rather than trusting the inferred shape blindly.
export function asBrokerList(data: unknown): readonly UnifiedBrokerInfo[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (b): b is UnifiedBrokerInfo =>
      b !== null && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string',
  )
}

// ── Dialog shell ─────────────────────────────────────────────────────
function BrokerDialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  readonly title: string
  readonly subtitle?: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="space-y-3 pr-1">{children}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ── Add dialog (identity form → kind's schema form) ──────────────────
function AddBrokerDialog({
  kinds,
  onClose,
  onDone,
}: {
  readonly kinds: readonly KindOption[]
  readonly onClose: () => void
  readonly onDone: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const identitySchema = useMemo(
    () => buildBrokerIdentitySchema(kinds.map((k) => ({ key: optionKeyOf(k), label: k.label }))),
    [kinds],
  )
  const [identity, setIdentity] = useState<Record<string, unknown>>(() => ({
    [IDENTITY_KIND]: optionKeyOf(kinds[0]),
    [IDENTITY_NAME]: '',
    [IDENTITY_RESTORE]: false,
    [IDENTITY_RESTORE_ID]: '',
  }))
  const [problem, setProblem] = useState<string | null>(null)
  const selected = kinds.find((k) => optionKeyOf(k) === identity[IDENTITY_KIND]) ?? kinds[0]
  const kind = selected?.kind ?? ''
  const addonId = selected?.addonId

  const connectPath = selected?.interactiveConnectPath

  const add = useBrokerAdd({
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
      const id =
        created !== null &&
        typeof created === 'object' &&
        typeof (created as { id?: unknown }).id === 'string'
          ? (created as { id: string }).id
          : null
      if (id !== null && connectPath !== undefined && connectPath.length > 0) {
        startBrokerInteractiveConnect(connectPath, id, () => {
          void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
        })
      }
      onDone()
    },
  })

  const handleSubmit = (settings: Record<string, unknown>): void => {
    const read = readBrokerIdentity(identity)
    if (!read.ok) {
      setProblem(read.problem)
      return
    }
    setProblem(null)
    const { name, restoreId } = read.identity
    add.mutate({
      kind,
      name,
      settings,
      ...(restoreId !== null ? { id: restoreId } : {}),
      ...(addonId !== undefined ? { addonId } : {}),
    })
  }

  return (
    <BrokerDialog
      title={t('brokers.brokerManager.addBroker', 'Add broker')}
      subtitle={t(
        'brokers.brokerManager.registerAMessageBrokerFor',
        'Register a message broker for exporters and automations.',
      )}
      onClose={add.isPending ? () => {} : onClose}
    >
      <FormBuilder schema={identitySchema} values={identity} onChange={setIdentity} />
      {problem !== null && <ErrorBox message={problem} />}
      {add.isError && (
        <ErrorBox message={add.error instanceof Error ? add.error.message : String(add.error)} />
      )}
      {kind && (
        <BrokerForm
          key={optionKeyOf(selected)}
          kind={kind}
          {...(addonId !== undefined ? { addonId } : {})}
          onSubmit={handleSubmit}
          onCancel={onClose}
          submitLabel={
            add.isPending
              ? t('brokers.brokerManager.adding', 'Adding…')
              : t('brokers.brokerManager.addBroker', 'Add broker')
          }
          disabled={add.isPending}
        />
      )}
    </BrokerDialog>
  )
}

/**
 * A kind option's key, `addonId::kind`: a kind offered by two providers stays
 * two options, and the key resolves back to the option (carrying `addonId`)
 * that routes the create. Keying the settings form by it also resets the form
 * when the kind changes, so one kind's values never leak into another's.
 */
function optionKeyOf(k: KindOption | undefined): string {
  return k === undefined ? '' : `${k.addonId ?? ''}::${k.kind}`
}

// ── Edit dialog (load settings → schema form) ────────────────────────
function EditBrokerDialog({
  broker,
  onClose,
  onDone,
}: {
  readonly broker: UnifiedBrokerInfo
  readonly onClose: () => void
  readonly onDone: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // Route id-keyed reads/writes to the owning provider via the addonId
  // selector — without it, getSettings/setSettings hit the first
  // registered broker provider and miss a broker it doesn't own.
  const settingsQuery = useBrokerGetSettings({ id: broker.id, addonId: broker.addonId })
  const setSettings = useBrokerSetSettings({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
      void queryClient.invalidateQueries({
        queryKey: [
          ['broker', 'getSettings'],
          { input: { id: broker.id, addonId: broker.addonId } },
        ],
      })
      onDone()
    },
  })

  const initialValues = useMemo<Record<string, unknown>>(() => {
    const raw = settingsQuery.data
    return raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
  }, [settingsQuery.data])

  const handleSubmit = (settings: Record<string, unknown>): void => {
    setSettings.mutate({ id: broker.id, settings, addonId: broker.addonId })
  }

  return (
    <BrokerDialog
      title={t('brokers.brokerManager.edit', 'Edit {{name}}', { name: broker.name })}
      subtitle={`${labelForKind(broker.kind)} · ${broker.id}`}
      onClose={setSettings.isPending ? () => {} : onClose}
    >
      {settingsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{' '}
          {t('brokers.brokerManager.loadingSettings')}
        </div>
      ) : settingsQuery.isError ? (
        // Do NOT render a save-capable form with empty values here — a Save
        // would overwrite the broker's real credentials with `{}`. Show the
        // error instead and offer only a way to dismiss the dialog.
        <div className="space-y-3">
          <ErrorBox
            message={t('brokers.brokerManager.loadSettingsFailed', {
              message:
                settingsQuery.error instanceof Error
                  ? settingsQuery.error.message
                  : t('common.unknownError'),
            })}
          />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.close', 'Close')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {setSettings.isError && (
            <ErrorBox
              message={
                setSettings.error instanceof Error
                  ? setSettings.error.message
                  : String(setSettings.error)
              }
            />
          )}
          <BrokerForm
            kind={broker.kind}
            addonId={broker.addonId}
            brokerId={broker.id}
            initialValues={initialValues}
            onSubmit={handleSubmit}
            onCancel={onClose}
            submitLabel={
              setSettings.isPending
                ? t('brokers.brokerManager.saving', 'Saving…')
                : t('common.save', 'Save')
            }
            disabled={setSettings.isPending}
          />
        </div>
      )}
    </BrokerDialog>
  )
}

// ── Row ──────────────────────────────────────────────────────────────
function BrokerRow({
  broker,
  interactiveConnectPath,
  interactiveDisconnectPath,
  onEdit,
}: {
  readonly broker: UnifiedBrokerInfo
  /** From `listProviders` for this broker's kind — undefined = no Sign-in. */
  readonly interactiveConnectPath?: string
  /** From `listProviders` — undefined = no Sign-out. */
  readonly interactiveDisconnectPath?: string
  readonly onEdit: (broker: UnifiedBrokerInfo) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const test = useBrokerTestConnection({
    onSuccess: (result) =>
      setTestResult(result.ok ? { ok: true } : { ok: false, error: result.error }),
    onError: (err) =>
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) }),
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
      <td className="px-3 py-2 text-xs text-foreground-subtle">{labelForKind(broker.kind)}</td>
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
                  void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
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
                  void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
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
  const providersQuery = useBrokerListProviders()
  const brokers = useMemo(
    () =>
      asBrokerList(listQuery.data).filter((b) => addonId === undefined || b.addonId === addonId),
    [listQuery.data, addonId],
  )
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<UnifiedBrokerInfo | null>(null)

  // Build the Add picker from LIVE `listProviders()` data — each entry
  // carries its owning `addonId` so create routes to that provider. Keyed
  // by `addonId::kind` so the same kind from two providers stays
  // distinct. A kind present on an existing broker but NOT advertised by
  // any provider still gets a fallback entry (no addonId) so edit works.
  const kinds = useMemo<readonly KindOption[]>(() => {
    const seen = new Map<string, KindOption>()
    for (const provider of asProviderList(providersQuery.data)) {
      if (addonId !== undefined && provider.addonId !== addonId) continue
      for (const k of provider.kinds) {
        const connect =
          typeof k.interactiveConnectPath === 'string' && k.interactiveConnectPath.length > 0
            ? k.interactiveConnectPath
            : undefined
        const disconnect =
          typeof k.interactiveDisconnectPath === 'string' && k.interactiveDisconnectPath.length > 0
            ? k.interactiveDisconnectPath
            : undefined
        seen.set(`${provider.addonId}::${k.kind}`, {
          addonId: provider.addonId,
          kind: k.kind,
          label: k.label,
          ...(connect !== undefined ? { interactiveConnectPath: connect } : {}),
          ...(disconnect !== undefined ? { interactiveDisconnectPath: disconnect } : {}),
        })
      }
    }
    for (const b of brokers) {
      const hasKind = [...seen.values()].some((k) => k.kind === b.kind)
      if (!hasKind) seen.set(`::${b.kind}`, { kind: b.kind, label: labelForKind(b.kind) })
    }
    return [...seen.values()]
  }, [brokers, providersQuery.data, addonId])

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
                  onEdit={setEditing}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddBrokerDialog
          kinds={kinds}
          onClose={() => setAdding(false)}
          onDone={() => setAdding(false)}
        />
      )}
      {editing && (
        <EditBrokerDialog
          broker={editing}
          onClose={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  )
}
