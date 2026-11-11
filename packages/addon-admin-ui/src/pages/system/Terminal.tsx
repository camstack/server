/**
 * System → Terminal — operator UI for the `terminal-session` capability.
 *
 * ONE table of every Terminal instance across the cluster (name, node,
 * profile, enabled, camera, actions) and a "New terminal" dialog. An instance
 * and its camera are created in the same provider call, so a camera can never
 * exist before its terminal. A node without a terminal provider is listed
 * disabled, with the reason, in that dialog's node picker (the form's
 * `requiresCapability`), and is never queried here: a per-node
 * `terminal-session` call against it fails.
 *
 * Legacy automatic cameras have no list of their own: while the hub answers
 * that some exist, the table header carries one action that adopts them all
 * (`adoptLegacyCameras`, the one-off migration).
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
  NodePicker,
  SectionCard,
  useAddonsCustom,
  useCapabilityNodePresence,
  useClusterNodes,
  useDeviceManagerListAll,
  useInstancesOfCap,
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

/** The capability whose providers make a node a Terminal node. */
const TERMINAL_CAPABILITY = 'terminal-session'

/** The one-off migration of legacy automatic cameras (`addons.custom`). */
const ADOPT_LEGACY_CAMERAS_ACTION = 'adoptLegacyCameras'

// The terminal reflows to its actual pane size the moment `<TerminalPanel>`
// mounts (its FitAddon issues a `resize`), so these are only the initial grid
// the pty spawns with.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

/**
 * The legacy automatic-camera read resolves to a `deviceManager.listAll` for
 * the addon, so it is polled slower than the in-memory session / instance
 * reads: it only changes when the legacy cameras are adopted or deleted.
 */
const LEGACY_CAMERA_POLL_INTERVAL_MS = 60_000

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
  const presence = useCapabilityNodePresence(TERMINAL_CAPABILITY)

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
  const custom = useAddonsCustom()
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()

  const [actionError, setActionError] = useState<string | null>(null)
  const [attached, setAttached] = useState<AttachedSession | null>(null)
  const [closedSessionIds, setClosedSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [sessionNodeId, setSessionNodeId] = useState('')
  const [configOpen, setConfigOpen] = useState(false)

  // The nodes the registry ANSWERED run a provider; any other is never queried here.
  const providerNodeKey = clusterNodes
    .filter((node) => presence.onNode(node.id) === 'present')
    .map((node) => node.id)
    .join('\n')

  // Live sessions and configuration look at ONE provider node; default to the
  // hub, or the first node that runs a provider.
  useEffect(() => {
    const providerNodeIds = providerNodeKey === '' ? [] : providerNodeKey.split('\n')
    if (providerNodeIds.includes(sessionNodeId)) return
    const fallback = providerNodeIds.includes('hub') ? 'hub' : providerNodeIds[0]
    setSessionNodeId(fallback ?? '')
  }, [providerNodeKey, sessionNodeId])

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
  const nodeNameOf = (nodeId: string): string | undefined =>
    clusterNodes.find((node) => node.id === nodeId)?.name

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

  const handleAdoptLegacyCameras = async () => {
    setActionError(null)
    try {
      await custom.mutateAsync({
        addonId: TERMINAL_ADDON_ID,
        action: ADOPT_LEGACY_CAMERAS_ACTION,
        input: {},
      })
      await refreshInstances()
    } catch {
      setActionError(t('terminalPage.adoptLegacyFailed', 'Failed to adopt the legacy cameras.'))
    }
  }
  /** Shown only when the hub ANSWERED that legacy cameras exist. */
  const legacyCount = legacyCameras?.length ?? 0
  const adoptLegacyAction = () =>
    legacyCount > 0 ? (
      <Button
        size="sm"
        variant="outline"
        disabled={custom.isPending}
        onClick={() => void handleAdoptLegacyCameras()}
      >
        <Cable className="h-3 w-3" aria-hidden />
        {t('terminalPage.adoptLegacy', 'Adopt legacy cameras ({{count}})', {
          count: legacyCount,
        })}
      </Button>
    ) : null

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
            {nodeNameOf(nodeId) ?? (nodeId || '—')}
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
        'Keep a terminal open on a node and export it as a live camera.',
      )}
    >
      {actionError && <ErrorBox message={actionError} />}

      <InstancesTable
        functionCap="terminal-session"
        icon={TerminalIcon}
        emptyTitle={t('terminalPage.empty', 'No terminals yet')}
        emptyDescription={t(
          'terminalPage.emptyHint',
          'Create one to run a program on a node and watch it as a camera.',
        )}
        addLabel={t('terminalPage.newTerminal', 'New terminal')}
        extraColumns={extraColumns}
        lead={(row) => <TerminalProfileSettingsLead row={row} />}
        rowActions={rowActions}
        pageActions={adoptLegacyAction}
      />

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
            <NodePicker
              selectedNodeId={sessionNodeId}
              onSelect={setSessionNodeId}
              label=""
              hideIcon
              requiresCapability={TERMINAL_CAPABILITY}
            />
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
                            setAttached({
                              nodeId: sessionNodeId,
                              sessionId: session.sessionId,
                            })
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
