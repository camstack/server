/**
 * System → Terminal → "Node shells": one entry per node that runs a
 * `terminal-session` provider, as the capability registry answered it
 * (pending and a failed read render as such, never as "no node" — D315).
 *
 * A node's shell is not started by the list. It starts only when an admin
 * opens that node's section (`?node=<id>`), and it is closed when the section
 * is left (`useNodeShellSession`) or when it sits idle without output (the
 * provider's per-node timeout). Every shell a node is still running — this
 * page's, another admin's, one a closed tab left behind — is counted in the
 * node's row and listed in its section with a Close (`NodeShellSessions`).
 * A node that has not opted in shows the provider's refusal and that node's
 * Terminal settings, where the opt-in lives.
 */
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  EmptyState,
  ErrorBox,
  IconButton,
  SectionCard,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useCapabilityNodePresence,
  useClusterNodes,
  useTerminalSessionServerShellStatus,
} from '@camstack/ui-library'
import { Terminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { TerminalPanel } from '../../../components/TerminalPanel'
import { NodeShellSessionCount, NodeShellSessionsList } from './NodeShellSessions'
import { TERMINAL_SESSION_CAP, TerminalNodeSettings } from './TerminalNodeSettings'
import { type NodeShellCloseFailed, useNodeShellSession } from './use-node-shell-session'

/** The URL param naming the node whose section is open. Owned by the Node shells tab. */
export const NODE_SHELL_PARAM = 'node'

interface NodeShellRow {
  readonly nodeId: string
  readonly name: string
}

interface NodeShellStatusCellProps {
  readonly nodeId: string
}

function NodeShellStatusCell({ nodeId }: NodeShellStatusCellProps) {
  const { t } = useTranslation()
  const status = useTerminalSessionServerShellStatus({ nodeId })
  const count = <NodeShellSessionCount nodeId={nodeId} />
  if (status.isPending) return <Skeleton className="h-5 w-20" />
  if (status.isError || status.data === undefined) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge variant="warning">{t('terminalPage.shellStatusUnknown', 'Unknown')}</Badge>
        {count}
      </span>
    )
  }
  if (!status.data.enabled) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge>{t('terminalPage.shellOff', 'Off')}</Badge>
        {count}
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant="success">{t('terminalPage.shellOn', 'On')}</Badge>
      {count}
      <span className="text-xs text-foreground-subtle">
        {t('terminalPage.shellIdle', 'Closes after {{minutes}} min without input or output', {
          minutes: status.data.idleMinutes,
        })}
      </span>
    </span>
  )
}

interface NodeShellSessionViewProps {
  readonly nodeId: string
  readonly onEnded: () => void
  readonly onOpened: (sessionId: string | null) => void
  readonly onCloseFailed: NodeShellCloseFailed
}

/** Mounted only while the node's section is open and the node has opted in. */
function NodeShellSessionView({
  nodeId,
  onEnded,
  onOpened,
  onCloseFailed,
}: NodeShellSessionViewProps) {
  const { t } = useTranslation()
  const { sessionId, error } = useNodeShellSession(nodeId, onCloseFailed)
  useEffect(() => {
    onOpened(sessionId)
    return () => onOpened(null)
  }, [sessionId, onOpened])
  if (error !== null) return <ErrorBox message={error} />
  if (sessionId === null) {
    return (
      <div aria-busy="true" aria-label={t('terminalPage.shellOpening', 'Opening the shell')}>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  return (
    <div className="flex h-[70vh] min-h-64 flex-col">
      <TerminalPanel fill nodeId={nodeId} sessionId={sessionId} onExit={onEnded} />
    </div>
  )
}

interface NodeShellSectionProps {
  readonly nodeId: string
  readonly name: string
  readonly onLeave: () => void
  readonly onCloseFailed: NodeShellCloseFailed
}

function NodeShellSection({ nodeId, name, onLeave, onCloseFailed }: NodeShellSectionProps) {
  const { t } = useTranslation()
  const status = useTerminalSessionServerShellStatus({ nodeId })
  const [attempt, setAttempt] = useState(0)
  const [ended, setEnded] = useState(false)
  const [ownSessionId, setOwnSessionId] = useState<string | null>(null)
  const refusal = status.data?.enabled === false ? status.data.refusal : null

  return (
    <SectionCard
      headingId={`node-shell-${nodeId}`}
      title={name}
      icon={TerminalIcon}
      actions={
        <Button size="sm" variant="outline" onClick={onLeave}>
          <X className="h-3.5 w-3.5" aria-hidden />
          {t('terminalPage.shellLeave', 'Close shell')}
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        <NodeShellSessionsList nodeId={nodeId} ownSessionId={ownSessionId} />
        {status.isPending && <Skeleton className="h-16 w-full" />}
        {status.isError && (
          <ErrorBox
            message={t(
              'terminalPage.shellStatusFailed',
              'This node did not say whether its shell is on. Try again in a moment.',
            )}
          />
        )}
        {refusal && (
          <>
            <ErrorBox
              variant="warning"
              title={t('terminalPage.serverShellOff', 'Server shell is off')}
              message={refusal.message}
            />
            <TerminalNodeSettings nodeId={nodeId} onAfterChange={() => void status.refetch()} />
          </>
        )}
        {status.data?.enabled === true &&
          (ended ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-subtle">
              {t('terminalPage.shellEnded', 'The shell ended.')}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEnded(false)
                  setAttempt((n) => n + 1)
                }}
              >
                {t('terminalPage.shellRestart', 'Start a new shell')}
              </Button>
            </div>
          ) : (
            <NodeShellSessionView
              key={attempt}
              nodeId={nodeId}
              onEnded={() => setEnded(true)}
              onOpened={setOwnSessionId}
              onCloseFailed={onCloseFailed}
            />
          ))}
      </div>
    </SectionCard>
  )
}

