/**
 * `/sso-complete` — where the hub's SSO finish lands a POPUP sign-in or link
 * (D791). Rendered by `main.tsx` instead of the app: no auth boot, no socket,
 * nothing that could read the fragment before this does.
 *
 * It drops the fragment from the address bar first, then hands the outcome to
 * the window that opened it (`deliverPopupCompletion`: a same-origin opener by
 * `postMessage`, else a token-free "done" on the same-origin channel, else —
 * opener at another origin — close on a successful link) and closes; with
 * nobody to take it, it continues to the full-page return in this window.
 */
import type { Root } from 'react-dom/client'
import {
  deliverPopupCompletion,
  openSsoChannel,
  parsePopupCompletion,
  type PopupResult,
  type SsoPopupCompletion,
} from '../lib/sso-popup'
import { sessionFromFragment, storeSession } from '../lib/admin-session'
import { hubPath } from '../lib/mount'
import { mountOauthLanding, oauthOutcomeOf } from './OauthLanding'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

const DONE_MESSAGE = 'Done — you can close this window.'
/** How long a `window.close()` gets before the page says it is done instead. */
const CLOSE_GRACE_MS = 500

/** The key the admin UI keeps its session JWT under (`auth-context.tsx`). */
const SESSION_TOKEN_KEY = 'camstack_admin_token'

/**
 * Keep a login session at this origin, as the login page's finalize does:
 * the JWT in storage + the httpOnly cookie mirror. The opener picks it up
 * from storage on the channel's "done" — the token itself never travels.
 */
async function persistSession(token: string, fragment = ''): Promise<void> {
  try {
    // The refresh token and expiry ride the same fragment (the admin UI is a
    // refreshing client) — kept beside the access token, as `admin-session.ts` does.
    const session = sessionFromFragment(new URLSearchParams(fragment))
    if (session !== null && session.token === token) storeSession(session)
    else localStorage.setItem(SESSION_TOKEN_KEY, token)
  } catch {
    // Storage blocked: the full-page return still works if nobody acks.
  }
  await fetch(hubPath('/api/auth/session'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => {
    /* non-fatal, as in auth-context */
  })
}

/** The session a popup kept at this origin (`persistSession`), for the opener. */
export function readPersistedSession(): string | null {
  try {
    const token = localStorage.getItem(SESSION_TOKEN_KEY)
    return token !== null && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Run the completion once, outside React (StrictMode would deliver twice), and render it. */
export function mountSsoComplete(root: Root): void {
  // An OAuth completion (a broker sign-in, an account link) shares this route.
  const oauth = oauthOutcomeOf(window.location.hash)
  if (oauth !== null) {
    mountOauthLanding(root, oauth)
    return
  }
  const completion = parsePopupCompletion(window.location.hash)
  window.history.replaceState(null, '', window.location.pathname)
  const render = (result: PopupResult | null): void =>
    root.render(<SsoCompletePage completion={completion} result={result} />)
  render(null)
  if (completion === null) return
  const channel = openSsoChannel()
  void deliverPopupCompletion(completion, {
    opener: window.opener as Window | null,
    origin: window.location.origin, // hub-path-ok: postMessage target origin, not a hub URL
    channel,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    close: () => {
      window.close()
      // Still here: the browser refused (a window it does not consider
      // script-opened). Say it is done instead of spinning forever.
      window.setTimeout(() => render({ kind: 'done', message: DONE_MESSAGE }), CLOSE_GRACE_MS)
    },
    continueAt: (path) => window.location.replace(hubPath(path)),
    persistSession: (token) =>
      persistSession(token, completion.target === 'login' ? completion.fragment : ''),
    showResult: render,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  })
}

export function SsoCompletePage({
  completion,
  result,
}: {
  completion: SsoPopupCompletion | null
  result: PopupResult | null
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex flex-col items-center gap-3 text-sm text-foreground-subtle">
        {completion === null ? (
          <a className="text-primary underline" href={hubPath('/login')}>
            {t('ssoComplete.nothingToFinishHereGo', 'Nothing to finish here — go to sign-in')}
          </a>
        ) : result !== null ? (
          <>
            <span
              data-testid="sso-complete-result"
              className={result.kind === 'link-error' ? 'text-danger' : 'text-foreground'}
            >
              {result.message}
            </span>
            <Button
              variant="unstyled"
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-surface-hover"
              onClick={() => window.close()}
            >
              {t('ssoComplete.closeThisWindow', 'Close this window')}
            </Button>
          </>
        ) : (
          <span className="flex items-center gap-3">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            {t('ssoComplete.finishingSignIn', 'Finishing sign-in…')}
          </span>
        )}
      </div>
    </div>
  )
}
