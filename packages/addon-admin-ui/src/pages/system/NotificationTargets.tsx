/**
 * Notification targets management page (T14).
 *
 * One page, three flows, ALL driven by the `notification-output` cap — no
 * per-kind UI code:
 *   1. LIST     — `NcListTable` rows (click opens editor); toggle / test /
 *                 duplicate / delete stay in row controls.
 *   2. ADD      — kind picker (`ItemFormDialog`) → config form
 *                 (`ItemFormDialog` + `ConfigFormBuilder`) → `upsertTarget`.
 *   3. EDIT     — same form dialog; secrets render blank with a placeholder
 *                 and are only overwritten when re-typed (`secretMergeDiff`).
 *
 * Open state stays on the existing deep-link keys (`?target=` / `?kind=`) via
 * `useItemFormUrl({ editKey: 'target' })` plus the kind helpers in
 * `notification-targets-url.ts` (create is `?target=new`, not `?new=1`).
 *
 * Every mutation threads the target/kind `addonId` as a top-level sibling
 * key so the collection cap router dispatches to the ONE owning provider.
 * The two array queries (`listTargets` / `listTargetKinds`) carry no
 * addonId → the generated mount concat-fans them across every provider.
 */

import type {
  ConfigSelectField,
  ConfigUISchema,
  ProbeTargetConfigResult,
  Target,
  TargetKind,
} from '@camstack/types'
import {
  Badge,
  Button,
  ConfigFormBuilder,
  ErrorBox,
  ItemFormDialog,
  Select,
  Switch,
  useBrokerList,
  useDiscoveredOptions,
  useItemFormUrl,
  useSystem,
  useUrlQueryParam,
} from '@camstack/ui-library'
import type { DataColumn } from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Bell, Copy, Loader2, Plus, Send, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { NotificationTestPanel } from './NotificationTestPanel'
import {
  NcListEmpty,
  NcListLoading,
  NcListNameCell,
  NcListRowControls,
  NcListTable,
} from './notification-list-chrome'
import {
  defaultBrokerId,
  nextAutoName,
  targetFormDefaultKeys,
  collectFieldLabels,
  collectSecretKeys,
  duplicateTargetName,
  editedDestinationKeys,
  groupKindsByAddon,
  isSecretRestoreRefusal,
  liveFormValues,
  redactedFormValues,
  secretMergeDiff,
  secretsToReenter,
  withRequiredSecrets,
  withStoredSecretPlaceholders,
} from './notification-targets.helpers'
import { TARGET_KIND_PARAM, TARGET_NEW } from './notification-targets-url'
import { KindIcon, type TargetKindWithIcon } from './target-kind-icon'
import { TargetSecretNotice } from './target-secret-notice'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const TARGETS_QUERY_KEY = ['notificationOutput', 'listTargets'] as const
const KINDS_QUERY_KEY = ['notificationOutput', 'listTargetKinds'] as const
const USERS_QUERY_KEY = ['userManagement', 'listUsers'] as const

/** The user fields the Owner column and picker need. */
interface NotificationTargetUser {
  readonly id: string
  readonly username: string
}

type EditorState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'pick-kind' }
  | {
      readonly mode: 'form'
      readonly kind: TargetKindWithIcon
      /** Existing row when editing; null when creating or duplicating. */
      readonly target: Target | null
      /**
       * Duplicate source — secrets stay on the hub; the form is prefilled and
       * save / probe / discover restore them via `cloneSecretsFrom` / `targetId`.
       */
      readonly cloneFrom: Target | null
    }

// ── Targets table ───────────────────────────────────────────────────

/**
 * The key a target's owner is stored under, INSIDE its open `config` blob.
 * `notification-output.Target` has no first-class `ownerUserId` field, so the
 * viewer's `nc.upsertMyTarget` stamps it here; this page reads the same key so
 * an admin can finally SEE (and set) who a target belongs to. Keep in sync with
 * `addon-notifiers/src/nc-target-actions.ts`.
 */
export const TARGET_OWNER_KEY = 'ownerUserId'

