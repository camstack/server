/**
 * Full-page server shell for one node: `/system/terminal/:nodeId/:sessionId`.
 *
 * Reuses `<TerminalPanel>`. The node list is the nodes whose registry answer
 * says they run `terminal-session` — pending is not "not installed" (D315).
 * Opening is refused, with the provider's reason, while that node's opt-in is off.
 */
import {
  Button,
  EmptyState,
  ErrorBox,
  NodePicker,
  Skeleton,
  useCapabilityNodePresence,
  useCapabilityPresence,
  useTerminalSessionClose,
  useTerminalSessionListSessions,
  useTerminalSessionOpenSession,
  useTerminalSessionServerShellStatus,
} from '@camstack/ui-library'
import { Terminal as TerminalIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { TerminalPanel } from '../../components/TerminalPanel'

const TERMINAL_CAPABILITY = 'terminal-session'
const SERVER_SHELL_PROFILE_ID = 'server-shell'
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

export function ServerShellPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { nodeId = '', sessionId } = useParams()
  const presence = useCapabilityPresence(TERMINAL_CAPABILITY)
  const nodePresence = useCapabilityNodePresence(TERMINAL_CAPABILITY)
  const nodeState = nodeId === '' ? 'absent' : nodePresence.onNode(nodeId)
  const nodeReady = presence === 'present' && nodeState === 'present'
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()
  const sessions = useTerminalSessionListSessions(
    { nodeId },
    { enabled: nodeReady && sessionId === undefined },
  )
  const status = useTerminalSessionServerShellStatus({ nodeId }, { enabled: nodeReady })
  const [openError, setOpenError] = useState<string | null>(null)
  const openingFor = useRef<string | null>(null)
  const openMutate = useRef(openSession.mutateAsync)
  openMutate.current = openSession.mutateAsync

  useEffect(() => {
    if (!nodeReady || sessionId !== undefined) return
    if (status.data?.enabled !== true || sessions.data === undefined) return
    if (openingFor.current === nodeId) return
    openingFor.current = nodeId
    const existing = sessions.data.find((session) => session.profileId === SERVER_SHELL_PROFILE_ID)
    if (existing) {
      navigate(`/system/terminal/${nodeId}/${existing.sessionId}`, { replace: true })
      return
    }
    void openMutate
      .current({
        nodeId,
        profileId: SERVER_SHELL_PROFILE_ID,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      })
      .then((opened) => {
        navigate(`/system/terminal/${nodeId}/${opened.sessionId}`, { replace: true })
      })
      .catch((error: unknown) => {
        openingFor.current = null
        setOpenError(error instanceof Error ? error.message : String(error))
      })
  }, [nodeReady, sessionId, status.data, sessions.data, nodeId, navigate])

  const title = t('terminalPage.serverShell', 'Server shell')
  const picker = (
    <NodePicker
      selectedNodeId={nodeId}
      onSelect={(next) => {
        openingFor.current = null
        setOpenError(null)
        navigate(`/system/terminal/${next}`)
      }}
      requiresCapability={TERMINAL_CAPABILITY}
      alwaysShow
    />
  )

  if (presence === 'pending' || nodeState === 'pending') {
    return (
      <AdminPage icon={TerminalIcon} title={title} nav={picker}>
        <div
          aria-busy="true"
          aria-label={t('terminalPage.serverShellLoading', 'Checking which nodes run a terminal')}
        >
          <Skeleton className="h-40 w-full" />
        </div>
      </AdminPage>
    )
  }

  if (presence === 'unknown' || nodeState === 'unknown') {
    return (
      <AdminPage icon={TerminalIcon} title={title} nav={picker}>
        <ErrorBox
          message={t(
            'terminalPage.serverShellUnknown',
            'The terminal registry did not answer. Try again in a moment.',
          )}
        />
      </AdminPage>
    )
  }

  if (presence === 'absent' || nodeState === 'absent') {
    return (
      <AdminPage icon={TerminalIcon} title={title} nav={picker}>
        <EmptyState
          icon={TerminalIcon}
          title={t('terminalPage.serverShellAbsent', 'Terminal is not installed on this node')}
        />
      </AdminPage>
    )
  }

  const refusal = status.data?.enabled === false ? status.data.refusal : null

  return (
    <AdminPage
      icon={TerminalIcon}
      title={title}
      subtitle={t(
        'terminalPage.serverShellSubtitle',
        'A login shell in this node’s data directory. It stays open after you leave, and closes when it sits idle.',
      )}
      nav={picker}
      actions={
        <Button variant="outline" onClick={() => navigate('/system/terminal')}>
          {t('terminalPage.backToTerminals', 'Terminals')}
        </Button>
      }
    >
      {status.isPending && <Skeleton className="h-16 w-full" />}
      {refusal && (
        <ErrorBox
          variant="warning"
          title={t('terminalPage.serverShellOff', 'Server shell is off')}
          message={refusal.message}
          action={
            <Link className="text-sm text-primary underline" to="/system/terminal">
              {t('terminalPage.serverShellSettings', 'Turn it on in Terminal settings')}
            </Link>
          }
        />
      )}
      {openError && <ErrorBox message={openError} />}
      {sessionId && (
        <div className="flex h-[70vh] min-h-64 flex-col">
          <div className="mb-2 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={closeSession.isPending}
              onClick={() => {
                void closeSession
                  .mutateAsync({ nodeId, sessionId })
                  .then(() => navigate(`/system/terminal/${nodeId}`, { replace: true }))
              }}
            >
              {t('common.close', 'Close')}
            </Button>
          </div>
          <TerminalPanel fill nodeId={nodeId} sessionId={sessionId} />
        </div>
      )}
    </AdminPage>
  )
}
