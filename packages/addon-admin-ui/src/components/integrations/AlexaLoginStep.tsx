/**
 * `AlexaLoginStep` — interactive Amazon proxy-login for the integration wizard.
 *
 * Drives the four-endpoint addon-routes control plane that the
 * `addon-import-alexa` backend exposes:
 *
 *   POST /addon/import-alexa/login/start   { amazonDomain }
 *     → { sessionId, loginUrl }
 *   GET  /addon/import-alexa/login/status?sessionId=…
 *     → { phase, loginUrl, error, … }      (poll until `captured` | `error`)
 *   POST /addon/import-alexa/login/commit  { sessionId, name, brokerId? }
 *     → { brokerId }
 *   POST /addon/import-alexa/login/cancel  { sessionId }
 *
 * Lifecycle:
 *   1. Operator picks an Amazon domain, clicks "Start login".
 *   2. Component POSTs /login/start and polls /login/status until
 *      `phase === 'awaiting-login'`, then shows a "Login to Amazon" button
 *      opening `loginUrl` in a new tab.
 *   3. Polling continues; on `phase === 'captured'` the component POSTs
 *      /login/commit and calls `onResolved(brokerId)`.
 *   4. On unmount or "Cancel", POSTs /login/cancel.
 *
 * Reachability note surfaced in the UI: the proxy `loginUrl` host:port must be
 * reachable from the operator's browser. On a containerised hub the operator
 * may need to configure `proxyHost` in the addon settings and ensure the proxy
 * port is published.
 *
 * No tRPC hooks are available for addon-routes; all calls are plain `fetch`
 * against the same origin with `Authorization: Bearer <token>` (matching the
 * repo-wide admin-ui convention). All response shapes are narrowed with type
 * guards rather than casts.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react'
import { hubPath } from '../../lib/mount'
import { Trans, useTranslation } from 'react-i18next'

// ── Amazon domain allowlist ───────────────────────────────────────────────────
// Must stay in sync with the server-side `AMAZON_DOMAINS` enum in
// `packages/addon-import-alexa/src/alexa-login-routes.ts`.
const AMAZON_DOMAINS = [
  'amazon.com',
  'amazon.it',
  'amazon.de',
  'amazon.co.uk',
  'amazon.fr',
  'amazon.es',
  'amazon.ca',
  'amazon.com.au',
  'amazon.co.jp',
  'amazon.in',
  'amazon.com.br',
  'amazon.com.mx',
] as const

type AmazonDomain = (typeof AMAZON_DOMAINS)[number]

// ── Proxy login phase types ────────────────────────────────────────────────────
type AlexaProxyLoginPhase = 'starting' | 'awaiting-login' | 'captured' | 'error' | 'cancelled'

interface AlexaLoginStartResult {
  readonly sessionId: string
  readonly loginUrl: string
  readonly amazonDomain: string
}

interface AlexaLoginStatus {
  readonly sessionId: string
  readonly phase: AlexaProxyLoginPhase
  readonly loginUrl: string
  readonly amazonDomain: string
  readonly error: string | null
  readonly startedAt: number
  readonly capturedAt: number | null
}

interface AlexaLoginCommitResult {
  readonly brokerId: string
}

// ── Internal component state ──────────────────────────────────────────────────
type LoginFlowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'polling'
      readonly sessionId: string
      readonly loginUrl: string
      readonly phase: AlexaProxyLoginPhase
    }
  | { readonly kind: 'committing'; readonly sessionId: string }
  | { readonly kind: 'error'; readonly message: string; readonly sessionId: string | null }

// ── API helpers ───────────────────────────────────────────────────────────────
const ADDON_BASE = hubPath('/addon/import-alexa')
const POLL_INTERVAL_MS = 2000

function isAlexaLoginStartResult(val: unknown): val is AlexaLoginStartResult {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as { sessionId?: unknown }).sessionId === 'string' &&
    typeof (val as { loginUrl?: unknown }).loginUrl === 'string'
  )
}

function isAlexaLoginStatus(val: unknown): val is AlexaLoginStatus {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as { phase?: unknown }).phase === 'string' &&
    typeof (val as { sessionId?: unknown }).sessionId === 'string'
  )
}

function isAlexaLoginCommitResult(val: unknown): val is AlexaLoginCommitResult {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as { brokerId?: unknown }).brokerId === 'string'
  )
}

function adminAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = localStorage.getItem('camstack_admin_token') ?? ''
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }
}

async function apiPost<T>(
  path: string,
  body: Record<string, unknown>,
  guard: (v: unknown) => v is T,
): Promise<T> {
  const res = await fetch(`${ADDON_BASE}${path}`, {
    method: 'POST',
    headers: adminAuthHeaders(),
    body: JSON.stringify(body),
  })
  const json: unknown = await res.json()
  if (!res.ok) {
    const errField =
      json !== null && typeof json === 'object'
        ? ((json as { error?: unknown }).error ?? 'Unknown error')
        : 'Unknown error'
    throw new Error(String(errField))
  }
  if (!guard(json)) {
    throw new Error('Unexpected response from server')
  }
  return json
}

async function apiGetStatus(sessionId: string): Promise<AlexaLoginStatus> {
  const params = new URLSearchParams({ sessionId })
  const token = localStorage.getItem('camstack_admin_token') ?? ''
  const res = await fetch(`${ADDON_BASE}/login/status?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const json: unknown = await res.json()
  if (!res.ok) {
    const errField =
      json !== null && typeof json === 'object'
        ? ((json as { error?: unknown }).error ?? 'Unknown error')
        : 'Unknown error'
    throw new Error(String(errField))
  }
  if (!isAlexaLoginStatus(json)) {
    throw new Error('Unexpected status response from server')
  }
  return json
}

async function cancelSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${ADDON_BASE}/login/cancel`, {
      method: 'POST',
      headers: adminAuthHeaders(),
      body: JSON.stringify({ sessionId }),
    })
  } catch {
    // Best-effort: cancel on unmount/navigation; ignore network errors.
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface AlexaLoginStepProps {
  /**
   * Existing broker id to re-link (credentials swapped). Omit to create a
   * fresh broker (the `name` field is then shown for the new broker).
   */
  readonly brokerId?: string
  /**
   * Called with the resolved broker id once the cookie is committed. The
   * wizard then proceeds to device discovery / adoption as normal.
   */
  readonly onResolved: (brokerId: string) => void
  /** Return to the previous view without committing anything. */
  readonly onCancel: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────
