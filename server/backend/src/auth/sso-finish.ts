/**
 * `/api/auth/sso/finish` — swaps a verified login bridge for a session (D712),
 * or completes an explicit OIDC link (D782).
 *
 * An auth-provider addon (OIDC) mints an HMAC-signed bridge
 * through the `sso-bridge` cap and 302s here with `?bridge=<jwt>`. The bridge
 * proves WHO signed in at the IdP; it never decides what the session may do:
 *
 *  - Only a LOGIN bridge is accepted. The `sso-bridge` family also carries the
 *    OAuth account-link tokens (`oauth-code` travels in a browser redirect,
 *    `oauth-access` / `oauth-refresh` are a component's credentials) — all
 *    verify under the same secret, and each used to be exchangeable here for a
 *    full browser session of the linking user.
 *  - A bridge whose provider addon is disabled on Identity → Authentication
 *    is refused (D777): that toggle is the provider's only enable.
 *  - An OIDC bridge names an identity `oidc:<instance>:<sub>` (D782). It signs
 *    in ONLY the user that identity was explicitly linked to, from that user's
 *    record — no federated session, no auto-creation, no email matching. An
 *    unlinked identity is sent back to the login page with a message.
 *  - Every login owes the user's enrolled second factors (TOTP; an opted-in
 *    passkey): the finish then hands the login page a challenge, not a
 *    session — the same rule as a password login.
 *  - A bridge is single-use (its `jti` is recorded) and bound to the browser
 *    that started the sign-in (the `SSO_STATE_COOKIE` hash it carries must
 *    match the cookie this request presents). A bridge copied out of a URL is
 *    useless in another browser and useless a second time.
 *  - A bridge carrying a `linkIntent` is a LINK, never a login: the hub-side
 *    intent (minted for a signed-in user, single-use) names the user, and the
 *    browser completing the flow must still hold THAT user's session cookie.
 *  - A link started from the native app (`returnTo` on the intent, D801) ends
 *    in the system browser, which holds no hub session: the verified identity
 *    is PARKED under a one-time code and the browser goes back to the app's
 *    custom scheme. The app claims it with its own bearer
 *    (`auth.completeExternalLink`), where the user binding is checked.
 *
 * Pure: the Fastify route in `main.ts` wires the deps and maps the outcome.
 */
import { timingSafeEqual } from 'node:crypto'
import { hasUrlScheme, type SsoBridgeClaimsSchema } from '@camstack/types'
import type { z } from 'zod'
import { bridgeProviderAddonId } from './auth-provider-gate.js'
import type { ExternalLinkIntent } from './external-link-intents.js'
import type { ParkedNativeLink } from './native-link-completions.js'
import type { SecondFactor } from './second-factors.js'
import {
  type MintedSession,
  type SessionIssue,
  type SessionMinter,
  SessionUserGoneError,
  type SessionUserRecord,
} from './session-mint.js'

type SsoBridgeClaims = z.infer<typeof SsoBridgeClaimsSchema>

/**
 * `auth-oidc` signs `auth-oidc/<instance>`.
 *
 * Here the prefix is the READING of a bridge, not the choice of what is
 * linkable (that is the `linkable` flag on a login method, which gates the
 * intent a link needs). It stays because it is load-bearing: it is the
 * allowlist that keeps the `oauth-*` tokens of the same signer from being
 * swapped for a session. A bridge with any other provider is refused, so a
 * non-OIDC provider fails closed until it has its own bridge format. (The
 * magic-link bridge that named a user record directly is gone with its addon.)
 */
export const OIDC_BRIDGE_PROVIDER_PREFIX = 'auth-oidc/'
/** `auth-oidc` names an identity `oidc:<instance>:<sub>`. */
export const OIDC_IDENTITY_PREFIX = 'oidc:'

/**
 * Where a completed (or refused) link lands — the signed-in user's profile —
 * and where a login returns. Admin-ui routes, relative to its mount: the
 * route in `main.ts` prepends the hub's mount prefix. (These read `/admin/…`
 * once, a path admin-ui has no route for, so both returns drew a blank page.)
 */
export const SSO_PROFILE_PATH = '/system/my-access'
export const SSO_LOGIN_PATH = '/login'
const PROFILE_PATH = SSO_PROFILE_PATH
const LOGIN_PATH = SSO_LOGIN_PATH

/**
 * The admin-ui page a POPUP sign-in lands on (D791): it hands the outcome to
 * the window that opened it and closes, or — opener gone — continues to the
 * page the outcome names, like a full-page return.
 */
export const SSO_POPUP_COMPLETE_PATH = '/sso-complete'

