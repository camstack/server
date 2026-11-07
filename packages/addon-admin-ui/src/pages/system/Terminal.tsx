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

import type { TerminalSessionInfo } from '@camstack/types'
import {
  Badge,
  Button,
  ErrorBox,
  type DataColumn,
  Select,
  SectionCard,
  Skeleton,
  useClusterNodes,
  useDeviceManagerListAll,
  useInstancesOfCap,
  useTerminalSessionAdoptLegacyMonitor,
  useTerminalSessionClose,
  useTerminalSessionListLegacyCameras,
  useTerminalSessionListProfiles,
  useTerminalSessionListSessions,
  useTerminalSessionOpenSession,
} from '@camstack/ui-library'
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Server,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { TERMINAL_ADDON_ID, TerminalNodeSettings } from './terminal/TerminalNodeSettings'
import { TerminalPanel } from '../../components/TerminalPanel'
import { InstancesTable } from '../../components/instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../../components/instances/instances-model'
import { TerminalProfileSettingsLead } from './terminal/TerminalProfileSettingsLead'
import { useTerminalNodePresence } from './terminal/terminal-node-presence'

/**
 * Manifest id of `@camstack/addon-terminal`. The configuration rendered below
 * is the addon's own `globalSettingsSchema()` — this page declares no fields of
 * its own, so there is exactly one authority for "what a Terminal profile is".
 */

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

interface TerminalNodeOption {
  readonly id: string
  readonly label: string
}

/** What Attach needs of a Terminal: its record's body, read from the instance list. */
interface AttachTarget {
  readonly nodeId: string
  readonly profileId: string
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: readonly string[]
}

function textOf(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value : ''
}

function linesOf(values: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = values[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function attachTargetOf(values: Readonly<Record<string, unknown>>): AttachTarget {
  return {
    nodeId: textOf(values, 'nodeId'),
    profileId: textOf(values, 'profileId'),
    executable: textOf(values, 'executable'),
    args: linesOf(values, 'args'),
    cwd: textOf(values, 'cwd'),
    environment: linesOf(values, 'environment'),
  }
}

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
  const { nodes: clusterNodes } = useClusterNodes()
  const presence = useTerminalNodePresence()

  const instancesQuery = useInstancesOfCap({ functionCap: 'terminal-session' })
  // Only id + stableId are read, so the cheap projection is enough.
  const devicesQuery = useDeviceManagerListAll({
    addonId: TERMINAL_ADDON_ID,
    projection: 'slim',
  })
  const legacyCamerasQuery = useTerminalSessionListLegacyCameras(
    { nodeId: 'hub' },
    { refetchInterval: LEGACY_CAMERA_POLL_INTERVAL_MS },
  )
  const adoptLegacyMonitor = useTerminalSessionAdoptLegacyMonitor()
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()

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
    await Promise.all([legacyCamerasQuery.refetch(), devicesQuery.refetch()])
  }

  const attachInstance = async (instance: AttachTarget) => {
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

  /** The camera a Terminal declares: the adopted monitor's id, else the one derived from the record id. */
  const cameraStableIdOf = (row: PanelRow): string => {
    if (row.kind !== 'instance') return ''
    const adopted = valueOf(row, 'cameraStableId')
    return adopted !== '' ? adopted : `terminal-camera-instance-${row.id}`
  }
  const targetById = useMemo(
    () =>
      new Map(
        (instances ?? []).map((instance) => [instance.id, attachTargetOf(instance.formValues)]),
      ),
    [instances],
  )
  const valuesById = useMemo(
    () => new Map((instances ?? []).map((instance) => [instance.id, instance.formValues] as const)),
    [instances],
  )
  const valueOf = (row: PanelRow, key: string): string =>
    row.kind === 'instance' ? textOf(valuesById.get(row.id) ?? {}, key) : ''
  const extraColumns: readonly DataColumn<PanelRow>[] = [
    {
      key: 'node',
      header: t('terminalPage.colNode', 'Node'),
      sortValue: (row) => valueOf(row, 'nodeId'),
      render: (row) => {
        const nodeId = valueOf(row, 'nodeId')
        return (
          <span className="font-mono text-foreground-muted">
            {nodeNameById.get(nodeId) ?? (nodeId || '—')}
          </span>
        )
      },
    },
    {
      key: 'profile',
      header: t('terminalPage.colProfile', 'Profile'),
      sortValue: (row) => valueOf(row, 'profileLabel').toLowerCase(),
      render: (row) => valueOf(row, 'profileLabel') || '—',
    },
    {
      key: 'camera',
      header: t('terminalPage.colCamera', 'Camera'),
      sortValue: (row) => (deviceIdByStableId.has(cameraStableIdOf(row)) ? 1 : 0),
      render: (row) => {
        const deviceId = deviceIdByStableId.get(cameraStableIdOf(row))
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
  ]
  const rowActions = (row: InstanceRow) => {
    const target = targetById.get(row.id)
    if (target === undefined) return null
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={!row.enabled || !row.configured || openSession.isPending}
        onClick={() => void attachInstance(target)}
      >
        <TerminalIcon className="h-3 w-3" aria-hidden />
        {t('terminalPage.attach', 'Attach')}
      </Button>
    )
  }

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
    >
      {actionError && <ErrorBox message={actionError} />}

      <InstancesTable
        functionCap="terminal-session"
        icon={TerminalIcon}
        title={t('terminalPage.instances', 'Terminals')}
        subtitle={t(
          'terminalPage.subtitle',
          'Every terminal in the cluster, each with its own camera.',
        )}
        emptyTitle={t('terminalPage.empty', 'No terminals yet')}
        emptyDescription={t(
          'terminalPage.emptyHint',
          'Create one to run a program on a node and watch it as a camera.',
        )}
        addLabel={t('terminalPage.newTerminal', 'New terminal')}
        extraColumns={extraColumns}
        lead={(row) => <TerminalProfileSettingsLead row={row} />}
        rowActions={rowActions}
      />

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
                <TerminalNodeSettings nodeId={sessionNodeId} />
              </div>
            )}
          </div>
        </SectionCard>
      )}
    </AdminPage>
  )
}
