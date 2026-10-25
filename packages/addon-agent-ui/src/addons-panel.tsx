/**
 * The ONE addon list (D841): a row per addon with its version, its update
 * (D840), the runner that hosts it and its status. A runner that hosts no known
 * addon is still a row. The addon → runner join is made by the agent backend
 * (`/api/agent/addon-runtime`, from the process service's own `addonIds`); this
 * file only draws it. The version columns read `/api/agent/addon-updates`, keyed
 * by package name.
 *
 * Update asks the HUB to bring the package on this node to the hub's version —
 * the hub's version is the one its reconcile restores, so it is the only update
 * that stays (`server/backend/src/agent/agent-hub-addon-update.ts`).
 */
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  ErrorBox,
  IconButton,
  SECTION_BODY,
  SectionCard,
  StatusBadge,
} from '@camstack/ui-library'
import { Package, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { UnauthorizedError, fetchJson, postJson } from './api-client'
import { type AgentUiT, translate, useT } from './i18n'

// ── Wire types — mirror `agent-addon-runtime.ts` / `agent-update-routes.ts` ──

export interface AddonRuntimeRunner {
  readonly name: string
  readonly pid: number
  readonly state: string
  readonly groupId: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
  readonly addonIds: readonly string[]
}

export interface AddonRuntimeRow {
  readonly key: string
  readonly kind: 'addon' | 'runner'
  readonly addonId: string | null
  readonly packageName: string | null
  readonly version: string | null
  readonly status: string
  readonly runner: AddonRuntimeRunner | null
}

export interface PackageUpdateProgress {
  readonly status: 'running' | 'done' | 'failed'
  readonly targetVersion: string
  readonly message: string | null
}

export interface AddonUpdateRow {
  readonly packageName: string
  readonly installedVersion: string | null
  readonly latestVersion: string | null
  readonly updateAvailable: boolean
  readonly error: string | null
  readonly hubVersion: string | null
  readonly behindHub: boolean
  readonly update: PackageUpdateProgress | null
}

export type AddonUpdatesResponse =
  | {
      readonly available: true
      readonly entries: readonly AddonUpdateRow[]
      readonly error: string | null
      readonly hubVersionsError: string | null
    }
  | { readonly available: false; readonly reason: string }

interface UpdateStartResult {
  readonly started: boolean
  readonly message: string | null
}

// ── Pure helpers ────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type BadgeStatus = 'running' | 'error' | 'stopped' | 'unknown'

export function statusBadge(status: string): BadgeStatus {
  if (status === 'running') return 'running'
  if (status === 'crashed' || status === 'error' || status === 'failed') return 'error'
  if (status === 'stopped') return 'stopped'
  return 'unknown'
}

/** How many OTHER addons share this runner (0 when it is alone). */
export function sharedCount(runner: AddonRuntimeRunner): number {
  return Math.max(0, runner.addonIds.length - 1)
}

// ── Cells ───────────────────────────────────────────────────────────────────

function VersionCell({
  row,
  update,
  t,
}: {
  readonly row: AddonRuntimeRow
  readonly update: AddonUpdateRow | undefined
  readonly t: AgentUiT
}) {
  if (row.kind === 'runner') return <span className="text-foreground-subtle">—</span>
  const installed = update?.installedVersion ?? row.version
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono text-[11px]">
        {installed ?? '—'}
        {update?.behindHub === true && update.hubVersion !== null ? ` → ${update.hubVersion}` : ''}
      </span>
      {update?.update?.status === 'failed' && (
        <span
          className="max-w-[16rem] truncate text-[10px] text-danger"
          title={update.update.message ?? ''}
        >
          {t('addons.updateFailed', { message: update.update.message ?? '' })}
        </span>
      )}
      {update?.update?.status === 'running' && (
        <span className="text-[10px] text-warning">
          {t('addons.updatingTo', { version: update.update.targetVersion })}
        </span>
      )}
      {update?.update?.status === 'done' && update.behindHub === false && (
        <span className="text-[10px] text-success">
          {t('addons.updatedTo', { version: update.update.targetVersion })}
        </span>
      )}
      {update !== undefined &&
        !update.behindHub &&
        update.updateAvailable &&
        update.latestVersion !== null && (
          <span className="text-[10px] text-foreground-subtle" title={t('addons.publishedHint')}>
            {t('addons.published', { version: update.latestVersion })}
          </span>
        )}
    </span>
  )
}