export function AlexaLoginStep({ brokerId, onResolved, onCancel }: AlexaLoginStepProps) {
  const { t } = useTranslation()
  const [domain, setDomain] = useState<AmazonDomain>('amazon.it')
  const [name, setName] = useState<string>('Alexa account')
  const [flow, setFlow] = useState<LoginFlowState>({ kind: 'idle' })

  // Guard against setState-after-unmount for in-flight async operations.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Keep a ref to the active sessionId so the cleanup effect can cancel it
  // without capturing stale closure state.
  const activeSessionId = useRef<string | null>(null)

  // ── Polling ────────────────────────────────────────────────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback((): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Commit (POST /login/commit) once a captured status is confirmed.
  const commit = useCallback(
    async (sessionId: string): Promise<void> => {
      stopPolling()
      if (mountedRef.current) setFlow({ kind: 'committing', sessionId })
      try {
        const result = await apiPost(
          '/login/commit',
          {
            sessionId,
            name: name.trim().length > 0 ? name.trim() : 'Alexa account',
            ...(brokerId !== undefined ? { brokerId } : {}),
          },
          isAlexaLoginCommitResult,
        )
        activeSessionId.current = null
        onResolved(result.brokerId)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (mountedRef.current) setFlow({ kind: 'error', message, sessionId })
      }
    },
    [brokerId, name, onResolved, stopPolling],
  )

  const startPolling = useCallback(
    (sessionId: string, loginUrl: string): void => {
      stopPolling()
      const tick = async (): Promise<void> => {
        try {
          const status = await apiGetStatus(sessionId)
          if (status.phase === 'captured') {
            stopPolling()
            void commit(sessionId)
            return
          }
          if (status.phase === 'error') {
            stopPolling()
            if (mountedRef.current)
              setFlow({
                kind: 'error',
                message:
                  status.error ??
                  t(
                    'integrations.alexaLoginStep.loginProxyReturnedAnError',
                    'Login proxy returned an error',
                  ),
                sessionId,
              })
            return
          }
          if (status.phase === 'cancelled') {
            stopPolling()
            if (mountedRef.current) setFlow({ kind: 'idle' })
            return
          }
          if (mountedRef.current)
            setFlow({
              kind: 'polling',
              sessionId,
              loginUrl: status.loginUrl || loginUrl,
              phase: status.phase,
            })
        } catch (err: unknown) {
          // Transient fetch error — keep polling; surface if it persists.
          const message = err instanceof Error ? err.message : String(err)
          if (mountedRef.current)
            setFlow((prev) =>
              prev.kind === 'polling' ? { ...prev } : { kind: 'error', message, sessionId: null },
            )
        }
      }
      pollRef.current = setInterval(() => {
        void tick()
      }, POLL_INTERVAL_MS)
    },
    [stopPolling, commit, t],
  )

  // Cancel the active session on unmount.
  useEffect(() => {
    return () => {
      stopPolling()
      if (activeSessionId.current !== null) {
        void cancelSession(activeSessionId.current)
      }
    }
  }, [stopPolling])

  // ── Start login ────────────────────────────────────────────────────────────
  const handleStart = async (): Promise<void> => {
    stopPolling()
    if (activeSessionId.current !== null) {
      void cancelSession(activeSessionId.current)
      activeSessionId.current = null
    }
    setFlow({ kind: 'starting' })
    try {
      const result = await apiPost(
        '/login/start',
        { amazonDomain: domain },
        isAlexaLoginStartResult,
      )
      activeSessionId.current = result.sessionId
      setFlow({
        kind: 'polling',
        sessionId: result.sessionId,
        loginUrl: result.loginUrl,
        phase: 'starting',
      })
      startPolling(result.sessionId, result.loginUrl)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setFlow({ kind: 'error', message, sessionId: null })
    }
  }

  // ── Cancel / retry ─────────────────────────────────────────────────────────
  const handleCancel = (): void => {
    stopPolling()
    if (activeSessionId.current !== null) {
      void cancelSession(activeSessionId.current)
      activeSessionId.current = null
    }
    setFlow({ kind: 'idle' })
  }

  const handleRetry = (): void => {
    handleCancel()
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  const isIdle = flow.kind === 'idle'
  const isStarting = flow.kind === 'starting'
  const isPolling = flow.kind === 'polling'
  const isCommitting = flow.kind === 'committing'
  const isError = flow.kind === 'error'
  const isInFlight = isStarting || isPolling || isCommitting

  const pollingPhase = flow.kind === 'polling' ? flow.phase : null
  const loginUrl = flow.kind === 'polling' ? flow.loginUrl : null
  const showLoginButton = isPolling && pollingPhase === 'awaiting-login'
  const showWaiting = isPolling && (pollingPhase === 'starting' || pollingPhase === null)

  return (
    <div className="space-y-4">
      {/* Domain + name fields — only when idle or errored */}
      {(isIdle || isError) && (
        <div className="space-y-3">
          {brokerId === undefined && (
            <div className="space-y-1">
              <label
                htmlFor="alexa-account-name"
                className="text-[10px] uppercase tracking-wide text-foreground-subtle"
              >
                {t('integrations.alexaLoginStep.accountName', 'Account name')}
              </label>
              <input
                id="alexa-account-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('integrations.alexaLoginStep.alexaAccount', 'Alexa account')}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          <div className="space-y-1">
            <label
              htmlFor="alexa-amazon-region"
              className="text-[10px] uppercase tracking-wide text-foreground-subtle"
            >
              {t('integrations.alexaLoginStep.amazonRegion', 'Amazon region')}
            </label>
            <select
              id="alexa-amazon-region"
              value={domain}
              onChange={(e) => setDomain(e.target.value as AmazonDomain)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {AMAZON_DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Error banner */}
      {isError && (
        <div className="rounded border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[11px] flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{flow.message}</span>
        </div>
      )}

      {/* In-flight states */}
      {isStarting && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-xs text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
          {t('integrations.alexaLoginStep.startingLoginProxy', 'Starting login proxy…')}
        </div>
      )}

      {showWaiting && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-xs text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
          {t('integrations.alexaLoginStep.waitingForProxyToBe', 'Waiting for proxy to be ready…')}
        </div>
      )}

      {isCommitting && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-xs text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
          {t('integrations.alexaLoginStep.savingCredentials', 'Saving credentials…')}
        </div>
      )}

      {/* Login button — shown once the proxy is ready */}
      {showLoginButton && loginUrl !== null && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
            <p className="text-xs font-semibold text-foreground">
              {t(
                'integrations.alexaLoginStep.openTheLinkBelowTo',
                'Open the link below to log in to your Amazon account',
              )}
            </p>
            <p className="text-[10px] text-foreground-subtle">
              {t(
                'integrations.alexaLoginStep.afterCompletingTheLoginAnd',
                'After completing the login and any 2FA steps, this wizard will continue automatically.',
              )}
            </p>
            <a
              href={loginUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('integrations.alexaLoginStep.loginToAmazon', 'Login to Amazon')}
            </a>
          </div>

          {/* Reachability hint */}
          <div className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-[10px] text-warning">
            <Trans
              i18nKey="integrations.alexaLoginStep.proxyNote"
              components={{ b: <strong />, code: <code className="font-mono" /> }}
            />
          </div>

          <div className="flex items-center gap-2 text-[10px] text-foreground-subtle">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t(
              'integrations.alexaLoginStep.waitingForAmazonLoginTo',
              'Waiting for Amazon login to complete…',
            )}
          </div>
        </div>
      )}

      {/* Action row */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={isInFlight ? handleCancel : onCancel}
          className="rounded px-3 py-1.5 text-xs text-foreground-subtle border border-border hover:text-foreground"
        >
          {isInFlight
            ? t('integrations.alexaLoginStep.cancelLogin', 'Cancel login')
            : t('common.back', 'Back')}
        </button>

        <div className="flex items-center gap-2">
          {isError && (
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-primary/10"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('common.retry', 'Retry')}
            </button>
          )}

          {isIdle && (
            <button
              type="button"
              onClick={() => {
                void handleStart()
              }}
              disabled={brokerId === undefined && name.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t('integrations.alexaLoginStep.startLogin', 'Start login')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