export interface SsoFinishOptions {
  /** The flow was started in a popup window (`/start?popup=1` → `?popup=1` here). */
  readonly popup?: boolean
}

/**
 * The popup form of a return `location`: the completion page, with what the
 * page return carried — the login FRAGMENT (session / challenge / error) or
 * the profile QUERY (link outcome) — moved into the completion page's
 * fragment, after `return=login|profile`. Fragment only: a session still
 * never reaches a server log, and the completion page never posts it to
 * another origin.
 */
export function popupCompletionLocation(location: string): string {
  const hashAt = location.indexOf('#')
  const pathAndQuery = hashAt === -1 ? location : location.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : location.slice(hashAt + 1)
  const queryAt = pathAndQuery.indexOf('?')
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt)
  const query = queryAt === -1 ? '' : pathAndQuery.slice(queryAt + 1)
  const target = path === SSO_PROFILE_PATH ? 'profile' : 'login'
  const carried = [query, fragment].filter((part) => part.length > 0).join('&')
  return `${SSO_POPUP_COMPLETE_PATH}#return=${target}${carried.length > 0 ? `&${carried}` : ''}`
}

export type SsoFinishOutcome =
  | { readonly kind: 'redirect'; readonly location: string }
  | {
      readonly kind: 'error'
      readonly status: 400 | 401 | 500
      readonly body: { readonly error: string; readonly message?: string }
    }

/**
 * Why a link was refused — the profile page words each one. `state`: the
 * bridge was not finished in the browser that started it, or was already used.
 */
export type LinkRefusal = 'expired' | 'provider' | 'session' | 'conflict' | 'state'

export interface SsoFinishDeps {
  verifyBridge(token: string): SsoBridgeClaims | null
  readonly minter: SessionMinter
  /**
   * Whether the operator disabled this auth addon on Identity →
   * Authentication — its ONE enable (D777, `auth-provider-gate.ts`). A
   * disabled provider completes no login, including a bridge minted before
   * the switch.
   */
  isProviderDisabled(addonId: string): boolean
  /** The `user-management` external-identity store (D782). */
  readonly identities: {
    findUser(
      provider: string,
      subject: string,
    ): Promise<{ readonly userId: string; readonly issuer: string } | null>
    link(input: {
      userId: string
      provider: string
      subject: string
      issuer: string
      label?: string
    }): Promise<'linked' | 'conflict'>
  }
  /** Resolve (and burn) a link-intent handle. */
  consumeLinkIntent(handle: string): ExternalLinkIntent | null
  /** Park a native link for the app to claim (D801); returns the one-time code. */
  parkNativeLink(link: ParkedNativeLink): string
  /**
   * SHA-256 (hex) of the `SSO_STATE_COOKIE` THIS request presents, or `null`
   * without one. The bridge must name the same hash: it was set by the IdP
   * `/start` in the browser that began the sign-in.
   */
  browserBinding(): string | null
  /** Record a bridge's `jti`; `false` when it was already used (`used-bridge-ids.ts`). */
  consumeBridgeId(jti: string): boolean
  /** Client label and address of THIS request, recorded on the session it opens. */
  sessionIssue?(): Pick<SessionIssue, 'client' | 'ip'>
  /**
   * Opt-in trusted-network login: `true` when THIS request came directly from
   * a network the operator trusts (never through a proxy). The skip is then
   * audited through `auditSkip`; without an audit there is no skip.
   */
  trustedNetworkLogin?(): boolean
  auditSkip?(userId: string, factors: readonly SecondFactor[]): Promise<void>
  /** The user named by THIS request's session cookie, or `null`. */
  sessionUserId(): string | null
  /** The second factors `userId` still owes after this primary login. */
  secondFactors(userId: string): Promise<readonly SecondFactor[]>
  /** A short-lived second-factor challenge for `user` (`signTotpChallengeToken`). */
  signChallenge(user: {
    userId: string
    username: string
    isAdmin: boolean
    method?: 'password' | 'passkey' | 'sso'
  }): string
  /** Server-side log of an unexpected failure (never sent to the browser). */
  logFailure?(error: unknown): void
}

/**
 * `(provider, subject, issuer)` of an OIDC bridge, or `null` when it is not a
 * well-formed one. A subject is unique only per issuer, so a bridge without
 * the verified `iss` names no identity.
 */