export function NodeShells() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const presence = useCapabilityNodePresence(TERMINAL_SESSION_CAP)
  const { nodes } = useClusterNodes()
  const openNodeId = params.get(NODE_SHELL_PARAM) ?? ''
  const [closeFailure, setCloseFailure] = useState<string | null>(null)

  const setOpenNode = (nodeId: string | null) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (nodeId === null) next.delete(NODE_SHELL_PARAM)
        else next.set(NODE_SHELL_PARAM, nodeId)
        return next
      },
      { replace: true },
    )
  }

  // A page restored from the back/forward cache still shows the panel, but
  // its socket is gone: put the node back to "Open shell" (which also closes
  // the session the section held).
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete(NODE_SHELL_PARAM)
          return next
        },
        { replace: true },
      )
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [setParams])

  const listed = presence.providerNodes
  if (listed.state === 'pending') {
    return (
      <div
        aria-busy="true"
        aria-label={t('terminalPage.serverShellLoading', 'Checking which nodes run a terminal')}
      >
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (listed.state === 'unknown') {
    return (
      <ErrorBox
        message={t(
          'terminalPage.serverShellUnknown',
          'The terminal registry did not answer. Try again in a moment.',
        )}
      />
    )
  }

  const nameOf = (nodeId: string): string =>
    nodes.find((node) => node.id === nodeId)?.name ?? nodeId
  const rows: readonly NodeShellRow[] = listed.nodeIds.map((nodeId) => ({
    nodeId,
    name: nameOf(nodeId),
  }))
  const openRow = rows.find((row) => row.nodeId === openNodeId)
  // The registry ANSWERED and this node is not in it (D315).
  const notInstalled =
    openNodeId !== '' && openRow === undefined ? (
      <ErrorBox
        variant="warning"
        title={t('terminalPage.shellNotInstalled', 'Terminal is not installed on this node')}
        message={nameOf(openNodeId)}
      />
    ) : null
  const closeFailureBox =
    closeFailure === null ? null : (
      <ErrorBox
        title={t('terminalPage.shellLeaveFailed', 'A shell was not closed')}
        message={closeFailure}
        action={
          <Button size="sm" variant="ghost" onClick={() => setCloseFailure(null)}>
            {t('terminalPage.dismiss', 'Dismiss')}
          </Button>
        }
      />
    )

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        {notInstalled}
        <EmptyState
          icon={TerminalIcon}
          title={t('terminalPage.shellNoNodes', 'No node runs the Terminal addon')}
        />
      </div>
    )
  }

  const columns: readonly DataColumn<NodeShellRow>[] = [
    {
      mobile: 'primary',
      key: 'node',
      header: t('terminalPage.colNode', 'Node'),
      sortValue: (row) => row.name.toLowerCase(),
      // The node and its shell state share one cell so the row fits a phone.
      render: (row) => (
        <span className="inline-flex flex-col gap-1">
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{row.name}</span>
            {row.name !== row.nodeId && (
              <span className="font-mono text-xs text-foreground-subtle">{row.nodeId}</span>
            )}
          </span>
          <NodeShellStatusCell nodeId={row.nodeId} />
        </span>
      ),
    },
    {
      mobile: 'keep',
      key: 'actions',
      align: 'right',
      notSortableReason: t('terminalPage.actionsNotSortable', 'Actions'),
      render: (row) =>
        row.nodeId === openNodeId ? (
          <Badge variant="info">{t('terminalPage.shellOpen', 'Open')}</Badge>
        ) : (
          <Tooltip>
            <TooltipTrigger>
              <IconButton
                size="sm"
                variant="outline"
                icon={TerminalIcon}
                aria-label={t('terminalPage.shellOpenAction', 'Open shell')}
                onClick={() => setOpenNode(row.nodeId)}
              />
            </TooltipTrigger>
            <TooltipContent>{t('terminalPage.shellOpenAction', 'Open shell')}</TooltipContent>
          </Tooltip>
        ),
    },
  ]

  return (
    <div className="space-y-4">
      {closeFailureBox}
      {notInstalled}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.nodeId}
        minWidthPx={280}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'node', dir: 'asc' }}
      />
      {openRow && (
        <NodeShellSection
          key={openRow.nodeId}
          nodeId={openRow.nodeId}
          name={openRow.name}
          onLeave={() => setOpenNode(null)}
          onCloseFailed={(message) =>
            setCloseFailure(
              t('terminalPage.shellLeaveFailedOn', '{{node}}: {{message}}', {
                node: openRow.name,
                message,
              }),
            )
          }
        />
      )}
    </div>
  )
}
