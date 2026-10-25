/**
 * The native-app browser sign-in flows the hub serves itself (D858).
 *
 * The viewer app opens the system browser at a hub START route (OIDC
 * `/addon/auth-oidc/<id>/start`, the passkey page `/auth/app/passkey`) and gets
 * a one-shot handoff code back at its custom scheme. These helpers are the one
 * reading of the request every leg shares - the OIDC addon, the finish leg and
 * the passkey page - so a rule tightened for one is tightened for all:
 *
 *  - PKCE is mandatory and S256 only (`code_challenge` = base64url of a SHA-256);
 *  - `state` is echoed back exactly;
 *  - the return URL is one of {@link APP_AUTH_CALLBACK_URLS}, never a free URL;
 *  - the purpose is `new-session` or `step-up` (the legacy `renew` has no browser flow).
 *
 * Pure and dependency-free (zod only) so an addon, the backend and a spec read
 * the same code.
 */
import { z } from 'zod'
import { parseAppAuthCallback } from './app-callback.js'

/** What the app redeems the code for. `step-up` yields a proof, never a session. */
export const AppFlowPurposeSchema = z.enum(['new-session', 'step-up'])
export type AppFlowPurpose = z.infer<typeof AppFlowPurposeSchema>

/** The languages the hub's app landing pages are written in (D858). */
export const AppPageLangSchema = z.enum(['en', 'it'])
export type AppPageLang = z.infer<typeof AppPageLangSchema>

/** Narrows an untrusted `lang` value to the allow-list; anything else is `undefined`, never echoed. */
export function parseAppPageLang(value: unknown): AppPageLang | undefined {
  const parsed = AppPageLangSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Where the app is sent when the request names no `redirect`. */
export const APP_FLOW_DEFAULT_REDIRECT = 'camstack://auth-callback'

/**
 * A browser OIDC flow started for an app carries this prefix on the IdP
 * `state` it generates, so a callback whose pending state is gone (expired,
 * replayed) can still be answered at the app and not on a hub error page. The
 * destination of that answer is the fixed default callback - the prefix
 * selects nothing the requester controls.
 */
export const APP_FLOW_STATE_PREFIX = 'a.'

/** S256 challenge: base64url of 32 bytes = 43 characters, no padding. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** The app's own `state`: URL-safe characters only, bounded. */
const STATE_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/

/** A validated app flow request. */
export interface AppFlowRequest {
  readonly codeChallenge: string
  readonly state: string
  readonly purpose: AppFlowPurpose
  /** The canonical allow-listed callback URL. */
  readonly redirect: string
  /** The page language the app asked for (`lang`), when it asked; absent means "ask the browser". */
  readonly lang?: AppPageLang
}

export type AppFlowRefusal =
  | 'bad-challenge'
  | 'bad-challenge-method'
  | 'bad-state'
  | 'bad-purpose'
  | 'bad-redirect'

export type AppFlowParse =
  | { readonly ok: true; readonly request: AppFlowRequest }
  | { readonly ok: false; readonly reason: AppFlowRefusal }

/** Operator-facing words for a refusal (the "clear page", D858). */
export const APP_FLOW_REFUSAL_MESSAGES: Record<AppFlowRefusal, string> = {
  'bad-challenge': 'The sign-in request has no valid PKCE challenge (S256).',
  'bad-challenge-method': 'Only the S256 PKCE method is supported.',
  'bad-state': 'The sign-in request has no valid state.',
  'bad-purpose': 'The sign-in request names an unknown purpose.',
  'bad-redirect': 'The sign-in request names a return address this hub does not accept.',
}

/** Why an app sign-in START was refused: a malformed request, or a flow the app cannot combine. */
export type AppStartRefusal = AppFlowRefusal | 'combined-flow'

/** Words for every start refusal; the hub's refusal page renders these (D858). */
export const APP_START_REFUSAL_MESSAGES: Record<AppStartRefusal, string> = {
  ...APP_FLOW_REFUSAL_MESSAGES,
  'combined-flow': 'An app sign-in cannot be combined with linking or a popup.',
}

/**
 * The hub page that says why an app sign-in start was refused. A leg that
 * cannot render the hub's styled page itself (an addon: it has no access to the
 * hub's theme) redirects here with `?reason=<AppStartRefusal>`. Only a CODE
 * travels - the words come from {@link APP_START_REFUSAL_MESSAGES}, so the app's
 * parameters are never echoed.
 */
export const APP_REFUSED_PATH = '/auth/app/refused'

/** Narrows a query value to a known start refusal. */
export function isAppStartRefusal(value: unknown): value is AppStartRefusal {
  return typeof value === 'string' && Object.hasOwn(APP_START_REFUSAL_MESSAGES, value)
}

/**
 * Read the app parameters off a start query: `code_challenge`,
 * `code_challenge_method`, `state`, `purpose`, `redirect`, and the optional `lang` (an unknown value is
 * dropped, not refused). Anything missing or
 * malformed is refused - there is no lenient default for PKCE or state.
 */
export function parseAppFlowRequest(
  query: Readonly<Record<string, string | undefined>>,
): AppFlowParse {
  const challenge = query['code_challenge']
  if (challenge === undefined || !CHALLENGE_PATTERN.test(challenge)) {
    return { ok: false, reason: 'bad-challenge' }
  }
  if (query['code_challenge_method'] !== 'S256') {
    return { ok: false, reason: 'bad-challenge-method' }
  }
  const state = query['state']
  if (state === undefined || !STATE_PATTERN.test(state)) return { ok: false, reason: 'bad-state' }
  const purpose = AppFlowPurposeSchema.safeParse(query['purpose'])
  if (!purpose.success) return { ok: false, reason: 'bad-purpose' }
  const redirectParam = query['redirect']
  const redirect =
    redirectParam === undefined ? APP_FLOW_DEFAULT_REDIRECT : parseAppAuthCallback(redirectParam)
  if (redirect === null) return { ok: false, reason: 'bad-redirect' }
  const lang = parseAppPageLang(query['lang'])
  return {
    ok: true,
    request: {
      codeChallenge: challenge,
      state,
      purpose: purpose.data,
      redirect,
      ...(lang !== undefined ? { lang } : {}),
    },
  }
}

/** The app's callback with `code` (success) or `error` (refusal), and the echoed `state` when known. */
export function appFlowLocation(
  redirect: string,
  result: { readonly code: string } | { readonly error: string },
  state?: string,
): string {
  const params = new URLSearchParams()
  if ('code' in result) params.set('code', result.code)
  else params.set('error', result.error)
  if (state !== undefined) params.set('state', state)
  return `${redirect}?${params.toString()}`
}

/** How a native app starts one login method (D858), as `auth.listLoginMethods` reports it. */
export const AppLoginPathSchema = z.discriminatedUnion('kind', [
  /** The app runs it itself, in its own UI (a password; a stored device key). */
  z.object({ kind: z.literal('native') }),
  /** The app opens the system browser at `startPath` on the hub origin, with the app flow query. */
  z.object({ kind: z.literal('browser'), startPath: z.string().startsWith('/') }),
])
export type AppLoginPath = z.infer<typeof AppLoginPathSchema>