export function oidcIdentityOf(
  claims: SsoBridgeClaims,
): { provider: string; subject: string; issuer: string } | null {
  if (!claims.provider.startsWith(OIDC_BRIDGE_PROVIDER_PREFIX)) return null
  if (claims.issuer === undefined || claims.issuer.length === 0) return null
  const instance = claims.provider.slice(OIDC_BRIDGE_PROVIDER_PREFIX.length)
  if (instance.length === 0) return null
  const prefix = `${OIDC_IDENTITY_PREFIX}${instance}:`
  if (!claims.userId.startsWith(prefix)) return null
  const subject = claims.userId.slice(prefix.length)
  return subject.length === 0 ? null : { provider: claims.provider, subject, issuer: claims.issuer }
}

/** Whether `claims` is a LOGIN bridge — the only kind this endpoint swaps. */
export function isLoginBridge(claims: SsoBridgeClaims): boolean {
  return claims.provider.startsWith(OIDC_BRIDGE_PROVIDER_PREFIX)
}

function unauthorized(error: string): SsoFinishOutcome {
  return { kind: 'error', status: 401, body: { error } }
}

function redirect(location: string): SsoFinishOutcome {
  return { kind: 'redirect', location }
}

function linkRefused(reason: LinkRefusal): SsoFinishOutcome {
  return redirect(`${PROFILE_PATH}?linkError=${reason}`)
}

/** The app's callback with one query parameter — `link=<code>` or `linkError=<reason>`. */
export function appCallbackLocation(
  returnTo: string,
  key: 'link' | 'linkError',
  value: string,
): string {
  return `${returnTo}?${key}=${encodeURIComponent(value)}`
}

function failed(error: unknown, deps: SsoFinishDeps): SsoFinishOutcome {
  if (error instanceof SessionUserGoneError) return unauthorized('User no longer exists')
  // The detail stays in the server log: a store error can name user ids.
  deps.logFailure?.(error)
  return { kind: 'error', status: 500, body: { error: 'SSO finish failed' } }
}

/**
 * The session a URL fragment hands the admin-ui: the access token, and — the
 * admin-ui is a refreshing client — the refresh token and both expiries. A
 * fragment never reaches a server log or a Referer.
 */
export function sessionFragmentParams(session: MintedSession): Record<string, string> {
  return {
    token: session.token,
    ...(session.refreshToken !== undefined ? { refreshToken: session.refreshToken } : {}),
    ...(session.expiresAt !== undefined ? { expiresAt: String(session.expiresAt) } : {}),
    ...(session.sessionExpiresAt !== undefined
      ? { sessionExpiresAt: String(session.sessionExpiresAt) }
      : {}),
  }
}

/** May this login skip its factors (opt-in trusted network)? Only when the skip could be audited. */
async function skippedHere(
  userId: string,
  owed: readonly SecondFactor[],
  deps: SsoFinishDeps,
): Promise<boolean> {
  if (owed.length === 0 || deps.trustedNetworkLogin?.() !== true || deps.auditSkip === undefined) {
    return false
  }
  try {
    await deps.auditSkip(userId, owed)
    return true
  } catch (error: unknown) {
    deps.logFailure?.(error)
    return false
  }
}

/** A session for `record` — or the second-factor challenge it still owes. */
async function signIn(
  record: SessionUserRecord,
  provider: string,
  deps: SsoFinishDeps,
): Promise<SsoFinishOutcome> {
  const owed = await deps.secondFactors(record.id)
  const factors = (await skippedHere(record.id, owed, deps)) ? [] : owed
  if (factors.length > 0) {
    const challenge = deps.signChallenge({
      userId: record.id,
      username: record.username,
      isAdmin: record.isAdmin,
      method: 'sso',
    })
    // The challenge rides the URL FRAGMENT, like the session token below: it
    // never reaches a server log. The login page resumes at the factor step.
    const fragment = new URLSearchParams({
      challenge,
      factors: factors.join(','),
      provider,
    })
    return redirect(`${LOGIN_PATH}#${fragment.toString()}`)
  }
  const session = await deps.minter.mintForRecord(record, {
    method: 'sso',
    refreshable: true,
    ...deps.sessionIssue?.(),
  })
  const fragment = new URLSearchParams({ ...sessionFragmentParams(session), provider })
  return redirect(`${LOGIN_PATH}#${fragment.toString()}`)
}

