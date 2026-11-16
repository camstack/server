/**
 * System → Terminal → "Node shells": one entry per node that runs a
 * `terminal-session` provider, as the capability registry answered it
 * (pending and a failed read render as such, never as "no node" — D315).
 *
 * A node's shell is not started by the list. It starts only when an admin
 * opens that node's section (`?node=<id>`), and it is closed when the section
 * is left (`useNodeShellSession`) or when it sits idle (the provider's
 * per-node timeout). A node that has not opted in shows the provider's refusal
 * and that node's Terminal settings, where the opt-in lives.
 */
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  EmptyState,
  ErrorBox,
  SectionCard,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  useCapabilityNodePresence,
  useClusterNodes,
  useTerminalSessionServerShellStatus,
} from '@camstack/ui-library'
import { Terminal as TerminalIcon, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { TerminalPanel } from '../../../components/TerminalPanel'
import { TERMINAL_SESSION_CAP, TerminalNodeSettings } from './TerminalNodeSettings'
import { useNodeShellSession } from './use-node-shell-session'

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
  if (status.isPending) return <Skeleton className="h-5 w-20" />
  if (status.isError || status.data === undefined) {
    return <Badge variant="warning">{t('terminalPage.shellStatusUnknown', 'Unknown')}</Badge>
  }
  if (!status.data.enabled) {
    return <Badge>{t('terminalPage.shellOff', 'Off')}</Badge>
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant="success">{t('terminalPage.shellOn', 'On')}</Badge>
      <span className="text-xs text-foreground-subtle">
        {t('terminalPage.shellIdle', 'Closes after {{minutes}} min idle', {
          minutes: status.data.idleMinutes,
        })}
      </span>
    </span>
  )
}

interface NodeShellSessionViewProps {
  readonly nodeId: string
  readonly onEnded: () => void
}

/** Mounted only while the node's section is open and the node has opted in. */
function NodeShellSessionView({ nodeId, onEnded }: NodeShellSessionViewProps) {
  const { t } = useTranslation()
  const { sessionId, error } = useNodeShellSession(nodeId)
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
}

function NodeShellSection({ nodeId, name, onLeave }: NodeShellSectionProps) {
  const { t } = useTranslation()
  const status = useTerminalSessionServerShellStatus({ nodeId })
  const [attempt, setAttempt] = useState(0)
  const [ended, setEnded] = useState(false)
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
            <NodeShellSessionView key={attempt} nodeId={nodeId} onEnded={() => setEnded(true)} />
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

  const setOpenNode = (nodeId: string | null) => {
    const next = new URLSearchParams(params)
    if (nodeId === null) next.delete(NODE_SHELL_PARAM)
    else next.set(NODE_SHELL_PARAM, nodeId)
    setParams(next, { replace: true })
  }

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

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TerminalIcon}
        title={t('terminalPage.shellNoNodes', 'No node runs the Terminal addon')}
      />
    )
  }

  const columns: readonly DataColumn<NodeShellRow>[] = [
    {
      key: 'node',
      header: t('terminalPage.colNode', 'Node'),
      sortValue: (row) => row.name.toLowerCase(),
      render: (row) => (
        <span className="inline-flex flex-col">
          <span className="font-medium text-foreground">{row.name}</span>
          {row.name !== row.nodeId && (
            <span className="font-mono text-xs text-foreground-subtle">{row.nodeId}</span>
          )}
        </span>
      ),
    },
    {
      key: 'shell',
      header: t('terminalPage.colShell', 'Shell'),
      notSortableReason: t('terminalPage.shellNotSortable', 'Read per node'),
      render: (row) => <NodeShellStatusCell nodeId={row.nodeId} />,
    },
    {
      key: 'actions',
      align: 'right',
      notSortableReason: t('terminalPage.actionsNotSortable', 'Actions'),
      render: (row) =>
        row.nodeId === openNodeId ? (
          <Badge variant="info">{t('terminalPage.shellOpen', 'Open')}</Badge>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOpenNode(row.nodeId)}>
            <TerminalIcon className="h-3 w-3" aria-hidden />
            {t('terminalPage.shellOpenAction', 'Open shell')}
          </Button>
        ),
    },
  ]

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.nodeId}
        minWidthPx={320}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'node', dir: 'asc' }}
      />
      {openRow && (
        <NodeShellSection
          key={openRow.nodeId}
          nodeId={openRow.nodeId}
          name={openRow.name}
          onLeave={() => setOpenNode(null)}
        />
      )}
    </div>
  )
}
