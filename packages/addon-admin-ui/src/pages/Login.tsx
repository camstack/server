import type { SecondFactorKind } from '@camstack/sdk'
import { trpc, useThemeMode, Button, Input } from '@camstack/ui-library'
import { ArrowLeft, Eye, EyeOff, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { PasskeyLoginButton } from '../components/login/PasskeyLoginButton'
import { ReleaseIdentityFooter } from '../components/release-identity-footer'
import {
  type LoginMethod,
  PreAuthWidgetMount,
  PrimaryLoginMethods,
  type RedirectLoginMethod,
} from '../components/login/PrimaryLoginMethods'
import {
  needsOriginHint,
  selectSecondFactorMethods,
} from '../components/login/second-factor-selection'
import { useAuth } from '../contexts/auth-context'
import { readStoredSession, sessionFromFragment } from '../lib/admin-session'
import { getSystem } from '../lib/backend'
import { resolveLoginRestorePath } from '../lib/last-location'
import { SEED_ADMIN_PASSWORD } from '../lib/seed-admin'
import {
  parseSsoReturnFragment,
  type SsoReturnErrorCode,
  ssoReturnErrorMessage,
} from '../lib/sso-return'
import {
  openSsoPopup,
  type SsoPopupCompletion,
  watchSsoPopup,
  withPopupFlag,
} from '../lib/sso-popup'
import { readPersistedSession } from './SsoComplete'
import {
  type AppHandoffParams,
  buildAppCallbackUrl,
  parseLoginRedirect,
  consumeAppHandoffParams,
  parseAppHandoffParams,
  rememberAppHandoffParams,
  rememberLoginNext,
  rememberLoginRedirect,
  resolveLoginNext,
  resolveLoginRedirect,
} from '../lib/login-redirect'
import { hubPath } from '../lib/mount'

/** The hub's refusal of a step-up code minted from a session that did not just sign in (D855). */
function isFreshSignInRefusal(caught: unknown): boolean {
  if (typeof caught !== 'object' || caught === null) return false
  const message = Reflect.get(caught, 'message')
  const data: unknown = Reflect.get(caught, 'data')
  const code = typeof data === 'object' && data !== null ? Reflect.get(data, 'code') : undefined
  return (
    code === 'FORBIDDEN' || (typeof message === 'string' && /sign in again first/i.test(message))
  )
}

/** The app's PKCE challenge, state and purpose from the live login URL, or null. */
function readAppHandoffParams(): AppHandoffParams | null {
  const query = new URLSearchParams(window.location.search)
  return parseAppHandoffParams({
    codeChallenge: query.get('code_challenge'),
    codeChallengeMethod: query.get('code_challenge_method'),
    state: query.get('state'),
    purpose: query.get('purpose'),
  })
}

/** Two-phase login state:
 *   • 'credentials'   — username + password form
 *   • 'second-factor' — credentials accepted, awaiting a second factor
 *                       (TOTP code and/or passkey, per `factors`)
 */
type LoginPhase = 'credentials' | 'second-factor'

/** Backoff for the login-method list: 1 s, 2 s, 4 s … capped at 15 s, never giving up. */
function loginMethodsRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 15_000)
}

