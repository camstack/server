/**
 * Where the hub's auth routes send a browser, as `Location` values (D801).
 *
 * Pure, so the two rules that live in `main.ts` routes are specced here:
 *  - an SSO return is an admin-ui path relative to the hub's mount — EXCEPT a
 *    native app return (`camstack://auth-callback?…`), which is not a hub path
 *    and must never be prefixed;
 *  - a browser handoff lands on the account page by default, or on the admin
 *    UI's root when the caller asked for `admin` — and on nothing else.
 */
import { hasUrlScheme } from '@camstack/types'
import type { MintedSession } from './session-mint.js'
import { SSO_LOGIN_PATH, SSO_PROFILE_PATH, sessionFragmentParams } from './sso-finish.js'

/** Where a browser handoff lands once signed in (D1094). */
export type BrowserHandoffDestination = 'account' | 'admin'

export function parseBrowserHandoffDestination(raw: unknown): BrowserHandoffDestination {
  return raw === 'admin' ? 'admin' : 'account'
}

export function ssoReturnLocation(mount: string, location: string): string {
  return hasUrlScheme(location) ? location : `${mount}${location}`
}

/**
 * The account page, signed in by a session in the FRAGMENT that admin-ui's
 * auth boot consumes (`#token=…&next=…`, as an SSO login return). Without a
 * session — unknown, used or expired code — the plain login page.
 */
export function browserHandoffLocation(
  mount: string,
  session: MintedSession | null,
  destination: BrowserHandoffDestination = 'account',
): string {
  if (session === null) return `${mount}${SSO_LOGIN_PATH}`
  // `admin` names no `next`: the admin UI's auth boot lands on its root.
  const fragment = new URLSearchParams({
    ...sessionFragmentParams(session),
    ...(destination === 'account' ? { next: SSO_PROFILE_PATH } : {}),
    provider: 'browser-handoff',
  })
  return `${mount}${SSO_LOGIN_PATH}#${fragment.toString()}`
}
