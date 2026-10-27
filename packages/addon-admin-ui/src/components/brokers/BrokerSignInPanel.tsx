/**
 * `BrokerSignInPanel` is the interactive sign-in a broker kind declares
 * (`signIn.basePath`). The operator presses one button, the panel starts the
 * server-held session, offers the link to the account's own sign-in page
 * (email, password and any one-time code are typed THERE, never here), polls
 * until the account is captured and then commits it onto the broker.
 *
 * Nothing in this file names a kind: the contract is the descriptor's, the
 * request body is the form's settings, and the result is a broker id.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, LogIn } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, ErrorBox } from '@camstack/ui-library'
import {
  cancelBrokerSignIn,
  commitBrokerSignIn,
  getBrokerSignInStatus,
  startBrokerSignIn,
} from '../../lib/broker-sign-in'

const POLL_INTERVAL_MS = 2000

/**
 * The sign-in page is served by the hub itself (the addon's login proxy, same HTTPS
 * origin as this page), so the server answers a hub-relative path.
 */
function openableLoginUrl(loginUrl: string): string {
  return loginUrl.startsWith('/') && !loginUrl.startsWith('//')
    ? new URL(loginUrl, window.location.origin).toString()
    : loginUrl
}

type Flow =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'waiting'
      readonly loginUrl: string
      readonly ready: boolean
    }
  | { readonly kind: 'committing' }
  | { readonly kind: 'error'; readonly message: string }

export interface BrokerSignInPanelProps {
  /** The kind's `signIn.basePath`. */
  readonly basePath: string
  /** Name for a NEW broker; ignored when `brokerId` re-links an existing one. */
  readonly name: string
  /** Re-link this broker instead of creating one. */
  readonly brokerId?: string
  /** The form's current settings, sent to `start`. */
  readonly getSettings: () => Record<string, unknown>
  readonly disabled?: boolean
  readonly onSignedIn: (brokerId: string) => void
}

export function BrokerSignInPanel({
  basePath,
  name,
  brokerId,
  getSettings,
  disabled,
  onSignedIn,
}: BrokerSignInPanelProps) {
  const { t } = useTranslation()
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' })
  const mounted = useRef(true)
  const sessionId = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback((): void => {
    if (timer.current !== null) clearInterval(timer.current)
    timer.current = null
  }, [])

  const dropSession = useCallback((): void => {
    stopPolling()
    const id = sessionId.current
    sessionId.current = null
    if (id !== null) void cancelBrokerSignIn(basePath, id)
  }, [basePath, stopPolling])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      dropSession()
    }
  }, [dropSession])

  const fail = useCallback(
    (message: string): void => {
      stopPolling()
      if (mounted.current) setFlow({ kind: 'error', message })
    },
    [stopPolling],
  )

  const commit = useCallback(
    async (id: string): Promise<void> => {
      stopPolling()
      if (mounted.current) setFlow({ kind: 'committing' })
      try {
        const result = await commitBrokerSignIn(basePath, {
          sessionId: id,
          name,
          ...(brokerId !== undefined ? { brokerId } : {}),
        })
        sessionId.current = null
        if (mounted.current) onSignedIn(result.brokerId)
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err))
      }
    },
    [basePath, brokerId, fail, name, onSignedIn, stopPolling],
  )

  const poll = useCallback(
    (id: string): void => {
      stopPolling()
      timer.current = setInterval(() => {
        void (async () => {
          try {
            const status = await getBrokerSignInStatus(basePath, id)
            if (status.phase === 'captured') return void (await commit(id))
            if (status.phase === 'error') {
              return fail(status.error ?? t('brokers.signIn.proxyError'))
            }
            if (status.phase === 'cancelled') {
              stopPolling()
              if (mounted.current) setFlow({ kind: 'idle' })
              return
            }
            if (mounted.current) {
              setFlow({
                kind: 'waiting',
                loginUrl: status.loginUrl,
                ready: status.phase === 'awaiting-login',
              })
            }
          } catch {
            // A transient poll failure keeps polling; the session decides when it is over.
          }
        })()
      }, POLL_INTERVAL_MS)
    },
    [basePath, commit, fail, stopPolling, t],
  )

  const start = async (): Promise<void> => {
    dropSession()
    setFlow({ kind: 'starting' })
    try {
      const started = await startBrokerSignIn(basePath, getSettings())
      sessionId.current = started.sessionId
      setFlow({ kind: 'waiting', loginUrl: started.loginUrl, ready: false })
      poll(started.sessionId)
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }

  const cancel = (): void => {
    dropSession()
    setFlow({ kind: 'idle' })
  }

  if (flow.kind === 'idle' || flow.kind === 'error') {
    return (
      <div className="space-y-2">
        {flow.kind === 'error' && <ErrorBox message={flow.message} />}
        <p className="text-xs text-foreground-muted">{t('brokers.signIn.intro')}</p>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled === true || name.trim().length === 0}
          onClick={() => void start()}
        >
          <LogIn className="h-3.5 w-3.5" />{' '}
          {flow.kind === 'error' ? t('common.retry') : t('brokers.signIn.start')}
        </Button>
      </div>
    )
  }

  if (flow.kind === 'starting' || flow.kind === 'committing') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
        {flow.kind === 'starting' ? t('brokers.signIn.starting') : t('brokers.signIn.saving')}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
      {flow.ready ? (
        <>
          <p className="text-xs font-semibold text-foreground">{t('brokers.signIn.openLink')}</p>
          <p className="text-[11px] text-foreground-subtle">{t('brokers.signIn.afterLogin')}</p>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              window.open(openableLoginUrl(flow.loginUrl), '_blank', 'noopener,noreferrer')
            }
          >
            <ExternalLink className="h-3.5 w-3.5" /> {t('brokers.signIn.openLoginPage')}
          </Button>
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
          {t('brokers.signIn.waitingForProxy')}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="flex items-center gap-2 text-[11px] text-foreground-subtle">
          <Loader2 className="h-3 w-3 animate-spin" /> {t('brokers.signIn.waitingForLogin')}
        </span>
        <Button variant="outline" size="sm" onClick={cancel}>
          {t('brokers.signIn.cancel')}
        </Button>
      </div>
    </div>
  )
}
