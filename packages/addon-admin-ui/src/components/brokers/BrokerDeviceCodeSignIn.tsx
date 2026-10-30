/**
 * `BrokerDeviceCodeSignIn` is the device-code method of a kind's interactive
 * sign-in. The panel starts a server-held session, shows the one-time code, and
 * the operator types it on the account's own page (opened from here); nothing
 * secret is typed in this dialog. It polls until the account is captured and
 * then commits it onto the broker.
 *
 * Nothing in this file names a kind: the contract is the descriptor's.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, LogIn, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton, ErrorBox } from '@camstack/ui-library'
import {
  cancelBrokerSignIn,
  commitBrokerSignIn,
  getDeviceCodeStatus,
  startDeviceCodeSignIn,
  type DeviceCodeStarted,
} from '../../lib/broker-sign-in'

const POLL_INTERVAL_MS = 2000
const TICK_MS = 1000

type Flow =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting'; readonly code: DeviceCodeStarted }
  | { readonly kind: 'expired' }
  | { readonly kind: 'committing' }
  | { readonly kind: 'error'; readonly message: string }

export interface BrokerDeviceCodeSignInProps {
  readonly basePath: string
  readonly name: string
  readonly brokerId?: string
  readonly getSettings: () => Record<string, unknown>
  readonly disabled?: boolean
  readonly onSignedIn: (brokerId: string) => void
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function Countdown({ expiresAt }: { readonly expiresAt: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="text-[11px] text-foreground-subtle">
      {t('brokers.signIn.codeExpiresIn', {
        time: formatRemaining(expiresAt - now),
      })}
    </span>
  )
}

export function BrokerDeviceCodeSignIn({
  basePath,
  name,
  brokerId,
  getSettings,
  disabled,
  onSignedIn,
}: BrokerDeviceCodeSignInProps) {
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
            const status = await getDeviceCodeStatus(basePath, id)
            if (status.phase === 'captured') return void (await commit(id))
            if (status.phase === 'error') {
              return fail(status.error ?? t('brokers.signIn.proxyError'))
            }
            if (status.phase === 'expired') {
              stopPolling()
              if (mounted.current) setFlow({ kind: 'expired' })
              return
            }
            if (status.phase === 'cancelled') {
              stopPolling()
              if (mounted.current) setFlow({ kind: 'idle' })
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
      const started = await startDeviceCodeSignIn(basePath, getSettings())
      sessionId.current = started.sessionId
      setFlow({ kind: 'waiting', code: started })
      poll(started.sessionId)
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }

  const cancel = (): void => {
    dropSession()
    setFlow({ kind: 'idle' })
  }

  if (flow.kind === 'idle' || flow.kind === 'error' || flow.kind === 'expired') {
    return (
      <div className="space-y-2">
        {flow.kind === 'error' && <ErrorBox message={flow.message} />}
        {flow.kind === 'expired' && (
          <p className="text-xs text-warning">{t('brokers.signIn.codeExpired')}</p>
        )}
        <p className="text-xs text-foreground-muted">{t('brokers.signIn.codeIntro')}</p>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled === true || name.trim().length === 0}
          onClick={() => void start()}
        >
          {flow.kind === 'idle' ? (
            <LogIn className="h-3.5 w-3.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}{' '}
          {flow.kind === 'idle' ? t('brokers.signIn.getCode') : t('brokers.signIn.newCode')}
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

  const { code } = flow
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-foreground-muted">{t('brokers.signIn.codeInstructions')}</p>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-background px-3 py-2">
        <span
          data-testid="device-code"
          className="font-mono text-2xl font-semibold tracking-widest text-foreground break-all"
        >
          {code.userCode}
        </span>
        <CopyButton value={code.userCode} srLabel={t('brokers.signIn.copyCode')} />
      </div>
      <Button
        variant="primary"
        size="sm"
        onClick={() => window.open(code.verificationUrl, '_blank', 'noopener,noreferrer')}
      >
        <ExternalLink className="h-3.5 w-3.5" />{' '}
        {t('brokers.signIn.openCodePage', {
          host: safeHost(code.verificationUrl),
        })}
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="flex min-w-0 flex-col text-[11px] text-foreground-subtle">
          <span className="flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />{' '}
            {t('brokers.signIn.waitingForCode')}
          </span>
          <Countdown expiresAt={code.expiresAt} />
        </span>
        <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={cancel}>
          {t('brokers.signIn.cancel')}
        </Button>
      </div>
    </div>
  )
}

/** `host/path` of the verification page, for the button label; the raw string when it is not a URL. */
function safeHost(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}