function RunnerCell({
  runner,
  t,
}: {
  readonly runner: AddonRuntimeRunner | null
  readonly t: AgentUiT
}) {
  if (runner === null) {
    return <span className="text-[11px] text-foreground-subtle">{t('addons.inAgentProcess')}</span>
  }
  const others = sharedCount(runner)
  const shared = others > 0 ? t('addons.shared', { count: others }) : null
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono text-[11px]">
        {runner.groupId} · pid {runner.pid}
      </span>
      {shared !== null && (
        <span className="text-[10px] text-foreground-subtle" title={runner.addonIds.join(', ')}>
          {shared}
        </span>
      )}
    </span>
  )
}

// ── Columns ─────────────────────────────────────────────────────────────────

interface ColumnHandlers {
  readonly t: AgentUiT
  readonly updateFor: (row: AddonRuntimeRow) => AddonUpdateRow | undefined
  readonly onRestartAddon: (addonId: string) => void
  readonly onRestartRunner: (name: string) => void
  readonly onUpdate: (packageName: string) => void
}

export function buildColumns(h: ColumnHandlers): readonly DataColumn<AddonRuntimeRow>[] {
  return [
    {
      key: 'addon',
      header: h.t('addons.columns.addon'),
      sortValue: (r) => r.addonId ?? r.runner?.name ?? r.key,
      render: (r) => (
        <span className="flex flex-col">
          <span className="font-mono text-xs">{r.addonId ?? r.runner?.name}</span>
          {r.kind === 'runner' && (
            <span className="text-[10px] text-foreground-subtle">
              {h.t('addons.runnerWithoutAddon')}
            </span>
          )}
          {r.packageName !== null && (
            <span className="text-[10px] text-foreground-subtle">{r.packageName}</span>
          )}
        </span>
      ),
    },
    {
      key: 'version',
      header: h.t('addons.columns.version'),
      notSortableReason: h.t('addons.columns.versionNotSortable'),
      render: (r) => <VersionCell row={r} update={h.updateFor(r)} t={h.t} />,
    },
    {
      key: 'runner',
      header: h.t('addons.columns.runner'),
      sortValue: (r) => r.runner?.groupId ?? null,
      render: (r) => <RunnerCell runner={r.runner} t={h.t} />,
    },
    {
      key: 'cpu',
      header: h.t('addons.columns.cpu'),
      align: 'right',
      sortValue: (r) => r.runner?.cpuPercent ?? null,
      render: (r) => (r.runner === null ? '—' : `${r.runner.cpuPercent.toFixed(1)}%`),
    },
    {
      key: 'memory',
      header: h.t('addons.columns.memory'),
      align: 'right',
      sortValue: (r) => r.runner?.memoryRss ?? null,
      render: (r) => (r.runner === null ? '—' : formatBytes(r.runner.memoryRss)),
    },
    {
      key: 'status',
      header: h.t('addons.columns.status'),
      sortValue: (r) => r.status,
      render: (r) => <StatusBadge status={statusBadge(r.status)} label={r.status} size="sm" />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: h.t('addons.columns.actionsNotSortable'),
      render: (r) => {
        const update = h.updateFor(r)
        const running = update?.update?.status === 'running'
        return (
          <span className="flex items-center justify-end gap-1">
            {update?.behindHub === true && r.packageName !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={running}
                onClick={() => h.onUpdate(r.packageName ?? '')}
              >
                <Package className="h-3 w-3" />
                {running
                  ? h.t('addons.updating')
                  : h.t('addons.updateTo', { version: update.hubVersion ?? '' })}
              </Button>
            )}
            {r.kind === 'addon' && r.addonId !== null && (
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                aria-label={h.t('addons.restart', { name: r.addonId })}
                onClick={() => h.onRestartAddon(r.addonId ?? '')}
              />
            )}
            {r.kind === 'runner' && r.runner !== null && (
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                aria-label={h.t('addons.restart', { name: r.runner.name })}
                onClick={() => h.onRestartRunner(r.runner?.name ?? '')}
              />
            )}
          </span>
        )
      },
    },
  ]
}

