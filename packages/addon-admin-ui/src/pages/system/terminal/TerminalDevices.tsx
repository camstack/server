/**
 * System → Terminal → "Terminal devices": the operator UI for Terminal
 * instances of the `terminal-session` capability — programs kept open on a
 * node and exported as live cameras. Node shells (the `server-shell` profile)
 * are a separate sub-section (`NodeShells`) and never appear here.
 *
 * ONE table of every Terminal instance across the cluster (name, node,
 * profile, enabled, camera, actions) and a "New terminal" dialog. A Terminal's
 * camera is the Build-your-self block that names it (planning#580): the camera
 * column and the delete confirmation read the stored blocks, and deleting a
 * Terminal deletes its camera block. A node without a terminal provider is listed
 * disabled, with the reason, in that dialog's node picker (the form's
 * `requiresCapability`), and is never queried here: a per-node
 * `terminal-session` call against it fails.
 *
 * Attach opens a live pty (xterm.js via `<TerminalPanel>`) for an instance's
 * profile on its node; "Live sessions" lists the instance ptys of one node so
 * a session opened elsewhere can be reattached (the pty outlives the browser tab).
 */

import type { TerminalSessionInfo } from '@camstack/types'
import {
  Badge,
  Button,
  type DataColumn,
  ErrorBox,
  NodePicker,
  SectionCard,
  useCapabilityNodePresence,
  useClusterNodes,
  useCoreBlocksListCompositions,
  useInstancesOfCap,
  useTerminalSessionClose,
  useTerminalSessionListProfiles,
  useTerminalSessionListSessions,
  useTerminalSessionOpenSession,
} from '@camstack/ui-library'
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Plus,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { InstancesTable } from '../../../components/instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../../../components/instances/instances-model'
import { TerminalPanel } from '../../../components/TerminalPanel'
import { TerminalNodeSettings } from './TerminalNodeSettings'
import {
  type TerminalCameraBlock,
  terminalCameraIndex,
} from '../../../components/composition-editor/camera-block-model'
import { terminalCameraCreatePath } from '../../../lib/customization-routes'
import { TerminalProfileSettingsLead } from './TerminalProfileSettingsLead'

/** The capability whose providers make a node a Terminal node. */
const TERMINAL_CAPABILITY = 'terminal-session'

/** The node shell's profile: listed by `NodeShells`, never among the instance sessions. */
const SERVER_SHELL_PROFILE_ID = 'server-shell'

// The terminal reflows to its actual pane size the moment `<TerminalPanel>`
// mounts (its FitAddon issues a `resize`), so these are only the initial grid
// the pty spawns with.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

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

export function TerminalDevices() {
  const { t } = useTranslation()
  const { nodes: clusterNodes } = useClusterNodes()
  const presence = useCapabilityNodePresence(TERMINAL_CAPABILITY)

  const instancesQuery = useInstancesOfCap({ functionCap: 'terminal-session' })
  const compositionsQuery = useCoreBlocksListCompositions({}, { refetchInterval: 10_000 })
  const cameras = terminalCameraIndex(compositionsQuery.data, compositionsQuery.isError)
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
    () =>
      listedSessions.filter(
        (session) =>
          session.profileId !== SERVER_SHELL_PROFILE_ID && !closedSessionIds.has(session.sessionId),
      ),
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
  const nodeNameOf = (nodeId: string): string | undefined =>
    clusterNodes.find((node) => node.id === nodeId)?.name

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

  /** The camera block that shows a Terminal, once the blocks answered. */
  const cameraOf = (row: PanelRow): TerminalCameraBlock | undefined =>
    cameras.kind === 'ready' && row.kind === 'instance' ? cameras.byTerminal.get(row.id) : undefined
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
      sortValue: (row) => cameraOf(row)?.name.toLowerCase() ?? '',
      render: (row) => {
        if (cameras.kind === 'pending') return <span className="text-foreground-subtle">…</span>
        if (cameras.kind === 'unknown') {
          return (
            <span className="text-foreground-subtle">
              {t('terminalPage.cameraUnknown', 'Unknown')}
            </span>
          )
        }
        const camera = cameraOf(row)
        if (camera === undefined) {
          return (
            <span className="inline-flex items-center gap-2">
              <span className="text-foreground-subtle">{t('terminalPage.noCamera', 'None')}</span>
              {row.kind === 'instance' && (
                <Link
                  to={terminalCameraCreatePath(row.id)}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" aria-hidden />
                  {t('terminalPage.addCamera', 'Add a camera')}
                </Link>
              )}
            </span>
          )
        }
        if (camera.deviceId === null) return <span>{camera.name}</span>
        return (
          <Link
            to={`/devices/${String(camera.deviceId)}`}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Cable className="h-3 w-3" aria-hidden />
            {camera.name}
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
    <div className="space-y-4">
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
        deleteNote={(row) => {
          const camera = cameraOf(row)
          return camera === undefined
            ? null
            : t('terminalPage.deleteCamera', 'Its camera {{name}} is deleted with it.', {
                name: camera.name,
              })
        }}
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
    </div>
  )
}
