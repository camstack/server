/**
 * Where every OAuth round-trip ends (`/sso-complete#return=oauth&…`): a sign-in
 * to a broker, a sign-out, an account link, or a refusal on the way. The hub's
 * callbacks redirect here instead of answering with a bare text page, so the
 * operator stays in CamStack.
 *
 * A POPUP hands the outcome to the window that opened it and closes
 * (`deliverOauthOutcome`); a full-page flow (a PWA, a blocked popup) lands
 * here, says what happened, and returns to the integration page by itself
 * after a success. A failure never returns on its own: the reason stays up.
 * The outcome is a status plus a reason CODE — the words are this page's, in
 * the operator's language.
 */
import type { OauthLandingOutcome, OauthLandingReason } from '@camstack/types'
import { parseOauthLandingFragment } from '@camstack/types'
import { Button } from '@camstack/ui-library'
import { CheckCircle2, XCircle } from 'lucide-react'
import { useEffect, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import type { Root } from 'react-dom/client'
import { deliverOauthOutcome, OAUTH_RETURN_DELAY_MS, oauthReturnPath } from '../lib/oauth-landing'
import { hubPath } from '../lib/mount'

/** How long a `window.close()` gets before the page stays and says so. */
const CLOSE_GRACE_MS = 500

export interface OauthLandingPageProps {
  readonly outcome: OauthLandingOutcome
  /** The window was opened by script (a popup): it can be closed. */
  readonly closable: boolean
  /** Continue in this window to an admin path (relative to the mount). */
  readonly onContinue: (path: string) => void
  readonly onClose?: () => void
}

function useReasonText(reason: OauthLandingReason): string {
  const { t } = useTranslation()
  switch (reason) {
    case 'access_denied':
      return t('oauthLanding.reason.access_denied', 'Access was denied, so nothing was connected.')
    case 'invalid_state':
      return t(
        'oauthLanding.reason.invalid_state',
        'This sign-in link expired or was already used. Start the sign-in again.',
      )
    case 'invalid_request':
      return t(
        'oauthLanding.reason.invalid_request',
        'The request was not valid for this hub. Start the link again from the beginning.',
      )
    case 'unknown_broker':
      return t(
        'oauthLanding.reason.unknown_broker',
        'That connection no longer exists. Add it again, then sign in.',
      )
    case 'not_configured':
      return t(
        'oauthLanding.reason.not_configured',
        'The connection is missing its client ID or secret. Fill them in, save, then sign in.',
      )
    case 'exchange_failed':
      return t(
        'oauthLanding.reason.exchange_failed',
        'The provider did not accept the sign-in. Check the client ID and secret, then try again.',
      )
    case 'no_authorization_code':
      return t(
        'oauthLanding.reason.no_authorization_code',
        'The provider finished the sign-in without granting CamStack access. Start the sign-in again from the beginning.',
      )
    case 'no_refresh_token':
      return t(
        'oauthLanding.reason.no_refresh_token',
        'The provider returned no long-lived access. Remove CamStack from the account’s connected apps, then sign in again.',
      )
    case 'unavailable':
      return t(
        'oauthLanding.reason.unavailable',
        'The hub is still starting this integration. Wait a moment and try again.',
      )
    case 'unknown':
      return t('oauthLanding.reason.unknown', 'Something went wrong. Try again in a moment.')
  }
}

function Outcome({ outcome }: { readonly outcome: OauthLandingOutcome }): JSX.Element {
  const { t } = useTranslation()
  const reason = useReasonText(outcome.reason ?? 'unknown')
  if (outcome.status === 'error') {
    return (
      <>
        <XCircle className="mx-auto h-8 w-8 text-danger" aria-hidden />
        <h1 data-testid="oauth-landing-title" className="text-sm font-semibold text-foreground">
          {t('oauthLanding.errorTitle', 'Sign-in did not finish')}
        </h1>
        <p
          data-testid="oauth-landing-reason"
          className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {reason}
        </p>
      </>
    )
  }
  const disconnected = outcome.action === 'disconnect'
  return (
    <>
      <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
      <h1 data-testid="oauth-landing-title" className="text-sm font-semibold text-foreground">
        {disconnected
          ? t('oauthLanding.signedOutTitle', 'Signed out')
          : t('oauthLanding.successTitle', 'Signed in')}
      </h1>
      <p className="text-xs text-foreground-muted">
        {disconnected
          ? t('oauthLanding.signedOutBody', 'The account was disconnected from this hub.')
          : t('oauthLanding.successBody', 'The account is connected. Returning to CamStack…')}
      </p>
    </>
  )
}

export function OauthLandingPage({
  outcome,
  closable,
  onContinue,
  onClose,
}: OauthLandingPageProps): JSX.Element {
  const { t } = useTranslation()
  const returnPath = oauthReturnPath(outcome)

  useEffect(() => {
    if (outcome.status !== 'success') return
    const timer = window.setTimeout(() => onContinue(returnPath), OAUTH_RETURN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [outcome.status, onContinue, returnPath])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex justify-center">
          <picture>
            <source
              media="(prefers-color-scheme: dark)"
              srcSet={hubPath('/brand/logo-horizontal-dark.svg')}
            />
            <img
              src={hubPath('/brand/logo-horizontal-light.svg')}
              alt={t('oauthLanding.brand', 'CamStack')}
              className="h-12"
            />
          </picture>
        </div>
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6 text-center shadow-xl shadow-black/10">
          <Outcome outcome={outcome} />
          <div className="flex flex-col gap-2">
            <Button type="button" variant="primary" onClick={() => onContinue(returnPath)}>
              {t('oauthLanding.back', 'Back to CamStack')}
            </Button>
            {closable && (
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('oauthLanding.close', 'Close this window')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * Run the landing once, outside React (StrictMode would deliver twice): drop
 * the fragment from the address bar, hand the outcome to a same-origin opener,
 * and close a popup that was taken; otherwise show the page.
 */
export function mountOauthLanding(root: Root, outcome: OauthLandingOutcome): void {
  window.history.replaceState(null, '', window.location.pathname)
  const opener = window.opener as Window | null
  const handed = deliverOauthOutcome(outcome, {
    opener,
    origin: window.location.origin, // hub-path-ok: postMessage target origin, not a hub URL
  })
  const render = (): void =>
    root.render(
      <OauthLandingPage
        outcome={outcome}
        closable={handed}
        onContinue={(path) => window.location.replace(hubPath(path))}
        onClose={() => window.close()}
      />,
    )
  if (handed && outcome.status === 'success') {
    window.close()
    // Still here: the browser refused to close it. Say what happened instead.
    window.setTimeout(render, CLOSE_GRACE_MS)
    return
  }
  render()
}

/** The outcome in `hash`, when this is an OAuth landing. */
export function oauthOutcomeOf(hash: string): OauthLandingOutcome | null {
  return parseOauthLandingFragment(hash)
}