async function completeLink(
  claims: SsoBridgeClaims,
  handle: string,
  deps: SsoFinishDeps,
): Promise<SsoFinishOutcome> {
  const identity = oidcIdentityOf(claims)
  if (identity === null) {
    return { kind: 'error', status: 400, body: { error: 'Only an OIDC sign-in can be linked' } }
  }
  const intent = deps.consumeLinkIntent(handle)
  if (intent === null) return linkRefused('expired')
  if (intent.returnTo !== undefined) {
    // Native (D801): no session cookie to check here — the app's claim is
    // bound to the intent's user by `auth.completeExternalLink`.
    if (intent.provider !== identity.provider) {
      return redirect(appCallbackLocation(intent.returnTo, 'linkError', 'provider'))
    }
    const code = deps.parkNativeLink({
      userId: intent.userId,
      provider: identity.provider,
      subject: identity.subject,
      issuer: identity.issuer,
      label: claims.email ?? claims.username,
    })
    return redirect(appCallbackLocation(intent.returnTo, 'link', code))
  }
  if (intent.provider !== identity.provider) return linkRefused('provider')
  // Bound to the session that asked: the browser finishing the IdP round trip
  // must be signed in as the user the intent was minted for. Without this a
  // link started in one account could be completed with someone else's IdP
  // login (or vice versa) and plant an identity on the wrong user.
  if (deps.sessionUserId() !== intent.userId) return linkRefused('session')
  const result = await deps.identities.link({
    userId: intent.userId,
    provider: identity.provider,
    subject: identity.subject,
    issuer: identity.issuer,
    label: claims.email ?? claims.username,
  })
  if (result === 'conflict') return linkRefused('conflict')
  return redirect(`${PROFILE_PATH}?linked=${encodeURIComponent(identity.provider)}`)
}

async function completeLogin(
  claims: SsoBridgeClaims,
  deps: SsoFinishDeps,
): Promise<SsoFinishOutcome> {
  const identity = oidcIdentityOf(claims)
  if (identity === null) return unauthorized('Malformed OIDC identity')
  const link = await deps.identities.findUser(identity.provider, identity.subject)
  // A link made under another issuer is not this identity: the instance was
  // repointed at a different IdP, where the same `sub` names someone else.
  if (link === null || link.issuer !== identity.issuer) {
    return redirect(
      `${LOGIN_PATH}#error=sso-not-linked&provider=${encodeURIComponent(identity.provider)}`,
    )
  }
  return signIn(await deps.minter.findUser(link.userId), claims.provider, deps)
}

export async function finishSsoLogin(
  bridge: string | undefined,
  deps: SsoFinishDeps,
  options: SsoFinishOptions = {},
): Promise<SsoFinishOutcome> {
  const outcome = await finishSsoReturn(bridge, deps)
  if (options.popup !== true || outcome.kind !== 'redirect') return outcome
  // A native return goes to the app's scheme, never to a popup page.
  if (hasUrlScheme(outcome.location)) return outcome
  return redirect(popupCompletionLocation(outcome.location))
}

/** Constant-time compare of two hex digests (equal length or not equal). */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Is this the FIRST presentation of the bridge, in the browser that started
 * the sign-in? The binding is checked BEFORE the jti is recorded, so a bridge
 * presented from a browser without the cookie is refused without being burned
 * — the real browser can still finish.
 */
export function bridgeIsFirstUseHere(
  claims: SsoBridgeClaims,
  deps: Pick<SsoFinishDeps, 'browserBinding' | 'consumeBridgeId'>,
): boolean {
  if (claims.jti === undefined || claims.browserBinding === undefined) return false
  const presented = deps.browserBinding()
  if (presented === null || !sameDigest(presented, claims.browserBinding)) return false
  return deps.consumeBridgeId(claims.jti)
}

async function finishSsoReturn(
  bridge: string | undefined,
  deps: SsoFinishDeps,
): Promise<SsoFinishOutcome> {
  if (!bridge) return { kind: 'error', status: 400, body: { error: 'Missing bridge token' } }
  const claims = deps.verifyBridge(bridge)
  if (!claims) return unauthorized('Invalid or expired bridge token')
  if (!isLoginBridge(claims)) return unauthorized('Not a login bridge token')
  // A bridge minted for a native app (D858) is finished only at `finish-app`,
  // which hands the app a code; it must never become a web session here.
  if (claims.app !== undefined) return unauthorized('Not a web login bridge token')
  if (deps.isProviderDisabled(bridgeProviderAddonId(claims.provider))) {
    return unauthorized('Login provider is disabled')
  }
  if (!bridgeIsFirstUseHere(claims, deps)) {
    return claims.linkIntent !== undefined
      ? linkRefused('state')
      : redirect(`${LOGIN_PATH}#error=sso-state`)
  }
  try {
    return claims.linkIntent !== undefined
      ? await completeLink(claims, claims.linkIntent, deps)
      : await completeLogin(claims, deps)
  } catch (error: unknown) {
    return failed(error, deps)
  }
}
