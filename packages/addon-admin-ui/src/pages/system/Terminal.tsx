/**
 * System → Terminal — operator UI for the `terminal-session` capability.
 *
 * ONE table of every Terminal instance across the cluster (name, node,
 * profile, enabled, camera, actions) and a "New terminal" dialog. An instance
 * and its camera are created in the same provider call, so a camera can never
 * exist before its terminal. A node without a terminal provider is reported as
 * such and never queried: a per-node `terminal-session` call against it fails.
 *
 * Attach opens a live pty (xterm.js via `<TerminalPanel>`) for an instance's
 * profile on its node; "Live sessions" lists the ptys of one node so a session
 * opened elsewhere can be reattached (the pty outlives the browser tab).
 *
 * Admin-only: every capability method is `auth: 'admin'` and the route is
 * wrapped in `<ProtectedRoute requireAdmin>` in App.tsx.
 */

import type { TerminalInstanceInfo, TerminalSessionInfo } from '@camstack/types'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  type DataColumn,
  Select,
  SectionCard,
  Skeleton,
  Switch,
  useClusterNodes,
  useConfirm,
  useDeviceManagerListAll,
  useTerminalSessionAdoptLegacyMonitor,
  useTerminalSessionClose,
  useTerminalSessionCreateInstance,
  useTerminalSessionDeleteInstance,
  useTerminalSessionListInstances,
  useTerminalSessionListLegacyCameras,
  useTerminalSessionListProfiles,
  useTerminalSessionListSessions,
  useTerminalSessionOpenSession,
  useTerminalSessionSetInstanceEnabled,
  useTerminalSessionUpdateInstance,
} from '@camstack/ui-library'
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Server,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { NodeAddonsSettingsPanel } from '../../components/settings/NodeAddonsSettingsPanel'
import { TerminalPanel } from '../../components/TerminalPanel'
import {
  TerminalInstanceDialog,
  type TerminalInstanceValues,
  type TerminalNodeOption,
} from './terminal/TerminalInstanceDialog'
import { useTerminalNodePresence } from './terminal/terminal-node-presence'

/**
 * Manifest id of `@camstack/addon-terminal`. The configuration rendered below
 * is the addon's own `globalSettingsSchema()` — this page declares no fields of
 * its own, so there is exactly one authority for "what a Terminal profile is".
 */
const TERMINAL_ADDON_ID = 'terminal'

// The terminal reflows to its actual pane size the moment `<TerminalPanel>`
// mounts (its FitAddon issues a `resize`), so these are only the initial grid
// the pty spawns with.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

/**
 * The legacy automatic-camera list resolves to a full `deviceManager.listAll`
 * for the whole addon prefix, so it is polled slower than the in-memory
 * session / instance reads: it only changes when an operator adopts or deletes.
 */
const LEGACY_CAMERA_POLL_INTERVAL_MS = 60_000

type DialogState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly instanceId: string }

interface AttachedSession {
  readonly nodeId: string
  readonly sessionId: string
}

