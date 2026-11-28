/**
 * The `server-shell` sessions a node is running right now, whoever opened them.
 *
 * The idle timeout does not bound a shell that keeps printing (output counts
 * as activity), and a tab that was killed closes nothing — so the bound on a
 * left-behind shell is this list: every running shell, who opened it, when,
 * when it last saw input or output, and a Close any admin may use (D1051,
 * D1055). Nothing here reattaches to a session.
 */
import {
  Badge,
  type DataColumn,
  DataTable,
  ErrorBox,
  IconButton,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useTerminalSessionClose,
  useTerminalSessionListSessions,
} from '@dominevo/ui-library'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUserNames } from '../../../components/access/AccessSection'
import { formatRelativeTime } from '../../../components/device/hero/format'
import { SERVER_SHELL_PROFILE_ID } from './use-node-shell-session'

const SESSIONS_REFRESH_MS = 5000

export interface NodeShellSessionRow {
  readonly sessionId: string
  readonly openedBy: string | null
  readonly startedAt: number
  readonly lastActivityAt: number | null
}

export type NodeShellSessionsAnswer =
  | { readonly state: 'pending' }
  | { readonly state: 'failed' }
  | { readonly state: 'answered'; readonly sessions: readonly NodeShellSessionRow[] }

export interface NodeShellSessions {
  readonly answer: NodeShellSessionsAnswer
  readonly refetch: () => Promise<unknown>
}

/** One node's running server shells, polled; pending and a failed read stay distinct. */
export function useNodeShellSessions(nodeId: string): NodeShellSessions {
  const query = useTerminalSessionListSessions({ nodeId }, { refetchInterval: SESSIONS_REFRESH_MS })
  const refetch = () => query.refetch()
  if (query.isPending) return { answer: { state: 'pending' }, refetch }
  if (query.isError || query.data === undefined) return { answer: { state: 'failed' }, refetch }
  const sessions = query.data
    .filter((session) => session.profileId === SERVER_SHELL_PROFILE_ID)
    .map((session) => ({
      sessionId: session.sessionId,
      openedBy: session.openedBy ?? null,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt ?? null,
    }))
  return { answer: { state: 'answered', sessions }, refetch }
}

interface NodeShellSessionCountProps {
  readonly nodeId: string
}

/** The node row's count of running shells. */
export function NodeShellSessionCount({ nodeId }: NodeShellSessionCountProps) {
  const { t } = useTranslation()
  const { answer } = useNodeShellSessions(nodeId)
  if (answer.state === 'pending') return <Skeleton className="h-5 w-16" />
  if (answer.state === 'failed') {
    return (
      <Badge variant="warning">{t('terminalPage.shellRunningUnknown', 'Running: unknown')}</Badge>
    )
  }
  if (answer.sessions.length === 0) return null
  return (
    <Badge variant="info">
      {t('terminalPage.shellRunning', '{{count}} running', { count: answer.sessions.length })}
    </Badge>
  )
}

interface NodeShellSessionsListProps {
  readonly nodeId: string
  /** The session this page opened, if any — marked, not closable from the list. */
  readonly ownSessionId: string | null
}

export function NodeShellSessionsList({ nodeId, ownSessionId }: NodeShellSessionsListProps) {
  const { t } = useTranslation()
  const names = useUserNames()
  const { answer, refetch } = useNodeShellSessions(nodeId)
  const closeSession = useTerminalSessionClose()
  const [closing, setClosing] = useState<string | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)

  const close = async (sessionId: string) => {
    setClosing(sessionId)
    setCloseError(null)
    try {
      await closeSession.mutateAsync({ nodeId, sessionId })
      await refetch()
    } catch (error: unknown) {
      setCloseError(
        t('terminalPage.shellCloseFailed', 'The shell was not closed: {{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setClosing(null)
    }
  }

  const heading = (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
      {t('terminalPage.shellSessionsTitle', 'Shells running on this node')}
    </h3>
  )

  if (answer.state === 'pending') {
    return (
      <div className="space-y-2">
        {heading}
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  if (answer.state === 'failed') {
    return (
      <div className="space-y-2">
        {heading}
        <ErrorBox
          message={t(
            'terminalPage.shellSessionsFailed',
            'This node did not list its running shells. Try again in a moment.',
          )}
        />
      </div>
    )
  }

  const columns: readonly DataColumn<NodeShellSessionRow>[] = [
    {
      mobile: 'primary',
      key: 'openedBy',
      header: t('terminalPage.colOpenedBy', 'Opened by'),
      sortValue: (row) => row.openedBy ?? '',
      render: (row) =>
        row.openedBy === null ? (
          <span className="text-foreground-subtle">—</span>
        ) : (
          <span className="text-foreground">{names.get(row.openedBy) ?? row.openedBy}</span>
        ),
    },
    {
      mobile: 'detail',
      key: 'started',
      header: t('terminalPage.colStarted', 'Started'),
      sortValue: (row) => row.startedAt,
      // Started and last activity share one cell so the list fits a phone.
      render: (row) => (
        <span className="inline-flex flex-col">
          <span className="text-foreground">{formatRelativeTime(row.startedAt)}</span>
          <span className="text-xs text-foreground-subtle">
            {t('terminalPage.shellLastActivity', 'Last input or output {{when}}', {
              when: formatRelativeTime(row.lastActivityAt),
            })}
          </span>
        </span>
      ),
    },
    {
      mobile: 'keep',
      key: 'actions',
      align: 'right',
      notSortableReason: t('terminalPage.actionsNotSortable', 'Actions'),
      render: (row) =>
        row.sessionId === ownSessionId ? (
          <Badge variant="info">{t('terminalPage.shellThisPage', 'This page')}</Badge>
        ) : (
          <Tooltip>
            <TooltipTrigger>
              <IconButton
                size="sm"
                variant="outline"
                icon={X}
                aria-label={t('terminalPage.shellCloseSession', 'Close')}
                disabled={closing === row.sessionId}
                onClick={() => void close(row.sessionId)}
              />
            </TooltipTrigger>
            <TooltipContent>{t('terminalPage.shellCloseSession', 'Close')}</TooltipContent>
          </Tooltip>
        ),
    },
  ]

  return (
    <div className="space-y-2">
      {heading}
      {closeError !== null && <ErrorBox message={closeError} />}
      {answer.sessions.length === 0 ? (
        <p className="text-xs text-foreground-subtle">
          {t('terminalPage.shellSessionsNone', 'No shell is running on this node.')}
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={answer.sessions}
          rowKey={(row) => row.sessionId}
          minWidthPx={260}
          defaultSort={{ columnKey: 'started', dir: 'desc' }}
        />
      )}
    </div>
  )
}
