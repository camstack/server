/**
 * Login `redirect` query-param handling — the viewer session-forwarding
 * entry point.
 *
 * The hub-served viewer (`/viewer/camstack/`) bounces an unauthenticated
 * browser to `/login?redirect=<path>`; the native viewer app opens
 * `/login?redirect=camstack://auth-callback` in an auth session. After
 * ANY successful login leg (password, TOTP, passkey, OIDC
 * return) the shell navigates to the validated target — a RELATIVE path
 * only, or the allowlisted app callback scheme (which receives a
 * one-time handoff code instead of a session).
 *
 * Open-redirect defenses:
 *   • relative targets must start with a single `/` (no `//host`, no
 *     scheme, no backslash, no `..` traversal);
 *   • absolute targets are accepted ONLY from the exact custom-scheme
 *     allowlist (`APP_AUTH_CALLBACK_URLS` in `@camstack/types`, shared with
 *     the hub's native link flow) — never an arbitrary URL.
 *
 * The validated target is parked in sessionStorage between the login
 * page mount and the (possibly asynchronous, e.g. OIDC round-trip)
 * login completion, with a short expiry so a stale value can't hijack
 * an unrelated later login in the same tab.
 */
import { parseAppAuthCallback } from '@camstack/types'

export type LoginRedirectTarget =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'app-callback'; readonly url: string }

const MAX_REDIRECT_LENGTH = 512

/** Validate a raw `redirect` query param into a safe target, or null. */
export function parseLoginRedirect(raw: string | null | undefined): LoginRedirectTarget | null {
  if (!raw || raw.length > MAX_REDIRECT_LENGTH) return null
  // The allowlist is shared with the hub's native link flow (D801).
  const appCallback = parseAppAuthCallback(raw)
  if (appCallback !== null) {
    return { kind: 'app-callback', url: appCallback }
  }
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  if (raw.includes('\\') || raw.includes('://') || raw.includes('..')) return null
  // Never bounce back into the auth flow itself.
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return null
  return { kind: 'path', path: raw }
}

// ── App handoff binding (PKCE + state + purpose, D855) ───────────────

/**
 * What the native app put on the login URL so the code it gets back is bound
 * to it: `code_challenge` (+ `code_challenge_method=S256`), `state`, and the
 * `purpose` (`new-session`, the default, or `step-up`). The hub REFUSES to
 * mint an app-callback code without a challenge and a state, so a login URL
 * that carries none cannot complete the handoff.
 */
export interface AppHandoffParams {
  readonly codeChallenge: string
  readonly state: string
  readonly purpose: 'new-session' | 'step-up'
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/
const STATE_RE = /^[A-Za-z0-9._~-]{1,256}$/

/** Validate the handoff query params; `null` when a binding is absent or malformed. */
export function parseAppHandoffParams(input: {
  readonly codeChallenge?: string | null
  readonly codeChallengeMethod?: string | null
  readonly state?: string | null
  readonly purpose?: string | null
}): AppHandoffParams | null {
  const { codeChallenge, state } = input
  if (!codeChallenge || !CHALLENGE_RE.test(codeChallenge)) return null
  if ((input.codeChallengeMethod ?? 'S256') !== 'S256') return null
  if (!state || !STATE_RE.test(state)) return null
  const purpose = input.purpose === 'step-up' ? 'step-up' : 'new-session'
  return { codeChallenge, state, purpose }
}

const HANDOFF_STORAGE_KEY = 'camstack:login-app-handoff'

function parseParkedHandoff(raw: string | null | undefined): AppHandoffParams | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const field = (name: string): string | null => {
      const v: unknown = Reflect.get(value, name)
      return typeof v === 'string' ? v : null
    }
    return parseAppHandoffParams({
      codeChallenge: field('codeChallenge'),
      state: field('state'),
      purpose: field('purpose'),
    })
  } catch {
    return null
  }
}

/** Park the handoff params (an OIDC round-trip drops the query string). No-op when invalid. */
export function rememberAppHandoffParams(
  params: AppHandoffParams | null,
  now: number = Date.now(),
): void {
  if (params === null) return
  park(HANDOFF_STORAGE_KEY, JSON.stringify(params), parseParkedHandoff, now)
}

/** Read + clear the parked handoff params. */
export function consumeAppHandoffParams(now: number = Date.now()): AppHandoffParams | null {
  return unpark(HANDOFF_STORAGE_KEY, parseParkedHandoff, now)
}

/** Append the one-time handoff code to an allowlisted app callback. */
export function buildAppCallbackUrl(callbackUrl: string, code: string, state?: string): string {
  const query = `code=${encodeURIComponent(code)}`
  return `${callbackUrl}?${query}${state !== undefined ? `&state=${encodeURIComponent(state)}` : ''}`
}

/**
 * Post-login redirect resolution: the parked (one-shot) value wins; when it
 * is absent — ALREADY CONSUMED by an earlier attempt that could not finish
 * (the interactive-login teardown/remount cycle rebuilds the whole tree and
 * kills an in-flight handoff mint), or never parked (storage blocked) — fall
 * back to re-validating the live `?redirect` query param, which the login
 * page still carries because no navigation has happened yet. Both sources go
 * through the same `parseLoginRedirect` validation, so the open-redirect
 * defenses are identical.
 */