// ── Panel ───────────────────────────────────────────────────────────────────

const RUNTIME_POLL_MS = 3_000
const UPDATES_POLL_MS = 120_000
const UPDATES_ACTIVE_POLL_MS = 3_000

export function AddonsPanel({
  locked,
  onUnauthorized,
}: {
  readonly locked: boolean
  readonly onUnauthorized: () => void
}) {
  const { t } = useT()
  const [rows, setRows] = useState<readonly AddonRuntimeRow[] | null>(null)
  const [updates, setUpdates] = useState<AddonUpdatesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const fail = useCallback(
    (err: unknown): void => {
      if (err instanceof UnauthorizedError) onUnauthorized()
      else setError(err instanceof Error ? err.message : translate('common.unknownError'))
    },
    [onUnauthorized],
  )

  const pollRows = useCallback(async (): Promise<void> => {
    try {
      setRows(await fetchJson<readonly AddonRuntimeRow[]>('/api/agent/addon-runtime'))
      setError(null)
    } catch (err) {
      fail(err)
    }
  }, [fail])

  const pollUpdates = useCallback(async (): Promise<void> => {
    try {
      setUpdates(await fetchJson<AddonUpdatesResponse>('/api/agent/addon-updates'))
    } catch (err) {
      fail(err)
    }
  }, [fail])

  useEffect(() => {
    if (locked) return
    void pollRows()
    const id = setInterval(() => void pollRows(), RUNTIME_POLL_MS)
    return () => clearInterval(id)
  }, [locked, pollRows])

  const updating =
    updates?.available === true && updates.entries.some((e) => e.update?.status === 'running')
  useEffect(() => {
    if (locked) return
    void pollUpdates()
    const id = setInterval(
      () => void pollUpdates(),
      updating ? UPDATES_ACTIVE_POLL_MS : UPDATES_POLL_MS,
    )
    return () => clearInterval(id)
  }, [locked, pollUpdates, updating])

  const byPackage = useMemo(
    () =>
      new Map(
        updates?.available === true ? updates.entries.map((e) => [e.packageName, e] as const) : [],
      ),
    [updates],
  )

  const handleUpdate = useCallback(
    async (packageName: string): Promise<void> => {
      setStartError(null)
      try {
        const res = await postJson<UpdateStartResult>('/api/agent/addon-updates/update', {
          packageName,
        })
        if (!res.started) setStartError(res.message ?? translate('addons.startFailed'))
        await pollUpdates()
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorized()
        else {
          setStartError(err instanceof Error ? err.message : translate('addons.startFailed'))
        }
      }
    },
    [pollUpdates, onUnauthorized],
  )

  const columns = useMemo(
    () =>
      buildColumns({
        t,
        updateFor: (row) => (row.packageName === null ? undefined : byPackage.get(row.packageName)),
        onRestartAddon: (addonId) => void postJson('/api/agent/addon/restart', { addonId }),
        onRestartRunner: (name) => void postJson('/api/agent/process/restart', { name }),
        onUpdate: (packageName) => void handleUpdate(packageName),
      }),
    [byPackage, handleUpdate, t],
  )

  return (
    <SectionCard
      headingId="agent-addons"
      title={t('addons.title')}
      icon={Package}
      actions={
        <Badge variant="default" className="text-[10px]">
          {rows?.length ?? 0}
        </Badge>
      }
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        {error !== null && <ErrorBox message={t('addons.readFailed', { error })} />}
        {startError !== null && <ErrorBox message={startError} />}
        {updates?.available === true && updates.hubVersionsError !== null && (
          <ErrorBox
            variant="warning"
            message={t('addons.hubVersionsFailed', { error: updates.hubVersionsError })}
          />
        )}
        {updates?.available === true && updates.error !== null && (
          <ErrorBox variant="warning" message={updates.error} />
        )}
        <DataTable
          columns={columns}
          rows={rows ?? []}
          rowKey={(row) => row.key}
          minWidthPx={640}
          bordered={false}
          emptyMessage={rows === null ? t('common.loading') : t('addons.empty')}
        />
      </div>
    </SectionCard>
  )
}