function formatStartedAt(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function TerminalPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { nodes: clusterNodes } = useClusterNodes()
  const presence = useTerminalNodePresence()

  const instancesQuery = useTerminalSessionListInstances(
    { nodeId: 'hub' },
    { refetchInterval: 5000 },
  )
  // Only id + stableId are read, so the cheap projection is enough.
  const devicesQuery = useDeviceManagerListAll({
    addonId: TERMINAL_ADDON_ID,
    projection: 'slim',
  })
  const legacyCamerasQuery = useTerminalSessionListLegacyCameras(
    { nodeId: 'hub' },
    { refetchInterval: LEGACY_CAMERA_POLL_INTERVAL_MS },
  )
  const createInstance = useTerminalSessionCreateInstance()
  const updateInstance = useTerminalSessionUpdateInstance()
  const deleteInstance = useTerminalSessionDeleteInstance()
  const setInstanceEnabled = useTerminalSessionSetInstanceEnabled()
  const adoptLegacyMonitor = useTerminalSessionAdoptLegacyMonitor()
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()

  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [attached, setAttached] = useState<AttachedSession | null>(null)
  const [closedSessionIds, setClosedSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [sessionNodeId, setSessionNodeId] = useState('')
  const [configOpen, setConfigOpen] = useState(false)

  const providerNodes: readonly TerminalNodeOption[] = useMemo(
    () =>
      clusterNodes
        .filter((node) => presence.nodeState(node.id) === 'present')
        .map((node) => ({ id: node.id, label: node.name })),
    // `presence.nodeState` is a fresh closure per render; its inputs are the query below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clusterNodes, presence.nodeState],
  )

  // Live sessions and configuration look at ONE provider node; default to the
  // hub, or the first node that runs a provider.
  useEffect(() => {
    if (providerNodes.some((node) => node.id === sessionNodeId)) return
    const fallback = providerNodes.find((node) => node.id === 'hub') ?? providerNodes[0]
    setSessionNodeId(fallback?.id ?? '')
  }, [providerNodes, sessionNodeId])

  const hasSessionNode = sessionNodeId !== ''
  const profilesQuery = useTerminalSessionListProfiles(
    { nodeId: sessionNodeId },
    { enabled: hasSessionNode },
  )
  const sessionsQuery = useTerminalSessionListSessions(
    { nodeId: sessionNodeId },
    { refetchInterval: 5000, enabled: hasSessionNode },
  )
  const hasNoProfiles =
    hasSessionNode &&
    !profilesQuery.isLoading &&
    !profilesQuery.isError &&
    (profilesQuery.data ?? []).length === 0
  const showConfig = configOpen || hasNoProfiles

  const listedSessions = sessionsQuery.data ?? []
  const sessions = useMemo(
    () => listedSessions.filter((session) => !closedSessionIds.has(session.sessionId)),
    [listedSessions, closedSessionIds],
  )

  // If the attached session disappears from its node's live list (closed
  // elsewhere, or its pty exited), drop it so the panel unmounts.
  useEffect(() => {
    if (!attached || attached.nodeId !== sessionNodeId || sessionsQuery.data === undefined) return
    if (!sessions.some((session) => session.sessionId === attached.sessionId)) setAttached(null)
  }, [sessions, attached, sessionNodeId, sessionsQuery.data])

  useEffect(() => {
    const listedIds = new Set(listedSessions.map((session) => session.sessionId))
    setClosedSessionIds((current) => {
      const next = new Set([...current].filter((sessionId) => listedIds.has(sessionId)))
      return next.size === current.size ? current : next
    })
  }, [listedSessions])

  const instances = instancesQuery.data
  const legacyCameras = legacyCamerasQuery.data
  const deviceIdByStableId = useMemo(
    () => new Map((devicesQuery.data ?? []).map((device) => [device.stableId, device.id] as const)),
    [devicesQuery.data],
  )
  const nodeNameById = useMemo(
    () => new Map(clusterNodes.map((node) => [node.id, node.name] as const)),
    [clusterNodes],
  )

  const refreshInstances = async () => {
    await Promise.all([
      instancesQuery.refetch(),
      legacyCamerasQuery.refetch(),
      devicesQuery.refetch(),
    ])
  }

  const editedInstance =
    dialog.kind === 'edit'
      ? (instances?.find((row) => row.instanceId === dialog.instanceId) ?? null)
      : null

  const closeDialog = () => {
    setDialog({ kind: 'closed' })
    setDialogError(null)
  }

  const handleSubmitDialog = async (values: TerminalInstanceValues) => {
    setDialogError(null)
    try {
      if (editedInstance) {
        await updateInstance.mutateAsync({
          nodeId: 'hub',
          instanceId: editedInstance.instanceId,
          ...(values.nodeId !== editedInstance.nodeId ? { targetNodeId: values.nodeId } : {}),
          name: values.name,
          executable: values.executable,
          args: [...values.args],
          cwd: values.cwd,
          environment: [...values.environment],
          profileSettings: values.profileSettings,
        })
      } else {
        await createInstance.mutateAsync({
          nodeId: 'hub',
          targetNodeId: values.nodeId,
          profileId: values.profileId,
          name: values.name,
          executable: values.executable,
          args: [...values.args],
          cwd: values.cwd,
          environment: [...values.environment],
          profileSettings: values.profileSettings,
        })
      }
      closeDialog()
      await refreshInstances()
    } catch (error) {
      setDialogError(
        error instanceof Error && error.message
          ? error.message
          : editedInstance
            ? t('terminalPage.updateFailed', 'Failed to update the terminal.')
            : t('terminalPage.createFailed', 'Failed to create the terminal.'),
      )
    }
  }

  const handleDelete = async (instance: TerminalInstanceInfo) => {
    const ok = await confirm({
      title: t('terminalPage.deleteTitle', 'Delete "{{name}}"?', { name: instance.name }),
      message: t(
        'terminalPage.deleteMessage',
        'The terminal and its camera are removed. A running session on it is closed.',
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    setActionError(null)
    try {
      await deleteInstance.mutateAsync({ nodeId: 'hub', instanceId: instance.instanceId })
      await refreshInstances()
    } catch {
      setActionError(t('terminalPage.deleteFailed', 'Failed to delete the terminal.'))
    }
  }

  const handleSetEnabled = async (instance: TerminalInstanceInfo, enabled: boolean) => {
    setActionError(null)
    try {
      await setInstanceEnabled.mutateAsync({
        nodeId: 'hub',
        instanceId: instance.instanceId,
        enabled,
      })
      await refreshInstances()
    } catch {
      setActionError(t('terminalPage.updateFailed', 'Failed to update the terminal.'))
    }
  }

  const attachInstance = async (instance: TerminalInstanceInfo) => {
    setActionError(null)
    try {
      const session = await openSession.mutateAsync({
        nodeId: instance.nodeId,
        profileId: instance.profileId,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        ...(instance.executable ? { executable: instance.executable } : {}),
        args: [...instance.args],
        ...(instance.cwd ? { cwd: instance.cwd } : {}),
        environment: [...instance.environment],
      })
      setSessionNodeId(instance.nodeId)
      setAttached({ nodeId: instance.nodeId, sessionId: session.sessionId })
      await sessionsQuery.refetch()
    } catch {
      setActionError(t('terminalPage.attachFailed', 'Failed to open the session.'))
    }
  }

  const handleAdoptLegacyMonitor = async (stableId: string) => {
    setActionError(null)
    try {
      await adoptLegacyMonitor.mutateAsync({ nodeId: 'hub', stableId })
      await refreshInstances()
    } catch {
      setActionError(t('terminalPage.adoptFailed', 'Failed to adopt the legacy BTM terminal.'))
    }
  }

  const handleCloseSession = async (nodeId: string, sessionId: string) => {
    setActionError(null)
    setClosedSessionIds((current) => new Set(current).add(sessionId))
    if (attached?.sessionId === sessionId) setAttached(null)
    try {
      await closeSession.mutateAsync({ nodeId, sessionId })
      await sessionsQuery.refetch()
    } catch {
      setClosedSessionIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      setActionError(t('terminalPage.closeFailed', 'Failed to close the session.'))
    }
  }

  const columns: readonly DataColumn<TerminalInstanceInfo>[] = [
    {
      key: 'name',
      header: t('terminalPage.colName', 'Name'),
      sortValue: (row) => row.name.toLowerCase(),
      render: (row) => <span className="font-medium text-foreground">{row.name}</span>,
    },
    {
      key: 'node',
      header: t('terminalPage.colNode', 'Node'),
      sortValue: (row) => row.nodeId,
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-foreground-muted">
            {nodeNameById.get(row.nodeId) ?? row.nodeId}
          </span>
          {!row.nodeInCluster ? (
            <Badge variant="warning">{t('terminalPage.notInCluster', 'Not in cluster')}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'profile',
      header: t('terminalPage.colProfile', 'Profile'),
      sortValue: (row) => row.profileLabel.toLowerCase(),
      render: (row) => row.profileLabel,
    },
    {
      key: 'enabled',
      header: t('terminalPage.colEnabled', 'Enabled'),
      sortValue: (row) => (row.enabled ? 1 : 0),
      render: (row) => (
        <Switch
          checked={row.enabled}
          aria-label={t('terminalPage.enabledLabel', 'Enabled: {{name}}', { name: row.name })}
          disabled={setInstanceEnabled.isPending}
          onCheckedChange={(next) => void handleSetEnabled(row, next)}
        />
      ),
    },
    {
      key: 'camera',
      header: t('terminalPage.colCamera', 'Camera'),
      sortValue: (row) => (deviceIdByStableId.has(row.cameraStableId) ? 1 : 0),
      render: (row) => {
        const deviceId = deviceIdByStableId.get(row.cameraStableId)
        if (deviceId === undefined) {
          return (
            <span className="text-foreground-subtle">{t('terminalPage.noCamera', 'None')}</span>
          )
        }
        return (
          <Link
            to={`/devices/${String(deviceId)}`}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Cable className="h-3 w-3" aria-hidden />
            {t('terminalPage.cameraLink', 'Camera {{id}}', { id: deviceId })}
          </Link>
        )
      },
    },
    {
      key: 'actions',
      header: t('terminalPage.colActions', 'Actions'),
      align: 'right',
      notSortableReason: t('terminalPage.actionsNotSortable', 'Actions have no order'),
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!row.nodeInCluster || openSession.isPending}
            onClick={() => void attachInstance(row)}
          >
            <TerminalIcon className="h-3 w-3" aria-hidden />
            {t('terminalPage.attach', 'Attach')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDialogError(null)
              setDialog({ kind: 'edit', instanceId: row.instanceId })
            }}
          >
            <Pencil className="h-3 w-3" aria-hidden />
            {t('common.edit', 'Edit')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={deleteInstance.isPending}
            onClick={() => void handleDelete(row)}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            {t('common.delete', 'Delete')}
          </Button>
        </span>
      ),
    },
  ]

  const attachedSessionInfo: TerminalSessionInfo | null =
    attached && attached.nodeId === sessionNodeId
      ? (sessions.find((session) => session.sessionId === attached.sessionId) ?? null)
      : null

  return (
    <AdminPage
      icon={TerminalIcon}
      title={t('systemPage.terminal.terminal', 'Terminal')}
      subtitle={t(
        'terminalPage.subtitle',
        'Every terminal in the cluster, each with its own camera.',
      )}
      actions={
        <Button
          size="sm"
          disabled={providerNodes.length === 0}
          onClick={() => {
            setDialogError(null)
            setDialog({ kind: 'create' })
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('terminalPage.newTerminal', 'New terminal')}
        </Button>
      }
    >
      {actionError && <ErrorBox message={actionError} />}

      <SectionCard
        headingId="terminal-instances"
        title={t('terminalPage.instances', 'Terminals')}
        icon={TerminalIcon}
      >
        {instances === undefined ? (
          instancesQuery.isError ? (
            <ErrorBox
              message={t('terminalPage.instancesUnknown', 'Could not read the terminals.')}
              onRetry={() => void instancesQuery.refetch()}
            />
          ) : (
            <Skeleton className="h-16 w-full" />
          )
        ) : instances.length === 0 ? (
          <EmptyState
            icon={TerminalIcon}
            title={t('terminalPage.empty', 'No terminals yet')}
            description={t(
              'terminalPage.emptyHint',
              'Create one to run a program on a node and watch it as a camera.',
            )}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={instances}
            rowKey={(row) => row.instanceId}
            minWidthPx={860}
            defaultSort={{ columnKey: 'name', dir: 'asc' }}
          />
        )}
      </SectionCard>

      <SectionCard
        headingId="terminal-nodes"
        title={t('terminalPage.nodes', 'Nodes')}
        icon={Server}
      >
        <ul className="divide-y divide-border">
          {clusterNodes.map((node) => {
            const state = presence.nodeState(node.id)
            return (
              <li
                key={node.id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <span className="font-medium text-foreground">{node.name}</span>
                {state === 'pending' ? (
                  <Skeleton className="h-4 w-32" />
                ) : state === 'present' ? (
                  <Badge variant="success">{t('terminalPage.installed', 'Terminal ready')}</Badge>
                ) : state === 'absent' ? (
                  <span className="text-foreground-subtle">
                    {t('terminalPage.notInstalled', 'Terminal not installed on this node')}
                  </span>
                ) : (
                  <span className="text-warning">
                    {t('terminalPage.presenceUnknown', 'Could not check this node')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </SectionCard>

      {legacyCameras !== undefined && legacyCameras.length > 0 && (
        <SectionCard
          headingId="terminal-legacy"
          title={t('systemPage.terminal.legacyAutomaticCameras', 'Legacy automatic cameras')}
          icon={Cable}
        >
          <p className="px-3 pt-2 text-[11px] text-foreground-subtle">
            {t(
              'systemPage.terminal.theseCamerasPredateExplicitTerminal',
              'These cameras predate explicit Terminal instances. They are intentionally untouched: confirm each migration before deleting one. Only BTM cameras can retain their legacy identity by being adopted below; create new instances for Top or Glances first.',
            )}
          </p>
          <ul className="divide-y divide-border">
            {legacyCameras.map((camera) => (
              <li
                key={camera.stableId}
                className="flex items-center justify-between gap-2 px-3 py-1.5"
              >
                <span className="min-w-0 truncate text-[11px] text-foreground-subtle">
                  {camera.name} · {camera.nodeId} · {camera.profileLabel}
                </span>
                {camera.adoptable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={adoptLegacyMonitor.isPending}
                    onClick={() => void handleAdoptLegacyMonitor(camera.stableId)}
                  >
                    {t('systemPage.terminal.adoptBtm', 'Adopt BTM')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {attachedSessionInfo && attached && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-xs text-foreground-subtle">
              <span className="font-medium text-foreground">{attachedSessionInfo.label}</span>
              <span className="mx-1.5">·</span>
              <span className="font-mono">{attachedSessionInfo.sessionId}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={closeSession.isPending}
              onClick={() => void handleCloseSession(attached.nodeId, attached.sessionId)}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              {t('common.close', 'Close')}
            </Button>
          </div>
          <TerminalPanel
            key={`${attached.nodeId}:${attached.sessionId}`}
            nodeId={attached.nodeId}
            sessionId={attached.sessionId}
            onExit={() => void sessionsQuery.refetch()}
          />
        </div>
      )}

      {hasSessionNode && (
        <SectionCard
          headingId="terminal-sessions"
          title={t('systemPage.terminal.liveSessions', 'Live sessions')}
          icon={TerminalIcon}
          actions={
            providerNodes.length > 1 ? (
              <div className="w-44">
                <Select
                  aria-label={t('terminalPage.sessionsNode', 'Node')}
                  value={sessionNodeId}
                  onChange={(event) => setSessionNodeId(event.target.value)}
                  options={providerNodes.map((node) => ({ value: node.id, label: node.label }))}
                />
              </div>
            ) : undefined
          }
        >
          {sessions.length === 0 ? (
            <p className="px-3 py-4 text-xs text-foreground-subtle">
              {t('terminalPage.noSessions', 'No sessions running on this node.')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {sessions.map((session) => {
                const isActive = attached?.sessionId === session.sessionId
                return (
                  <li
                    key={session.sessionId}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{session.label}</span>
                        {isActive && (
                          <Badge variant="info">
                            {t('systemPage.terminal.attached', 'Attached')}
                          </Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-foreground-subtle">
                        {session.sessionId} · {session.cols}×{session.rows} ·{' '}
                        {formatStartedAt(session.startedAt)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setAttached({ nodeId: sessionNodeId, sessionId: session.sessionId })
                          }
                        >
                          {t('systemPage.terminal.attach', 'Attach')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={closeSession.isPending}
                        onClick={() => void handleCloseSession(sessionNodeId, session.sessionId)}
                      >
                        {t('common.close', 'Close')}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showConfig}
              onClick={() => setConfigOpen((open) => !open)}
            >
              {showConfig ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              )}
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              {t('systemPage.terminal.terminalConfiguration', 'Terminal configuration')}
            </Button>
            {showConfig && (
              <div className="border-t border-border p-3">
                {hasNoProfiles && (
                  <p className="mb-3 text-[11px] text-warning">
                    {t(
                      'systemPage.terminal.thisNodeOffersNoTerminal',
                      'This node offers no terminal profile. Enable BTM, Top or Glances below, or add a custom profile.',
                    )}
                  </p>
                )}
                <NodeAddonsSettingsPanel
                  nodeId={sessionNodeId}
                  addonIds={[TERMINAL_ADDON_ID]}
                  level="global"
                />
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {dialog.kind !== 'closed' && (dialog.kind === 'create' || editedInstance !== null) && (
        <TerminalInstanceDialog
          key={dialog.kind === 'edit' ? dialog.instanceId : 'create'}
          instance={editedInstance}
          nodes={providerNodes}
          submitting={createInstance.isPending || updateInstance.isPending}
          error={dialogError}
          onClose={closeDialog}
          onSubmit={(values) => void handleSubmitDialog(values)}
        />
      )}
    </AdminPage>
  )
}