/** The owner userId a target carries, or null for a system/global target. */
export function targetOwnerUserId(target: Target): string | null {
  const raw = target.config[TARGET_OWNER_KEY]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

interface TargetColumnsDeps {
  readonly kindByKey: ReadonlyMap<string, TargetKindWithIcon>
  readonly userNameById: ReadonlyMap<string, string>
  readonly onToggle: (target: Target, enabled: boolean) => void
  readonly onTest: (target: Target) => void
  readonly onOpen: (target: Target, kind: TargetKindWithIcon) => void
  readonly onDuplicate: (target: Target, kind: TargetKindWithIcon) => void
  readonly onDelete: (target: Target) => void
}

function targetColumns(deps: TargetColumnsDeps): readonly DataColumn<Target>[] {
  return [
    {
      key: 'name',
      header: i18n.t('system.notificationTargets.target', 'Target'),
      render: (target) => {
        const kind = deps.kindByKey.get(target.kind)
        return (
          <span className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-xs"
              title={kind?.label ?? target.kind}
            >
              <KindIcon kind={kind} imgClassName="h-5 w-5 object-contain" fallbackClassName="" />
            </span>
            <NcListNameCell
              name={target.name}
              enabled={target.enabled}
              {...(kind !== undefined ? { onOpen: () => deps.onOpen(target, kind) } : {})}
            />
          </span>
        )
      },
    },
    {
      key: 'kind',
      header: i18n.t('system.notificationTargets.kind', 'Kind'),
      nowrap: true,
      render: (target) => (
        <span className="text-[11px] text-foreground-subtle">
          {deps.kindByKey.get(target.kind)?.label ?? target.kind}
        </span>
      ),
    },
    {
      key: 'owner',
      header: i18n.t('system.notificationTargets.owner', 'Owner'),
      nowrap: true,
      render: (target) => {
        const owner = targetOwnerUserId(target)
        return owner === null ? (
          <Badge variant="default">{i18n.t('common.systemWord')}</Badge>
        ) : (
          <span className="text-[11px] text-foreground">
            {deps.userNameById.get(owner) ?? owner}
          </span>
        )
      },
    },
    {
      key: 'enabled',
      header: i18n.t('system.notificationTargets.on', 'On'),
      align: 'center',
      nowrap: true,
      render: (target) => (
        <NcListRowControls>
          <Switch
            checked={target.enabled}
            onCheckedChange={(next) => deps.onToggle(target, next)}
            aria-label={i18n.t('system.notificationTargets.toggle', 'toggle {{name}}', {
              name: target.name,
            })}
          />
        </NcListRowControls>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      render: (target) => {
        const kind = deps.kindByKey.get(target.kind)
        return (
          <NcListRowControls className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={!kind}
              onClick={() => deps.onTest(target)}
              title={i18n.t('system.notificationTargets.test', 'Test')}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={!kind}
              onClick={() => kind && deps.onDuplicate(target, kind)}
              title={i18n.t('system.notificationTargets.duplicate', 'Duplicate')}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => deps.onDelete(target)}
              title={i18n.t('common.delete', 'Delete')}
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
          </NcListRowControls>
        )
      },
    },
  ]
}

export interface NotificationTargetsPageProps {
  /** Page-header Add — open the kind picker once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
  /** When true, Add lives on the Notifications header — no local Add. */
  readonly headerOwnsCreate?: boolean
}

export function NotificationTargetsPage({
  createRequested = false,
  onCreateConsumed,
  headerOwnsCreate = false,
}: NotificationTargetsPageProps = {}) {
  const { t } = useTranslation()
  const system = useSystem()
  // `?target=<id|new>` via the shared hook; `?kind=` stays beside it so create
  // deep links (`?target=new&kind=whatsapp`) keep working.
  const {
    state: formUrl,
    openEdit: openTargetUrl,
    close: closeTargetUrl,
  } = useItemFormUrl({ editKey: 'target' })
  const [kindParam, setKindParam] = useUrlQueryParam(TARGET_KIND_PARAM)
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [testTarget, setTestTarget] = useState<Target | null>(null)
  const restoredTargetRef = useRef<string | null>(null)

  const targetsQuery = useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: (): Promise<readonly Target[]> =>
      system.trpcClient.notificationOutput.listTargets.query({}),
  })
  const kindsQuery = useQuery({
    queryKey: KINDS_QUERY_KEY,
    queryFn: async (): Promise<readonly TargetKindWithIcon[]> => {
      const raw = await system.trpcClient.notificationOutput.listTargetKinds.query({})
      // Two documented type boundaries at the cap seam:
      //  - `configSchema` is `z.unknown()` but a `ConfigUISchema` by contract
      //    (see notification-output.cap.ts header) — re-tighten it.
      //  - `iconUrl` is a structural pass-through field the provider stamps
      //    but `TargetKindSchema` omits — re-attach it from the raw row.
      return raw.map((k) => {
        const iconUrl = (k as { readonly iconUrl?: string }).iconUrl
        return {
          ...k,
          configSchema: k.configSchema as ConfigUISchema,
          iconUrl,
        }
      })
    },
  })

  const kinds = useMemo(() => kindsQuery.data ?? [], [kindsQuery.data])
  const kindByKey = useMemo(() => {
    const m = new Map<string, TargetKindWithIcon>()
    for (const k of kinds) m.set(k.kind, k)
    return m
  }, [kinds])

  // userId → username, so the Owner column shows a name rather than a UUID.
  // Queried through `system.trpcClient` like every other read on this page —
  // the generated React hook needs a tRPC provider this page never mounts in.
  const usersQuery = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: (): Promise<readonly NotificationTargetUser[]> =>
      system.trpcClient.userManagement.listUsers.query(),
  })
  const userNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of usersQuery.data ?? []) m.set(u.id, u.username)
    return m
  }, [usersQuery.data])

  const setEnabled = useMutation({
    mutationFn: (vars: { readonly target: Target; readonly enabled: boolean }) =>
      system.trpcClient.notificationOutput.setTargetEnabled.mutate({
        addonId: vars.target.addonId,
        targetId: vars.target.id,
        enabled: vars.enabled,
      }),
    onSuccess: () => void targetsQuery.refetch(),
  })

  const deleteTarget = useMutation({
    mutationFn: (target: Target) =>
      system.trpcClient.notificationOutput.deleteTarget.mutate({
        addonId: target.addonId,
        targetId: target.id,
      }),
    onSuccess: () => void targetsQuery.refetch(),
  })

  const testKind = testTarget ? kindByKey.get(testTarget.kind) : undefined

  const closeEditor = (): void => {
    // Stamp the id we are leaving so a stale `?target=` cannot reopen the
    // dialog through the deep-link restore effect (Cancel felt like two presses).
    if (formUrl.mode === 'edit') restoredTargetRef.current = formUrl.id
    setEditor({ mode: 'closed' })
    closeTargetUrl()
    setKindParam(null)
  }

  const openPickKind = (): void => {
    restoredTargetRef.current = TARGET_NEW
    setEditor({ mode: 'pick-kind' })
    openTargetUrl(TARGET_NEW)
    setKindParam(null)
  }

  useEffect(() => {
    if (!createRequested) return
    openPickKind()
    onCreateConsumed?.()
    // Intentionally only react to the page-header request pulse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequested])

  const openCreate = (kind: TargetKindWithIcon): void => {
    restoredTargetRef.current = `${TARGET_NEW}:${kind.kind}`
    setEditor({ mode: 'form', kind, target: null, cloneFrom: null })
    openTargetUrl(TARGET_NEW)
    setKindParam(kind.kind)
  }

  const openEdit = (target: Target, kind: TargetKindWithIcon): void => {
    restoredTargetRef.current = target.id
    setEditor({ mode: 'form', kind, target, cloneFrom: null })
    openTargetUrl(target.id)
    setKindParam(null)
  }

  const openDuplicate = (target: Target, kind: TargetKindWithIcon): void => {
    restoredTargetRef.current = `${TARGET_NEW}:${kind.kind}`
    setEditor({ mode: 'form', kind, target: null, cloneFrom: target })
    openTargetUrl(TARGET_NEW)
    setKindParam(kind.kind)
  }

  // Restore an open editor from `?target=` after a refresh / deep link.
  useEffect(() => {
    if (editor.mode !== 'closed') return
    if (formUrl.mode !== 'edit') {
      if (formUrl.mode === 'closed') restoredTargetRef.current = null
      return
    }
    const targetParam = formUrl.id
    if (restoredTargetRef.current === targetParam) return
    if (targetParam === TARGET_NEW) {
      if (kindParam === null || kindParam.length === 0) {
        restoredTargetRef.current = TARGET_NEW
        setEditor({ mode: 'pick-kind' })
        return
      }
      const kind = kindByKey.get(kindParam)
      if (kind === undefined) return
      restoredTargetRef.current = `${TARGET_NEW}:${kindParam}`
      setEditor({ mode: 'form', kind, target: null, cloneFrom: null })
      return
    }
    const hit = targetsQuery.data?.find((t) => t.id === targetParam)
    if (hit === undefined) return
    const kind = kindByKey.get(hit.kind)
    if (kind === undefined) return
    restoredTargetRef.current = targetParam
    setEditor({ mode: 'form', kind, target: hit, cloneFrom: null })
  }, [editor.mode, formUrl, kindParam, targetsQuery.data, kindByKey])

  return (
    <AdminPage
      embedded
      icon={Bell}
      title={t('system.notificationTargets.notificationTargets', 'Notification Targets')}
      subtitle={t(
        'system.notificationTargets.deliverNotificationsToNtfyPushover',
        "Deliver notifications to ntfy, Pushover, Telegram, Home Assistant and more. Each target's kind declares its capabilities; the test panel shows exactly what a message degrades to.",
      )}
    >
      {!headerOwnsCreate ? (
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" type="button" onClick={openPickKind}>
            <Plus className="h-3.5 w-3.5" />
            {t('system.notificationTargets.addTarget', 'Add target')}
          </Button>
        </div>
      ) : null}
      {targetsQuery.isLoading && <NcListLoading />}

      {targetsQuery.isError && !targetsQuery.isLoading && (
        <ErrorBox
          title={t('system.notificationTargets.failedToLoadTargets', 'Failed to load targets')}
          message={
            targetsQuery.error instanceof Error
              ? targetsQuery.error.message
              : t('system.notificationTargets.unknownError', 'Unknown error')
          }
          onRetry={() => void targetsQuery.refetch()}
        />
      )}

      {!targetsQuery.isLoading &&
        !targetsQuery.isError &&
        (targetsQuery.data ?? []).length === 0 && (
          <NcListEmpty>
            {t(
              'system.notificationTargets.noNotificationTargetsYetClick',
              'No notification targets yet. Click "Add target" to configure one.',
            )}
          </NcListEmpty>
        )}

      {(targetsQuery.data ?? []).length > 0 && (
        <NcListTable<Target>
          columns={targetColumns({
            kindByKey,
            userNameById,
            onToggle: (target, enabled) => setEnabled.mutate({ target, enabled }),
            onTest: setTestTarget,
            onOpen: openEdit,
            onDuplicate: openDuplicate,
            onDelete: (target) => deleteTarget.mutate(target),
          })}
          rows={targetsQuery.data ?? []}
          rowKey={(t) => t.id}
          minWidthPx={720}
          onRowClick={(target) => {
            const kind = kindByKey.get(target.kind)
            if (kind !== undefined) openEdit(target, kind)
          }}
        />
      )}

      {editor.mode === 'pick-kind' && (
        <KindPicker kinds={kinds} onCancel={closeEditor} onPick={openCreate} />
      )}

      {editor.mode === 'form' && (
        <TargetForm
          key={
            editor.target?.id ??
            (editor.cloneFrom !== null ? `dup:${editor.cloneFrom.id}` : `new:${editor.kind.kind}`)
          }
          kind={editor.kind}
          target={editor.target}
          cloneFrom={editor.cloneFrom}
          users={usersQuery.data ?? []}
          onCancel={closeEditor}
          onSaved={() => {
            closeEditor()
            void targetsQuery.refetch()
          }}
        />
      )}

      {testTarget && testKind && (
        <NotificationTestPanel
          target={testTarget}
          kind={testKind}
          open
          onClose={() => setTestTarget(null)}
        />
      )}
    </AdminPage>
  )
}

// ── Kind picker (grouped by addon) ──────────────────────────────────

function KindPicker({
  kinds,
  onPick,
  onCancel,
}: {
  readonly kinds: readonly TargetKindWithIcon[]
  readonly onPick: (kind: TargetKindWithIcon) => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupKindsByAddon(kinds), [kinds])
  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={t('system.notificationTargets.chooseANotificationKind', 'Choose a notification kind')}
      width="lg"
    >
      <div className="space-y-4">
        {groups.length === 0 && (
          <p className="text-xs text-foreground-subtle">
            {t(
              'system.notificationTargets.noNotificationProvidersAreInstalled',
              'No notification providers are installed. Install the notifiers addon (or connect Home Assistant) to add targets.',
            )}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.addonId}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle mb-1.5">
              {group.addonId}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {group.kinds.map((kind) => (
                // ui-check-ok: kind tile — vertical icon+label grid, not a toolbar Button
                <button
                  key={`${group.addonId}:${kind.kind}`}
                  type="button"
                  onClick={() => onPick(kind)}
                  className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3 text-xs hover:border-primary/50 hover:bg-surface-hover transition-colors"
                >
                  <KindIcon
                    kind={kind}
                    imgClassName="h-7 w-7 object-contain"
                    fallbackClassName="text-lg leading-7"
                  />
                  <span className="font-medium text-foreground">{kind.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ItemFormDialog>
  )
}

/** Stand-in when the kind has no discovered field: the hook stays idle. */
const NO_DEVICE_FIELD: ConfigSelectField = {
  type: 'select',
  key: '',
  label: '',
  options: [],
}

// ── Add / edit form ─────────────────────────────────────────────────

function TargetForm({
  kind,
  target,
  cloneFrom,
  users,
  onSaved,
  onCancel,
}: {
  readonly kind: TargetKindWithIcon
  readonly target: Target | null
  readonly cloneFrom: Target | null
  /** Owner candidates — queried once by the page, not re-fetched here. */
  readonly users: readonly NotificationTargetUser[]
  readonly onSaved: () => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation()
  const system = useSystem()
  const secretKeys = useMemo(() => collectSecretKeys(kind.configSchema), [kind.configSchema])
  /** Config the form was seeded from (edit row or duplicate source). */
  const seedTarget = target ?? cloneFrom
  /** Hub row to hydrate via unredacted `getTarget`. */
  const secretsSourceId = target?.id ?? cloneFrom?.id

  const isCreate = target === null && cloneFrom === null
  const [nameEdited, setNameEdited] = useState(false)
  const [name, setName] = useState(() =>
    cloneFrom !== null ? duplicateTargetName(cloneFrom.name) : (target?.name ?? kind.label),
  )
  // Start from the redacted list row; `getTarget` replaces secrets with live values.
  const [originalConfig, setOriginalConfig] = useState<Record<string, unknown>>(
    () => seedTarget?.config ?? {},
  )
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    seedTarget ? redactedFormValues(seedTarget.config, secretKeys) : {},
  )
  const [secretsReady, setSecretsReady] = useState(secretsSourceId === undefined)
  const [error, setError] = useState<string | null>(null)
  // The hub's ADR 0634 refusal, kept apart from `error`: it is not "try
  // again" — the same save is refused again until the secret is re-typed.
  const [refusal, setRefusal] = useState<string | null>(null)
  // Ownership: '' = a SYSTEM target (no owner), else the owning user's id.
  // Stored inside the open `config` blob because `Target` has no first-class
  // owner field — the same key the viewer's `nc.upsertMyTarget` stamps.
  const [ownerUserId, setOwnerUserId] = useState<string>(
    seedTarget ? (targetOwnerUserId(seedTarget) ?? '') : '',
  )

  // New target only: first broker pre-selected, name derived from the device.
  const defaultKeys = useMemo(() => targetFormDefaultKeys(kind.configSchema), [kind.configSchema])
  const brokerList = useBrokerList(
    { kind: defaultKeys.brokerKind ?? '' },
    { enabled: isCreate && defaultKeys.brokerKind !== null },
  )
  const discovered = useDiscoveredOptions(defaultKeys.deviceField ?? NO_DEVICE_FIELD, values)

  useEffect(() => {
    if (!isCreate || defaultKeys.brokerKey === null || defaultKeys.brokerKind === null) return
    const brokerId = defaultBrokerId(
      brokerList.data,
      defaultKeys.brokerKind,
      values[defaultKeys.brokerKey],
    )
    if (brokerId === null) return
    const key = defaultKeys.brokerKey
    setValues((prev) =>
      typeof prev[key] === 'string' && prev[key] !== '' ? prev : { ...prev, [key]: brokerId },
    )
  }, [isCreate, defaultKeys, brokerList.data, values])

  const pickedDeviceId =
    defaultKeys.deviceField === null ? undefined : values[defaultKeys.deviceField.key]
  const pickedDeviceName =
    discovered.found.find((option) => option.value === pickedDeviceId)?.label ?? null
  useEffect(() => {
    if (!isCreate) return
    const next = nextAutoName(name, nameEdited, kind.label, pickedDeviceName)
    if (next !== null) setName(next)
  }, [isCreate, name, nameEdited, kind.label, pickedDeviceName])

  useEffect(() => {
    if (secretsSourceId === undefined) return
    let cancelled = false
    void system.trpcClient.notificationOutput.getTarget
      .query({ addonId: kind.addonId, targetId: secretsSourceId })
      .then((full) => {
        if (cancelled) return
        const live = liveFormValues(full.config)
        setOriginalConfig(live)
        setValues(live)
        setOwnerUserId(targetOwnerUserId(full) ?? '')
        setSecretsReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load target secrets')
        setSecretsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [secretsSourceId, kind.addonId, system.trpcClient])

  /** Wire config for probe — includes live secrets once hydrated. */
  const wireConfig = (): Record<string, unknown> =>
    secretMergeDiff(values, originalConfig, secretKeys)

  const [probeResult, setProbeResult] = useState<ProbeTargetConfigResult | null>(null)
  const supportsProbe = kind.kind === 'whatsapp'
  const probe = useMutation({
    mutationFn: (): Promise<ProbeTargetConfigResult> =>
      system.trpcClient.notificationOutput.probeTargetConfig.mutate({
        addonId: kind.addonId,
        kind: kind.kind,
        config: wireConfig(),
        ...(secretsSourceId !== undefined ? { targetId: secretsSourceId } : {}),
      }),
    onSuccess: (data) => setProbeResult(data),
    onError: (err: unknown) => {
      setProbeResult(null)
      setError(err instanceof Error ? err.message : 'Connection test failed')
    },
  })

  const save = useMutation({
    mutationFn: (): Promise<Target> => {
      const merged = secretMergeDiff(values, originalConfig, secretKeys)
      // A system target must carry NO owner key at all (absent = system), so a
      // target demoted back to system does not keep a stale owner.
      const { [TARGET_OWNER_KEY]: _dropped, ...withoutOwner } = merged
      const config =
        ownerUserId === '' ? withoutOwner : { ...withoutOwner, [TARGET_OWNER_KEY]: ownerUserId }
      const nextTarget: Target = {
        id: target?.id ?? `${kind.kind}-${Date.now()}`,
        name,
        kind: kind.kind,
        addonId: kind.addonId,
        enabled: target?.enabled ?? true,
        config,
      }
      return system.trpcClient.notificationOutput.upsertTarget.mutate({
        addonId: kind.addonId,
        target: nextTarget,
        ...(cloneFrom !== null ? { cloneSecretsFrom: cloneFrom.id } : {}),
      })
    },
    onSuccess: onSaved,
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed'
      if (isSecretRestoreRefusal(message)) setRefusal(message)
      else setError(message)
    },
  })

  // Edit / duplicate: a stored secret the hub could refuse to reuse after a
  // destination change. Fresh create has no source.
  const labels = useMemo(() => collectFieldLabels(kind.configSchema), [kind.configSchema])
  const edited = useMemo(
    () =>
      secretsSourceId === undefined
        ? []
        : editedDestinationKeys(values, originalConfig, secretKeys, kind.destinationKeys),
    [secretsSourceId, values, originalConfig, secretKeys, kind.destinationKeys],
  )
  const reenter = useMemo(
    () =>
      secretsSourceId !== undefined && (refusal !== null || edited.length > 0)
        ? secretsToReenter(values, originalConfig, secretKeys)
        : [],
    [secretsSourceId, refusal, edited, values, originalConfig, secretKeys],
  )
  const formSchema = useMemo(() => {
    const required = withRequiredSecrets(kind.configSchema, reenter)
    return withStoredSecretPlaceholders(required, originalConfig, secretKeys)
  }, [kind.configSchema, reenter, originalConfig, secretKeys])
  const labelOf = (key: string): string => labels.get(key) ?? key

  const title = target
    ? `Edit ${target.name}`
    : cloneFrom
      ? `Duplicate ${cloneFrom.name}`
      : `Add ${kind.label} target`

  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={title}
      icon={Bell}
      width="lg"
      testId="target-form-dialog"
      beforeBody={
        <>
          {error != null && error !== '' && (
            <div
              className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
              data-testid="target-form-error"
            >
              {error}
            </div>
          )}
          <div className="mb-3 flex items-center gap-2 text-xs text-foreground-subtle">
            <KindIcon
              kind={kind}
              imgClassName="h-5 w-5 object-contain shrink-0"
              fallbackClassName="text-lg leading-5"
            />
            <span>{kind.label}</span>
          </div>
        </>
      }
      footer={
        <Button
          size="sm"
          type="button"
          disabled={save.isPending || !secretsReady || name.trim().length === 0}
          onClick={() => {
            setError(null)
            setRefusal(null)
            save.mutate()
          }}
        >
          {save.isPending || !secretsReady ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          {target
            ? t('system.notificationTargets.saveChanges', 'Save changes')
            : t('system.notificationTargets.createTarget', 'Create target')}
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-[11px] font-medium text-foreground mb-1">
            {t('system.notificationTargets.name', 'Name')}
          </label>
          <input
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none"
            value={name}
            onChange={(e) => {
              setNameEdited(true)
              setName(e.target.value)
            }}
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium text-foreground mb-1">
            {t('system.notificationTargets.owner', 'Owner')}
          </label>
          <Select
            value={ownerUserId}
            options={[
              {
                value: '',
                label: t(
                  'system.notificationTargets.systemSharedAdminManaged',
                  'System (shared, admin-managed)',
                ),
              },
              ...users.map((u) => ({ value: u.id, label: u.username })),
            ]}
            onChange={(e) => setOwnerUserId(e.target.value)}
          />
          <p className="mt-0.5 text-[10px] text-foreground-subtle">
            {t(
              'system.notificationTargets.aUserOwnedTargetBelongs',
              'A user-owned target belongs to that user: it shows in their viewer and their own rules may deliver to it. System targets stay admin-managed.',
            )}
          </p>
        </div>

        {secretKeys.length > 0 && secretsSourceId !== undefined && (
          <p className="text-[10px] text-foreground-subtle">
            {t(
              'system.notificationTargets.storedSecretsLoadIntoThe',
              'Stored secrets load into the masked fields (eye to reveal). Clear a field to leave the stored value unchanged on save; type a new value to replace it.',
            )}
          </p>
        )}

        <TargetSecretNotice
          refusal={refusal}
          edited={edited.map(labelOf)}
          reenter={reenter.map(labelOf)}
        />

        <ConfigFormBuilder schema={formSchema} values={values} onChange={setValues} />

        {supportsProbe && (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={probe.isPending}
              onClick={() => {
                setError(null)
                setProbeResult(null)
                probe.mutate()
              }}
            >
              {probe.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {t('system.notificationTargets.testConnection', 'Test connection')}
            </Button>
            {probeResult !== null && (
              <p
                className={probeResult.ok ? 'text-[11px] text-success' : 'text-[11px] text-danger'}
                data-testid="target-probe-result"
              >
                {probeResult.ok
                  ? t('system.notificationTargets.connected', 'Connected — {{value1}}', {
                      value1: probeResult.stateInstance ?? 'authorized',
                    })
                  : (probeResult.error ??
                    t('system.notificationTargets.connectionFailed', 'Connection failed'))}
                {probeResult.resolvedUrl.length > 0 ? ` · ${probeResult.resolvedUrl}` : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </ItemFormDialog>
  )
}

export default NotificationTargetsPage