export function LoginPage() {
  const { t } = useTranslation()
  const { login, verifyTotp, finalizePasskeyLogin, user } = useAuth()
  const { i18n } = useTranslation()
  const theme = useThemeMode()
  const navigate = useNavigate()
  const location = useLocation()
  // `next` — the SERVER-side login bounce: the whole url a cookie-gated hub
  // route was navigated to before it 302'd here. Parked on mount for the same
  // reason `redirect` is (a login leg that leaves this page loses the query
  // string, and for an OAuth authorize request the query string IS the
  // request) and replayed byte for byte by `goNext`.
  const nextParam = new URLSearchParams(window.location.search).get('next')
  useEffect(() => {
    rememberLoginNext(nextParam)
  }, [nextParam])
  // `redirect` — the viewer session-forwarding param: a validated
  // RELATIVE path (the hub-served viewer bouncing through login) or the
  // allowlisted app callback scheme (native handoff). Parked in
  // sessionStorage on mount so it survives login legs that leave this
  // page (OIDC round-trips) and is consumed by `goNext`.
  const redirectParam = new URLSearchParams(window.location.search).get('redirect')
  useEffect(() => {
    rememberLoginRedirect(redirectParam)
  }, [redirectParam])
  // The app's PKCE challenge / state / purpose ride the same URL (D855).
  const handoffParams = readAppHandoffParams()
  useEffect(() => {
    rememberAppHandoffParams(handoffParams)
  }, [handoffParams?.codeChallenge, handoffParams?.state, handoffParams?.purpose])
  // Post-login destination priority: parked `redirect` (viewer session
  // forwarding, consumed in goNext) → explicit `next` (addon OAuth flows,
  // handled separately below) → the location ProtectedRoute interrupted
  // (`state.from`) → the last page visited in a previous session → devices.
  // Never the change-password page: see `resolveLoginRestorePath`.
  const routerState = location.state as { from?: string } | null
  const restorePath = resolveLoginRestorePath(routerState?.from)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 2FA challenge state (only set when a second factor came back).
  const [phase, setPhase] = useState<LoginPhase>('credentials')
  const [challengeToken, setChallengeToken] = useState<string>('')
  const [factors, setFactors] = useState<readonly SecondFactorKind[]>([])
  const [totpCode, setTotpCode] = useState('')
  // An OIDC login of an identity nobody linked (D782) — the provider id, so
  // the message can name it once the login methods have loaded.
  const [ssoNotLinkedProvider, setSsoNotLinkedProvider] = useState<string | null | undefined>(
    undefined,
  )
  // Which SSO refusal the finish reported, with the provider above.
  const [ssoErrorCode, setSsoErrorCode] = useState<SsoReturnErrorCode>('sso-not-linked')

  // Public login-method contributions — the single source of pre-auth
  // login surfaces (OIDC redirects + the passkey widget).
  // An unanswered list is NOT an empty one: it keeps asking (backoff) and the
  // page says the options are still coming, instead of passing as password-only.
  const loginMethodsQuery = trpc.auth.listLoginMethods.useQuery(undefined, {
    retry: true,
    retryDelay: loginMethodsRetryDelay,
  })
  const loginMethodsPending = loginMethodsQuery.data === undefined
  // The `device-certificate` arm is executed by native apps (D855); the web
  // login page has no button for it yet, so it is dropped here, not rendered.
  const loginMethods: readonly LoginMethod[] = (loginMethodsQuery.data ?? []).filter(
    (m): m is LoginMethod => m.kind !== 'device-certificate',
  )
  const serverName = trpc.auth.getServerName.useQuery().data
  const primaryMethods = loginMethods.filter((m) => m.stage === 'primary')
  // Second-factor passkey ceremony: prefer the native `passkey` arm(s)
  // that pass the visibility gate (shell-native, no remote code); fall
  // back to the MF `widget` arm only when no `passkey` arm is USABLE —
  // covers both an addon-auth predating the declarative-login rollout
  // (no `passkey` arm at all) AND a passkey-enrolled user whose gate
  // fails (e.g. a raw-IP origin) — see `second-factor-selection.ts`.
  const secondFactorSelection = selectSecondFactorMethods(loginMethods)

  // `/api/auth/sso/finish` returns here with a fragment when it did NOT mint
  // a session (D782): a linked-OIDC sign-in that still owes an
  // enrolled second factor resumes at the factor step; an unlinked OIDC
  // identity gets a message. The fragment is stripped so a reload starts over.
  useEffect(() => {
    const ret = parseSsoReturnFragment(window.location.hash)
    if (ret === null) return
    window.history.replaceState({}, '', window.location.pathname + window.location.search)
    if (ret.kind === 'challenge') {
      setChallengeToken(ret.challengeToken)
      setFactors(ret.factors)
      setTotpCode('')
      setPhase('second-factor')
      return
    }
    setSsoErrorCode(ret.code)
    setSsoNotLinkedProvider(ret.provider)
  }, [])
  const ssoNotLinkedLabel =
    ssoNotLinkedProvider === undefined || ssoNotLinkedProvider === null
      ? null
      : ((
          loginMethods.find((m) => m.id === ssoNotLinkedProvider && 'label' in m) as
            | { label: string }
            | undefined
        )?.label ?? null)
  const visibleError =
    error ||
    (ssoNotLinkedProvider !== undefined
      ? ssoReturnErrorMessage(ssoErrorCode, ssoNotLinkedLabel)
      : '')
  const { passkeyMethods: secondFactorPasskeyMethods, widgetMethods: secondFactorWidgets } =
    secondFactorSelection

  // Single-flight guard: after an INTERACTIVE login BOTH the submit/verify
  // handler and the already-authenticated auto-forward effect below call
  // `goNext` (the effect fires the moment `user` flips — it cannot tell a
  // mount-time session from a just-completed login). The parked redirect is
  // one-shot, so the second caller used to see nothing parked and
  // `navigate(restorePath)` — yanking the SPA to the dashboard, unmounting
  // the handoff interstitial mid-mint and rewriting the URL so the post-boot
  // remount could never retry. Exactly one caller per page instance may
  // navigate; the loser is a no-op.
  const goNextStarted = useRef(false)

  const goNext = async (): Promise<void> => {
    if (goNextStarted.current) return
    goNextStarted.current = true
    const redirectTarget = resolveLoginRedirect(redirectParam)
    if (redirectTarget?.kind === 'app-callback') {
      // Native viewer handoff: never hand the session itself to the app
      // — mint a one-time 60s code and bounce to the custom scheme.
      // ALWAYS show the interstitial with a real anchor: WebKit may
      // silently refuse a JS-initiated custom-scheme navigation without
      // a user gesture (the sheet then just sat on the dashboard), and a
      // failed mint must be visible + retriable, never a silent
      // fall-through.
      await startAppHandoff(redirectTarget.url)
      return
    } else if (redirectTarget) {
      // Validated RELATIVE path (e.g. the hub-served viewer) — a
      // full-page navigation, since the target lives outside this SPA.
      window.location.assign(hubPath(redirectTarget.path))
      return
    }
    // Validated, not trusted: `next` arrives in a url an attacker can hand an
    // operator, and it used to reach `location.assign` raw — an open redirect
    // that fired the instant the victim signed in.
    const nextTarget = resolveLoginNext(nextParam)
    if (nextTarget) window.location.assign(hubPath(nextTarget))
    else navigate(restorePath, { replace: true })
  }

  // Native-handoff interstitial state: the minted callback URL (rendered
  // as a real anchor — a user tap is a gesture WebKit always honors), the
  // callback base kept for retry, or an error flag on a failed mint.
  const [appHandoff, setAppHandoff] = useState<{
    callbackBase: string
    mintedUrl: string | null
    failed: boolean
  } | null>(null)

  const startAppHandoff = async (callbackBase: string): Promise<void> => {
    setAppHandoff({ callbackBase, mintedUrl: null, failed: false })
    try {
      // A separate session for the app: signing out here never signs it out.
      const binding = readAppHandoffParams() ?? consumeAppHandoffParams()
      if (binding === null) throw new Error('The app sent no PKCE challenge and state')
      const { code } = await getSystem().trpcClient.auth.createHandoffCode.mutate({
        purpose: binding.purpose,
        codeChallenge: binding.codeChallenge,
        state: binding.state,
      })
      const minted = buildAppCallbackUrl(callbackBase, code, binding.state)
      setAppHandoff({ callbackBase, mintedUrl: minted, failed: false })
      // Best-effort auto-hop — the visible anchor below is the reliable path.
      window.location.assign(minted)
    } catch (caught: unknown) {
      // A step-up the hub refuses as "sign in again first" can never succeed
      // from this session (it is too old, or not a sign-in at all): "retry"
      // would loop. Fall back to the sign-in form, keeping the parked handoff
      // params, so a FRESH password / SSO / passkey sign-in mints the code.
      if (isFreshSignInRefusal(caught)) {
        goNextStarted.current = false
        setAppHandoff(null)
        setError('Sign in again to confirm it is you.')
        return
      }
      setAppHandoff({ callbackBase, mintedUrl: null, failed: true })
    }
  }

  // Already authenticated with a forwarding target on board — the hub-served
  // viewer bouncing through, the native handoff sheet opened over a live
  // session, OR a cookie-gated hub route that bounced here (`next`) while the
  // SPA's own token was still good: honor it immediately. The operator must
  // not re-enter credentials they already hold, and for `next` the cost of
  // asking was worse than an annoyance — the page discarded the bounced url
  // and the request it carried was never re-issued at all. One-shot:
  // consumeLoginRedirect/consumeLoginNext clear the parked value, and the
  // guard flips off after the first pass.
  const alreadyAuthed = user !== null
  const [autoForwarded, setAutoForwarded] = useState(false)
  useEffect(() => {
    if (!alreadyAuthed || (!redirectParam && !nextParam) || autoForwarded) return
    setAutoForwarded(true)
    void goNext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alreadyAuthed, redirectParam, nextParam, autoForwarded])

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setError('')
    setSsoNotLinkedProvider(undefined)
    setSubmitting(true)
    try {
      const result = await login(username, password)
      if (result.kind === 'second-factor') {
        // Hold the challenge token in component state — it's short-lived
        // (5 min) bridge state, no value in persisting.
        setChallengeToken(result.challengeToken)
        setFactors(result.factors)
        setPhase('second-factor')
        return
      }
      // The auth context flips `mustChangePassword` synchronously when
      // login succeeds with the seed default — but we can't read the
      // freshly-set state from the same closure. Use the same compare
      // here; the change-password page is the source of truth either
      // way (it re-checks via the auth context).
      if (password === SEED_ADMIN_PASSWORD) {
        navigate('/change-password', { replace: true })
      } else {
        // Shared post-login navigation: parked `redirect` → `next`
        // (full-page — typically a server-rendered addon OAuth route) →
        // interrupted location / last visit.
        await goNext()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleVerifyTotp = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await verifyTotp(challengeToken, totpCode.trim())
      await goNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'TOTP verification failed')
      setTotpCode('')
    } finally {
      setSubmitting(false)
    }
  }

  // Called by a login-method widget (second-factor `passkey-login` OR
  // primary-stage `passkey-direct-login`) once its ceremony mints the
  // session JWT — the shell only persists the session + navigates.
  const handlePasskeyComplete = async (
    token: string,
    session?: { readonly refreshToken?: string; readonly expiresAt?: number },
  ) => {
    try {
      await finalizePasskeyLogin(token, session)
      await goNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey sign-in failed')
    }
  }

  // ── SSO in a popup window (D791) ──────────────────────────────────
  // A redirect sign-in (OIDC) runs in a popup; this page stays, keeps its
  // `next` / `redirect` query, and completes exactly like the full-page
  // return: a session goes through the same finalize + `goNext` as a passkey
  // login, a challenge resumes at the factor step, an unlinked identity shows
  // its message. Not for the native-app handoff sheet — an in-app browser
  // sheet is no place for a second window — nor when the popup is blocked:
  // both navigate the page as before.
  const stopPopupWatch = useRef<(() => void) | null>(null)
  useEffect(() => () => stopPopupWatch.current?.(), [])

  const handlePopupReturn = async (completion: SsoPopupCompletion): Promise<void> => {
    if (completion.target !== 'login') return
    const session = sessionFromFragment(new URLSearchParams(completion.fragment))
    if (session !== null) {
      try {
        await finalizePasskeyLogin(session.token, session)
        await goNext()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed')
      }
      return
    }
    const ret = parseSsoReturnFragment(`#${completion.fragment}`)
    if (ret === null) return
    if (ret.kind === 'challenge') {
      handlePasskeySecondFactor({ challengeToken: ret.challengeToken, factors: ret.factors })
      return
    }
    setSsoErrorCode(ret.code)
    setSsoNotLinkedProvider(ret.provider)
  }

  const handleRedirectMethod = (method: RedirectLoginMethod): boolean => {
    if (parseLoginRedirect(redirectParam)?.kind === 'app-callback') return false
    const popup = openSsoPopup(hubPath(withPopupFlag(method.startUrl)))
    if (popup === null) return false
    setError('')
    setSsoNotLinkedProvider(undefined)
    stopPopupWatch.current?.()
    stopPopupWatch.current = watchSsoPopup(popup, {
      onReturn: (completion) => {
        stopPopupWatch.current?.()
        stopPopupWatch.current = null
        void handlePopupReturn(completion)
      },
      // The opener reference was severed (COOP on the IdP hop): the popup kept
      // the session at THIS origin and only said "done" — read it from here,
      // never from the channel.
      onDone: (signal) => {
        stopPopupWatch.current?.()
        stopPopupWatch.current = null
        if (signal.target !== 'login') return
        const kept = readPersistedSession() === null ? null : readStoredSession()
        if (kept !== null) {
          const fragment = new URLSearchParams({
            token: kept.token,
            ...(kept.refreshToken !== undefined ? { refreshToken: kept.refreshToken } : {}),
            ...(kept.expiresAt !== undefined ? { expiresAt: String(kept.expiresAt) } : {}),
          })
          void handlePopupReturn({ target: 'login', fragment: fragment.toString() })
        }
      },
    })
    return true
  }

  // A primary-stage passkey sign-in can still owe a second factor (TOTP
  // — 2FA applies uniformly after any primary method). The direct-login
  // widget hands the server challenge back through this callback; route
  // it into the SAME second-factor phase the password flow uses. The
  // passkey factor never appears here (the primary WAS the passkey), so
  // in practice this renders the TOTP form.
  const handlePasskeySecondFactor = (outcome: {
    challengeToken: string
    factors: readonly string[]
  }) => {
    const known = outcome.factors.filter(
      (f): f is SecondFactorKind => f === 'totp' || f === 'passkey',
    )
    setChallengeToken(outcome.challengeToken)
    setFactors(known)
    setTotpCode('')
    setError('')
    setPhase('second-factor')
  }

  const handleBackToCredentials = () => {
    setPhase('credentials')
    setChallengeToken('')
    setFactors([])
    setTotpCode('')
    setError('')
  }

  // Native-handoff interstitial — replaces the whole page: minting, the
  // tap-to-return anchor (reliable custom-scheme hop), or a retriable error.
  if (appHandoff !== null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center space-y-4">
          <h1 className="text-sm font-semibold text-foreground">
            {t('login.returningToTheApp', 'Returning to the app…')}
          </h1>
          {appHandoff.failed ? (
            <>
              <p className="text-xs text-danger">
                {t(
                  'login.couldNotPrepareTheSign',
                  'Could not prepare the sign-in handoff. You are logged in — retry below.',
                )}
              </p>
              <Button
                variant="unstyled"
                onClick={() => void startAppHandoff(appHandoff.callbackBase)}
                className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('common.retry', 'Retry')}
              </Button>
            </>
          ) : appHandoff.mintedUrl === null ? (
            <p className="text-xs text-foreground-subtle">
              {t('login.preparingAOneTimeSign', 'Preparing a one-time sign-in code…')}
            </p>
          ) : (
            <>
              <p className="text-xs text-foreground-subtle">
                {t(
                  'login.ifTheAppDoesNot',
                  'If the app does not open automatically, tap below (the code expires in 60s).',
                )}
              </p>
              <a
                href={appHandoff.mintedUrl}
                className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('login.openCamstack', 'Open CamStack')}
              </a>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <img
            src={
              theme?.resolvedMode === 'light'
                ? hubPath('/brand/logo-horizontal-light.svg')
                : hubPath('/brand/logo-horizontal-dark.svg')
            }
            alt={t('login.camstackAdmin', 'CamStack Admin')}
            className="h-12"
          />
        </div>
        {/* The hub's own name (D861), only once somebody chose one: the machine
            hostname is not worth announcing to a signed-out visitor. */}
        {serverName !== undefined && !serverName.isDefault && (
          <p
            data-testid="login-server-name"
            className="-mt-4 mb-6 text-center text-sm text-foreground-muted"
          >
            <Trans
              i18nKey="login.signInTo"
              values={{ name: serverName.name }}
              components={{ b: <span className="font-semibold text-foreground" /> }}
            />
          </p>
        )}

        {/* Form — phase 1: credentials | phase 2: second-factor challenge */}
        {phase === 'credentials' ? (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl shadow-black/10"
          >
            {visibleError && (
              <div
                data-testid="login-error"
                className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger"
              >
                {visibleError}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground-subtle">
                {t('login.username', 'Username')}
              </label>
              <Input
                data-testid="login-username"
                type="text"
                placeholder={t('login.username', 'Username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-disabled focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground-subtle">
                {t('login.password', 'Password')}
              </label>
              <div className="relative">
                <Input
                  data-testid="login-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('login.password', 'Password')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 pr-10 text-sm text-foreground placeholder:text-foreground-disabled focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                />
                <Button
                  variant="unstyled"
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <Button
              variant="unstyled"
              data-testid="login-submit"
              type="submit"
              disabled={submitting || !username || !password}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-50 disabled:shadow-none transition-all"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                  {t('login.loggingIn', 'Logging in...')}
                </span>
              ) : (
                t('login.logIn', 'Log in')
              )}
            </Button>
          </form>
        ) : (
          <div className="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl shadow-black/10">
            <div className="flex items-center gap-2 pb-1 border-b border-border">
              <Smartphone className="h-4 w-4 text-primary" />
              <div className="text-sm font-medium text-foreground">
                {t('login.twoFactorAuthentication', 'Two-factor authentication')}
              </div>
            </div>
            {/* username is empty when the 2FA phase was reached via a
                passkey-first sign-in (no credentials form). */}
            <p className="text-xs text-foreground-subtle">
              {username ? (
                <>
                  <Trans
                    i18nKey="login.finishSigningInAs"
                    values={{ username }}
                    components={{ mono: <span className="font-mono text-foreground" /> }}
                  />
                </>
              ) : (
                t('login.finishSigningInAs', 'Finish signing in.')
              )}
            </p>

            {error && (
              <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
                {error}
              </div>
            )}

            {/* Passkey second factor — native ceremony when the auth addon
                contributes a `passkey` arm THAT PASSES the visibility gate
                (browser support + origin/rpId); falls back to the MF
                `widget` path whenever no `passkey` arm is usable — no
                arm contributed at all (an addon-auth predating the
                declarative-login rollout), OR a `passkey` arm exists but
                its gate failed (e.g. a raw-IP origin) — see
                `second-factor-selection.ts`. Gated on the user actually
                having the `passkey` factor enrolled. */}
            {factors.includes('passkey') &&
              secondFactorPasskeyMethods.map((m) => (
                <PasskeyLoginButton
                  key={m.id}
                  method={m}
                  challengeToken={challengeToken}
                  onComplete={handlePasskeyComplete}
                />
              ))}

            {factors.includes('passkey') &&
              secondFactorWidgets.map((m) => (
                <PreAuthWidgetMount
                  key={m.id}
                  method={m}
                  config={{ challengeToken, onComplete: handlePasskeyComplete }}
                />
              ))}

            {/* Empty-state dead-end guard: a passkey-only 2FA challenge
                reached over a raw-IP origin gates the native ceremony out
                AND contributes no widget fallback AND has no TOTP factor
                to fall back to — the phase would otherwise render nothing
                actionable. Show an informational hint pointing at the
                domain URL instead of a blank card. */}
            {needsOriginHint(factors, secondFactorSelection) && (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground-subtle">
                {t(
                  'login.passkeyVerificationIsnTAvailable',
                  "Passkey verification isn't available on this address. Open the hub via its domain URL to complete sign-in.",
                )}
              </div>
            )}

            {factors.includes('passkey') && factors.includes('totp') && (
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">
                  or
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}

            {factors.includes('totp') && (
              <form onSubmit={handleVerifyTotp} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground-subtle">
                    {t('login.authenticationCode', 'Authentication code')}
                  </label>
                  <Input
                    data-testid="login-totp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="w-full rounded-lg border border-border bg-background px-3 py-3 text-center text-2xl font-mono tracking-widest text-foreground placeholder:text-foreground-disabled focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                    autoFocus
                  />
                </div>

                <Button
                  variant="unstyled"
                  data-testid="login-totp-submit"
                  type="submit"
                  disabled={submitting || totpCode.length !== 6}
                  className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-50 disabled:shadow-none transition-all"
                >
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                      {t('login.verifying', 'Verifying...')}
                    </span>
                  ) : (
                    t('login.verifyAndSignIn', 'Verify and sign in')
                  )}
                </Button>
              </form>
            )}

            <Button
              variant="unstyled"
              type="button"
              onClick={handleBackToCredentials}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-foreground-subtle hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              {t('login.backToUsernamePassword', 'Back to username + password')}
            </Button>
          </div>
        )}

        {phase === 'credentials' && loginMethodsPending && (
          <p
            data-testid="login-methods-pending"
            role="status"
            className="mt-4 flex items-center justify-center gap-2 text-xs text-foreground-subtle"
          >
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-foreground-subtle/30 border-t-foreground-subtle" />
            {t('login.methodsPending', 'Loading other sign-in options...')}
          </p>
        )}

        {phase === 'credentials' && (
          <PrimaryLoginMethods
            methods={primaryMethods}
            widgetConfig={{
              onComplete: handlePasskeyComplete,
              onSecondFactor: handlePasskeySecondFactor,
              locale: i18n.language,
            }}
            onRedirect={handleRedirectMethod}
          />
        )}

        <p className="mt-6 text-center text-[10px] text-foreground-subtle/50">
          <ReleaseIdentityFooter placement="login" />
        </p>
      </div>
    </div>
  )
}