export function resolveLoginRedirect(
  rawParam: string | null | undefined,
  now: number = Date.now(),
): LoginRedirectTarget | null {
  return consumeLoginRedirect(now) ?? parseLoginRedirect(rawParam)
}

// ── `next` — the SERVER-side login bounce ────────────────────────────

/**
 * A hub route that demands the session cookie (`/api/oauth2/authorize`, the
 * `authenticated` addon-route catch-all) answers an unauthenticated BROWSER
 * navigation with `302 /login?next=<the whole original url, percent-encoded>`
 * — see `loginRedirectUrl` in `server/backend/src/auth/session-cookie.ts`.
 *
 * It is a DIFFERENT param from `redirect` and must stay one: `redirect` may
 * be an allowlisted custom scheme (the native app handoff), `next` may only
 * ever be a same-origin path back into this hub. But it needs the same three
 * things `redirect` has, and had none of them:
 *
 *   • **validation** — `next` used to be handed to `location.assign` raw, so
 *     `/login?next=https://evil.example/` bounced an operator off-origin the
 *     moment they signed in;
 *   • **parking** — a login leg that LEAVES the page (OIDC
 *     returns through `/login#token=…`) drops the query string, and
 *     with it the entire request being resumed;
 *   • **honouring it when the session is already live** — the cookie expires
 *     independently of the SPA's own token, so an operator with a working
 *     admin session lands here already authenticated. The page used to show
 *     them a credentials form and silently discard `next`; the bounced
 *     request was then never re-issued, and `/api/oauth2/authorize` saw a
 *     hand-retyped bare url — `integration parameter missing`, `received:
 *     null`, indistinguishable from a client that never sent it.
 *
 * The query string IS the request here (`response_type`, `integration`,
 * `redirect_uri`, `state`, `code_challenge`), so the value is replayed byte
 * for byte — never just its pathname.
 */
const MAX_NEXT_LENGTH = 2048

/** Validate a raw `next` query param into a same-origin relative path, or null. */
export function parseLoginNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_NEXT_LENGTH) return null
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  if (raw.includes('\\') || raw.includes('://') || raw.includes('..')) return null
  // Never bounce back into the auth flow itself — that is a redirect loop.
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return null
  return raw
}

/** Park a raw `next` param. No-op when invalid. */
export function rememberLoginNext(raw: string | null | undefined, now: number = Date.now()): void {
  park(NEXT_STORAGE_KEY, raw, parseLoginNext, now)
}

/** Read + clear the parked `next`, re-validated on the way out. */
export function consumeLoginNext(now: number = Date.now()): string | null {
  return unpark(NEXT_STORAGE_KEY, parseLoginNext, now)
}

/** Post-login `next` resolution — parked value first, live query param as the
 *  fallback, exactly as {@link resolveLoginRedirect} does for `redirect`. */
export function resolveLoginNext(
  rawParam: string | null | undefined,
  now: number = Date.now(),
): string | null {
  return consumeLoginNext(now) ?? parseLoginNext(rawParam)
}

// ── sessionStorage parking (login page mount → login completion) ─────

const STORAGE_KEY = 'camstack:login-redirect'
const NEXT_STORAGE_KEY = 'camstack:login-next'
/** A parked redirect older than this is ignored — long enough for an
 *  OIDC round-trip, short enough not to haunt a later login. */
const MAX_AGE_MS = 10 * 60_000

interface StoredRedirect {
  readonly raw: string
  readonly at: number
}

/** Park a raw param under `key`, gated on the caller's validator. */
function park<T>(
  key: string,
  raw: string | null | undefined,
  validate: (raw: string | null | undefined) => T | null,
  now: number,
): void {
  const store = storage()
  if (!store) return
  if (!validate(raw)) return
  const record: StoredRedirect = { raw: raw ?? '', at: now }
  try {
    store.setItem(key, JSON.stringify(record))
  } catch {
    // Storage full/blocked — the redirect is best-effort.
  }
}

/** Read + clear the value parked under `key`, re-validated on the way out. */
function unpark<T>(
  key: string,
  validate: (raw: string | null | undefined) => T | null,
  now: number,
): T | null {
  const store = storage()
  if (!store) return null
  let raw: string | null = null
  try {
    raw = store.getItem(key)
    store.removeItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const at: unknown = Reflect.get(parsed, 'at')
    const value: unknown = Reflect.get(parsed, 'raw')
    if (typeof at !== 'number' || typeof value !== 'string') return null
    if (now - at > MAX_AGE_MS) return null
    return validate(value)
  } catch {
    return null
  }
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Park a raw redirect param (validated on read, again). No-op when invalid. */
export function rememberLoginRedirect(
  raw: string | null | undefined,
  now: number = Date.now(),
): void {
  park(STORAGE_KEY, raw, parseLoginRedirect, now)
}

/** Read + clear the parked redirect. Returns null when absent, stale, or
 *  no longer valid (the value is re-validated on the way out). */
export function consumeLoginRedirect(now: number = Date.now()): LoginRedirectTarget | null {
  return unpark(STORAGE_KEY, parseLoginRedirect, now)
}
