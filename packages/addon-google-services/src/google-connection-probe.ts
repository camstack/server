/**
 * The real probe behind "Test" on a SIGNED-IN Google account (D1016, planning#543): a Calendar
 * list call (proves the token and the Calendar scope both work) plus a check of the Gmail send
 * scope Google actually granted — read from the token's own `scope` field, never a message sent.
 * An account connected before `GOOGLE_OAUTH_SCOPES` requested `gmail.send` kept an old grant that
 * lacks it; Calendar alone looked "validated" while Gmail sending 403'd, which is exactly what
 * this probe now surfaces.
 */
import { GOOGLE_CALENDAR_LIST_URL, GOOGLE_GMAIL_SEND_SCOPE } from './google-types.js'
import type { GoogleClientProbeResult } from './google-oauth.js'

export interface GoogleAccountProbeDeps {
  /** Refreshes (when needed) and returns a usable access token; throws when it cannot. */
  readonly ensureAccessToken: (opts?: { readonly forceRefresh?: boolean }) => Promise<string>
  /** The scopes Google granted on the token this probe just (re)fetched; '' when unknown. */
  readonly grantedScopes: () => string
  readonly fetch?: typeof fetch
}

function hasScope(scopes: string, scope: string): boolean {
  return scopes.split(/\s+/).includes(scope)
}

export async function probeGoogleAccount(
  deps: GoogleAccountProbeDeps,
): Promise<GoogleClientProbeResult> {
  const http = deps.fetch ?? fetch
  const started = Date.now()
  // Always refresh on Test — a stale/empty access token still leaves isConnected true (refresh
  // present) and the Calendar call then 401s with "missing required authentication credential".
  const token = await deps.ensureAccessToken({ forceRefresh: true })
  if (token.trim().length === 0) {
    return { ok: false, error: 'No access token after refresh — Sign out and Sign in again' }
  }
  let res = await http(GOOGLE_CALENDAR_LIST_URL, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401) {
    const retryToken = await deps.ensureAccessToken({ forceRefresh: true })
    res = await http(GOOGLE_CALENDAR_LIST_URL, {
      headers: { Authorization: `Bearer ${retryToken}` },
    })
  }
  if (!res.ok) {
    const text = await res.text()
    return {
      ok: false,
      error: `Google Calendar probe failed (${res.status}): ${text.slice(0, 200)}`,
    }
  }
  const gmailGranted = hasScope(deps.grantedScopes(), GOOGLE_GMAIL_SEND_SCOPE)
  const detail = gmailGranted
    ? 'Calendar reachable · Gmail send scope granted'
    : 'Calendar reachable · Gmail send scope NOT granted — Sign out and Sign in again to enable email sending'
  return { ok: true, latencyMs: Math.max(0, Date.now() - started), detail }
}
