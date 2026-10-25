import type { CapabilityRegistry } from '@camstack/system'
import type {
  IOauthIntegrationProvider,
  IScopedLogger,
  IUserManagementProvider,
  OauthIntegrationDescriptor,
  OauthLandingReason,
  TokenScope,
} from '@camstack/types'
import { oauthLandingUrl } from '@camstack/types'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  isSessionGradeJwtPayload,
  loginRedirectUrl,
  SESSION_COOKIE,
  shouldRedirectToLogin,
} from '../../auth/session-cookie.js'
import { resolveAppPageLang } from '../../auth/app-page-strings.js'
import { renderConsentPage } from './consent-page.js'
import { isPrivateHost } from './private-host.js'

export interface AuthorizeQuery {
  response_type?: string
  /** `string[]` is not defensive typing — Fastify's query parser produces one
   *  the moment a key repeats, and the old `string` annotation is what let a
   *  duplicated `integration` reach `Map.get` as an array and come back
   *  `undefined`, i.e. indistinguishable from an integration nobody declared. */
  integration?: string | readonly string[]
  redirect_uri?: string
  state?: string
  code_challenge?: string
  code_challenge_method?: string
}

export interface AuthorizeRequest {
  integration: string
  redirectUri: string
  state: string
  /** Empty string when the integration does not use PKCE. */
  codeChallenge: string
}

/**
 * What a refusal tells the CALLER about the `integration` parameter — and it
 * is one field, because a caller needs exactly one.
 *
 * `received` is the caller's own input echoed back, truncated: it discloses
 * nothing it did not itself send, and it is the fact that separates "you sent
 * the wrong id" from "you sent none". Everything ELSE the hub knows —
 * which integrations exist, which addons still owe a descriptor — is a fact
 * about the hub's insides and belongs in the log, where an operator reads it.
 * An earlier version of this type argued the opposite (that enumerating was
 * safe because `GET /api/oauth2/integrations` publishes the same list
 * unauthenticated); that a second endpoint discloses something is a reason to
 * look at that endpoint, not a licence for this one.
 *
 * The diagnostic value is NOT lost — see {@link AuthorizeRefusalDiagnostics}
 * and the `warn` in {@link refuseAuthorize}, which still names the received
 * value next to the ids that would have worked.
 */
export interface AuthorizeErrorDetail {
  /** The value as it arrived (repeats joined by `,`), or `null` if absent. */
  readonly received: string | null
}

/**
 * What a refusal tells the LOG, and only the log.
 *
 * A client that needs to distinguish *temporarily unavailable* from *unknown*
 * already can, without either list: the boot-window refusal is `503` +
 * `Retry-After` + `temporarily_unavailable` (RFC 6749 §4.1.2.1), the settled
 * one is `400 invalid_request`. Naming the pending addon added nothing a
 * client could act on and everything an unauthorised reader could learn.
 */
export interface AuthorizeRefusalDiagnostics {
  readonly knownIntegrations: readonly string[]
  /** Addons that declare `oauth-integration` in their manifest and have not
   *  registered their descriptor yet — see {@link IntegrationRegistrySnapshot}.
   *  Without this, a refusal during the boot window is byte-identical in Loki
   *  to one against a hub that has been up for a week. */
  readonly pendingAddons: readonly string[]
}

/**
 * Who made the call — logged, never sent back.
 *
 * `invalid_request — integration parameter missing` / `received: null` survived
 * two rounds of diagnosis on the Home Assistant link because it recorded the
 * FAULT and nothing about the request carrying it. Two stories fit that line
 * identically: the component's URL (which does carry `integration=`) arrived,
 * was bounced to `/login` for want of a cookie and replayed by the login page
 * without its query — or it arrived bare on the first hit. These four fields
 * are the ones that tell them apart, and nothing more is worth the risk of
 * writing an auth query into a log aggregator.
 */
export interface AuthorizeCallContext {
  /** Path only. The query is separate because it is redacted. */
  readonly path: string
  /** The query with every value redacted except the handful that are
   *  themselves diagnostic — see {@link VALUE_SAFE_QUERY_KEYS}. Key ORDER and
   *  repeats are preserved: a stripped replay and a truncating proxy do not
   *  look the same. */
  readonly query: string
  /** Origin + path of the referring page, query DROPPED — a replay from the
   *  login page carries the whole original authorize URL (`?next=…`, `state`
   *  and all) in there. `/login` is the entire signal; the rest is a leak. */
  readonly referer: string | null
  readonly userAgent: string | null
  /** Presence only. Never the value — it is a session JWT. */
  readonly hasSessionCookie: boolean
}

/**
 * Query keys whose VALUE may be logged.
 *
 * Deliberately an allow-list, not a deny-list: a parameter this file has never
 * heard of is redacted by default, so adding one cannot silently start
 * publishing a secret. `state` is a per-attempt nonce the client binds its
 * session to, `code_challenge` is public by design and `code_verifier`/`code`
 * are outright credentials — all four are redacted under the one rule, because
 * the diagnosis needs the KEY NAMES, not the values.
 */
const VALUE_SAFE_QUERY_KEYS: readonly string[] = [
  'response_type',
  'integration',
  'code_challenge_method',
  'client_id',
]

const REDACTED = '<redacted>'
/** Bound on the logged query and user-agent. A refusal must not be able to
 *  write an unbounded caller-controlled string into the log. */
const MAX_LOGGED_FIELD_LEN = 400

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Rebuild a query string with every non-allow-listed value replaced. */
export function redactAuthorizeQuery(rawQuery: string): string {
  if (rawQuery === '') return ''
  const parts: string[] = []
  for (const [key, value] of new URLSearchParams(rawQuery).entries()) {
    parts.push(VALUE_SAFE_QUERY_KEYS.includes(key) ? `${key}=${value}` : `${key}=${REDACTED}`)
  }
  return truncate(parts.join('&'), MAX_LOGGED_FIELD_LEN)
}

/** Strip the query from a `Referer`, keeping origin + path. Returns `null` for
 *  an absent or unparsable header rather than logging it raw. */
function describeReferer(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

/** Everything the log is allowed to know about an inbound authorize call. */
export function describeAuthorizeCall(
  url: string,
  headers: { readonly referer?: string; readonly 'user-agent'?: string },
  hasSessionCookie: boolean,
): AuthorizeCallContext {
  const q = url.indexOf('?')
  const ua = headers['user-agent']
  return {
    path: q === -1 ? url : url.slice(0, q),
    query: q === -1 ? '' : redactAuthorizeQuery(url.slice(q + 1)),
    referer: describeReferer(headers.referer),
    userAgent: ua === undefined || ua === '' ? null : truncate(ua, MAX_LOGGED_FIELD_LEN),
    hasSessionCookie,
  }
}

export type AuthorizeValidation =
  | ({ ok: true } & AuthorizeRequest)
  | {
      ok: false
      status: number
      error: string
      /** The response body. */
      detail?: AuthorizeErrorDetail
      /** The log line. Never serialised into a response. */
      diagnostics?: AuthorizeRefusalDiagnostics
      /** Set only on a retryable refusal; becomes the `Retry-After` header. */
      retryAfterSec?: number
    }

/** What the authorize validator needs to know about the target integration. */
export interface IntegrationPolicy {
  readonly requiresPkce?: boolean
}

/** Longest caller-supplied `integration` value echoed back in an error. */
const MAX_ECHOED_INTEGRATION_LEN = 100

/**
 * `Retry-After` on a refusal caused by an addon that has not registered yet.
 *
 * A forked addon's runner spawns, loads and initialises in seconds. This is
 * advice to the CLIENT and nothing more — the hub never sleeps, never polls
 * and never queues the request ([D3](../../../../../docs/decisions/adr-0003.md));
 * it answers immediately with what is true right now.
 */
const INTEGRATION_PENDING_RETRY_AFTER_SEC = 5

/** Render the received `integration` for a human, bounded. */
function describeReceivedIntegration(raw: string | readonly string[] | undefined): string | null {
  if (raw === undefined) return null
  const joined = typeof raw === 'string' ? raw : raw.join(',')
  if (joined === '') return null
  return joined.length > MAX_ECHOED_INTEGRATION_LEN
    ? `${joined.slice(0, MAX_ECHOED_INTEGRATION_LEN)}…`
    : joined
}

type IntegrationParam =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'missing' | 'conflicting-repeat' }

/**
 * Resolve the `integration` parameter to a single id.
 *
 * A repeat carrying ONE distinct value is collapsed rather than refused:
 * every layer that parses the query — proxy, framework, app — necessarily
 * agrees on the value, so there is no parameter-pollution ambiguity to
 * protect against, and refusing would strand a client whose request is
 * merely redundant. A repeat whose values DISAGREE is exactly that
 * ambiguity, and is refused.
 */
function resolveIntegrationParam(raw: string | readonly string[] | undefined): IntegrationParam {
  if (raw === undefined) return { ok: false, reason: 'missing' }
  if (typeof raw === 'string') {
    return raw === '' ? { ok: false, reason: 'missing' } : { ok: true, value: raw }
  }
  const distinct = [...new Set(raw.filter((v) => v !== ''))]
  const [first] = distinct
  if (first === undefined) return { ok: false, reason: 'missing' }
  if (distinct.length > 1) return { ok: false, reason: 'conflicting-repeat' }
  return { ok: true, value: first }
}

/** Validate the inbound authorize query. `client_id` is intentionally
 *  NOT checked — that pair is verified only at the Lambda boundary, and a
 *  PUBLIC client (`requiresPkce`) has no secret to check it against at all;
 *  the S256 challenge is what binds the code to its requester instead. */
export function validateAuthorizeQuery(
  q: AuthorizeQuery,
  knownIntegrations: ReadonlyMap<string, IntegrationPolicy>,
  pendingAddons: readonly string[] = [],
): AuthorizeValidation {
  if (q.response_type !== 'code')
    return { ok: false, status: 400, error: 'unsupported_response_type' }

  // Four distinct faults used to collapse into one opaque string.
  // Alexa linking was down for a day because the message named neither what
  // arrived nor what would have been accepted.
  const detail: AuthorizeErrorDetail = {
    received: describeReceivedIntegration(q.integration),
  }
  const diagnostics: AuthorizeRefusalDiagnostics = {
    knownIntegrations: [...knownIntegrations.keys()],
    pendingAddons,
  }
  const param = resolveIntegrationParam(q.integration)
  if (!param.ok) {
    const error =
      param.reason === 'missing'
        ? 'invalid_request — integration parameter missing'
        : 'invalid_request — integration parameter repeated with conflicting values'
    return { ok: false, status: 400, error, detail, diagnostics }
  }
  const policy = knownIntegrations.get(param.value)
  if (!policy) {
    // The fourth fault, and the one moving every descriptor into an addon made
    // likelier: the id is absent because the addon that owns it has not
    // registered yet. `invalid_request` means "your request is wrong, do not
    // repeat it" — during boot that is a lie, and it is the lie that sends a
    // client to its degraded fallback and leaves it there. `temporarily_
    // unavailable` is RFC 6749 §4.1.2.1 and says the opposite.
    if (pendingAddons.length > 0) {
      return {
        ok: false,
        status: 503,
        error: 'temporarily_unavailable — integration not registered yet',
        detail,
        diagnostics,
        retryAfterSec: INTEGRATION_PENDING_RETRY_AFTER_SEC,
      }
    }
    return {
      ok: false,
      status: 400,
      error: 'invalid_request — unknown integration',
      detail,
      diagnostics,
    }
  }
  if (!q.redirect_uri)
    return { ok: false, status: 400, error: 'invalid_request — redirect_uri required' }
  if (!q.state) return { ok: false, status: 400, error: 'invalid_request — state required' }

  const challenge = q.code_challenge ?? ''
  if (challenge !== '' && q.code_challenge_method !== 'S256') {
    // `plain` is accepted by the RFC and is worth nothing: the challenge IS
    // the verifier, so an intercepted authorize request yields both.
    return { ok: false, status: 400, error: 'invalid_request — code_challenge_method must be S256' }
  }
  if (policy.requiresPkce === true && challenge === '') {
    return { ok: false, status: 400, error: 'invalid_request — code_challenge required (PKCE)' }
  }

  return {
    ok: true,
    integration: param.value,
    redirectUri: q.redirect_uri,
    state: q.state,
    codeChallenge: challenge,
  }
}

/**
 * True if `redirectUri` is one this integration is allowed to receive a code at.
 *
 * Two independent branches:
 *   - prefix match against `allowedRedirectPrefixes` (Alexa's three fixed
 *     Amazon origins), and
 *   - exact-path match against `allowedPrivateHostPaths` when the host is
 *     private (a self-hosted client whose LAN address the hub cannot know).
 *
 * An unparsable URI is refused rather than falling through to the prefix test —
 * `startsWith` on a string the browser will parse differently is exactly how an
 * allow-list gets walked around.
 */
export function isRedirectUriAllowed(
  redirectUri: string,
  allowedPrefixes: readonly string[],
  allowedPrivateHostPaths: readonly string[] = [],
): boolean {
  if (allowedPrefixes.some((p) => redirectUri.startsWith(p))) return true
  if (allowedPrivateHostPaths.length === 0) return false
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!isPrivateHost(url.hostname)) return false
  return allowedPrivateHostPaths.includes(url.pathname)
}

/** One-line human summary of a scope list for the consent screen. */
export function summariseScopes(scopes: readonly TokenScope[]): string {
  if (scopes.some((s) => s.type === 'category' && s.target === 'device')) {
    return 'view and control all your cameras and devices'
  }
  return scopes.map((s) => s.type).join(', ') || 'no permissions'
}

export interface Oauth2Deps {
  getRegistry: () => CapabilityRegistry | null
  /** The hub's raw session-family verify (it refuses a minted token, D895). Throws when invalid. */
  verifyToken: (token: string) => unknown
  /** Is `userId` a user that exists right now? */
  isLiveUser: (userId: string) => Promise<boolean>
  publicHubUrl: () => Promise<string>
  /** Required, not optional. Every refusal below DROPS an account-linking
   *  attempt, and a drop that logs nothing is indistinguishable in Loki from
   *  a request that never arrived — which is precisely how Alexa linking
   *  stayed broken until an operator reported it by hand. */
  logger: IScopedLogger
}

/**
 * A refused `/authorize`. The two audiences get different things, on purpose.
 *
 * The LOG names the value that arrived next to the ids that would have worked
 * and the addons still owed — that pairing is what turned "unknown
 * integration" from a week-long outage into a diagnosis, and it must not be
 * weakened. The RESPONSE carries only the caller's own echoed input; it tells
 * a client nothing about what else this hub has installed.
 */
function refuseAuthorize(
  request: FastifyRequest,
  reply: FastifyReply,
  logger: IScopedLogger,
  method: 'GET' | 'POST',
  call: AuthorizeCallContext,
  refusal: {
    status: number
    error: string
    detail?: AuthorizeErrorDetail
    diagnostics?: AuthorizeRefusalDiagnostics
    retryAfterSec?: number
  },
): FastifyReply {
  logger.warn(`oauth2 authorize refused: ${refusal.error}`, {
    meta: {
      method,
      ...call,
      received: refusal.detail?.received ?? null,
      knownIntegrations: refusal.diagnostics?.knownIntegrations ?? [],
      pendingAddons: refusal.diagnostics?.pendingAddons ?? [],
    },
  })
  if (refusal.retryAfterSec !== undefined) {
    void reply.header('Retry-After', String(refusal.retryAfterSec))
  }
  return answerRefusal(
    request,
    reply,
    refusal.status,
    { error: refusal.error, ...refusal.detail },
    refusal.status === 503 ? 'unavailable' : 'invalid_request',
    typeof refusal.detail?.received === 'string' ? refusal.detail.received : undefined,
  )
}

/**
 * Answer a refused authorize. A BROWSER (it asked for HTML: a person who
 * followed a link) is sent to the CamStack completion page with a reason CODE
 * — a bare JSON body is a dead end for them. A machine caller keeps the status
 * and JSON it always got. Relative: the browser is already on the hub's origin,
 * and nothing the request carried (the redirect target, the state, any code)
 * goes into the URL.
 */
function answerRefusal(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: Record<string, unknown>,
  reason: OauthLandingReason,
  integration?: string,
): FastifyReply {
  const accept = request.headers.accept
  if (typeof accept === 'string' && accept.includes('text/html')) {
    return reply.redirect(
      oauthLandingUrl(null, {
        status: 'error',
        reason,
        ...(integration !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(integration)
          ? { integration }
          : {}),
      }),
    )
  }
  return reply.status(status).send(body)
}

/** Why an authorize call never reached the validator. */
type UnauthenticatedReason =
  | 'no-session-cookie'
  | 'session-invalid'
  | 'not-a-login-session'
  | 'user-gone'

/** The person signed in behind the consent page's cookie. */
interface ConsentingUser {
  readonly userId: string
  readonly username: string
}

type SessionCookieVerdict =
  | { readonly ok: true; readonly user: ConsentingUser }
  | { readonly ok: false; readonly reason: UnauthenticatedReason }

/**
 * Who consents. ONLY a person's login session: a session-grade JWT (no
 * `kind` — not a bridge, a challenge or a minted token) naming a user that
 * still exists. Anything else this hub signed — a share link, a script's
 * token, an account link — is refused, because a consent mints an account
 * link with the integration's whole grant (security review 2026-10-21: a
 * share link set as the cookie reached `consent=allow` and came back with a
 * fleet-wide device grant for `userId: ''`).
 */
async function consentingUserOf(deps: Oauth2Deps, cookie: string): Promise<SessionCookieVerdict> {
  let payload: unknown
  try {
    payload = deps.verifyToken(cookie)
  } catch {
    return { ok: false, reason: 'session-invalid' }
  }
  if (typeof payload !== 'object' || payload === null || !isSessionGradeJwtPayload(payload)) {
    return { ok: false, reason: 'not-a-login-session' }
  }
  const userId: unknown = Reflect.get(payload, 'userId')
  const username: unknown = Reflect.get(payload, 'username')
  if (typeof userId !== 'string' || userId === '') {
    return { ok: false, reason: 'not-a-login-session' }
  }
  if (!(await deps.isLiveUser(userId))) return { ok: false, reason: 'user-gone' }
  return { ok: true, user: { userId, username: typeof username === 'string' ? username : '' } }
}

/**
 * An authorize call turned away for want of a usable session.
 *
 * It is not a fault, and it is still logged: the browser bounce DEFERS the
 * request through `/login?next=…`, and whatever the replay drops is dropped
 * silently. That is exactly the branch CLAUDE.md requires to speak — with only
 * refusals on the record, "arrived carrying `integration`, came back without
 * it" is invisible and every refusal reads as a first arrival.
 */
function refuseUnauthenticated(
  request: FastifyRequest,
  reply: FastifyReply,
  logger: IScopedLogger,
  call: AuthorizeCallContext,
  reason: UnauthenticatedReason,
): FastifyReply {
  const redirected = shouldRedirectToLogin(request.method, request.headers.accept)
  logger.info(
    redirected ? 'oauth2 authorize bounced to login' : 'oauth2 authorize refused: unauthenticated',
    { meta: { method: request.method, reason, redirected, ...call } },
  )
  if (redirected) return reply.redirect(loginRedirectUrl(request.url))
  return reply.status(401).send({ error: 'unauthorized' })
}

/**
 * What the hub currently knows about linkable integrations.
 *
 * Two facts, and the second is what makes the first interpretable. Every
 * descriptor is declared by an addon ([D101](../../../../../docs/decisions/adr-0101.md)),
 * and an addon registers its provider only once its runner has forked and
 * initialised — so an id missing from `descriptors` may mean "no such
 * integration" OR "not yet". `pendingAddons` is the difference, read from the
 * manifests the addon loader parsed at load time.
 */
export interface IntegrationRegistrySnapshot {
  readonly descriptors: ReadonlyMap<string, OauthIntegrationDescriptor>
  /** Addons whose manifest declares `oauth-integration` and whose provider has
   *  not registered. Non-empty ⇒ `descriptors` is not final. */
  readonly pendingAddons: readonly string[]
}

/** Read integrationId → descriptor from every registered `oauth-integration`
 *  provider, plus the addons that still owe one. */
async function readIntegrationRegistry(
  registry: CapabilityRegistry,
): Promise<IntegrationRegistrySnapshot> {
  const entries = registry.getCollectionEntries<IOauthIntegrationProvider>('oauth-integration')
  const descriptors = new Map<string, OauthIntegrationDescriptor>()
  for (const [, provider] of entries) {
    const descriptor = await provider.getDescriptor()
    descriptors.set(descriptor.integrationId, descriptor)
  }
  const pendingAddons = registry
    .getManifestDeclarers('oauth-integration')
    .filter((addonId) => !registry.hasProvider('oauth-integration', addonId))
  return { descriptors, pendingAddons }
}

/** Parse an application/x-www-form-urlencoded body string into a plain object. */
function parseFormBody(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw)
  const result: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    result[key] = value
  }
  return result
}

export function registerOauth2Routes(fastify: FastifyInstance, deps: Oauth2Deps): void {
  // Register a content-type parser for application/x-www-form-urlencoded so that
  // consent POST and token POST can read form bodies. @fastify/formbody is not in
  // the project's dependencies; we use URLSearchParams (Node built-in) instead.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, parseFormBody(body as string))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // ─── GET /api/oauth2/authorize ────────────────────────────────────────────
  // Mounted under /api/* so it is naturally excluded from the SPA catch-all,
  // the PWA service-worker navigate fallback, and the Vite dev proxy — no
  // per-path special-casing anywhere.
  fastify.get('/api/oauth2/authorize', async (request, reply) => {
    const cookie = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE]
    const call = describeAuthorizeCall(request.url, request.headers, Boolean(cookie))
    if (!cookie) {
      return refuseUnauthenticated(request, reply, deps.logger, call, 'no-session-cookie')
    }

    const consenting = await consentingUserOf(deps, cookie)
    if (!consenting.ok) {
      return refuseUnauthenticated(request, reply, deps.logger, call, consenting.reason)
    }
    const tokenInfo = consenting.user

    const registry = deps.getRegistry()
    if (!registry) {
      return answerRefusal(request, reply, 503, { error: 'service_unavailable' }, 'unavailable')
    }

    const { descriptors, pendingAddons } = await readIntegrationRegistry(registry)
    const query = request.query as AuthorizeQuery
    const v = validateAuthorizeQuery(query, descriptors, pendingAddons)
    if (!v.ok) {
      return refuseAuthorize(request, reply, deps.logger, 'GET', call, v)
    }

    const descriptor = descriptors.get(v.integration)!
    if (
      !isRedirectUriAllowed(
        v.redirectUri,
        descriptor.allowedRedirectPrefixes,
        descriptor.allowedPrivateHostPaths ?? [],
      )
    ) {
      deps.logger.warn('oauth2 authorize refused: redirect_uri not allowed', {
        meta: {
          method: 'GET',
          ...call,
          integration: v.integration,
          redirectUri: v.redirectUri,
          allowedPrefixes: descriptor.allowedRedirectPrefixes,
          allowedPrivateHostPaths: descriptor.allowedPrivateHostPaths ?? [],
        },
      })
      return answerRefusal(
        request,
        reply,
        400,
        { error: 'invalid_request — redirect_uri not allowed for this integration' },
        'invalid_request',
        v.integration,
      )
    }

    const html = renderConsentPage({
      lang: resolveAppPageLang({
        lang: (request.query as Record<string, string | undefined>)['lang'],
        acceptLanguage: request.headers['accept-language'],
      }),
      displayName: descriptor.displayName,
      username: tokenInfo.username,
      scopeSummary: summariseScopes(descriptor.requestedScopes),
      // Shown, not merely validated. A `redirect_uri` on a private host is
      // admitted by pattern rather than by registration, so the operator is
      // the last check on WHERE the code goes — and a consent screen that
      // hides the destination is theatre.
      redirectUri: v.redirectUri,
      hidden: {
        integration: v.integration,
        redirect_uri: v.redirectUri,
        state: v.state,
        response_type: 'code',
        ...(v.codeChallenge !== ''
          ? { code_challenge: v.codeChallenge, code_challenge_method: 'S256' }
          : {}),
      },
    })
    return reply.type('text/html').send(html)
  })

  // ─── GET /api/oauth2/integrations ─────────────────────────────────────────
  // Discovery. A client that has no token yet needs to know whether THIS hub
  // knows it at all — a hub predating an integration must be distinguishable
  // from one that is refusing it, or the client dead-ends on a 400 with no way
  // to fall back. Unauthenticated (so is /token) and it discloses only which
  // integrations are installed.
  //
  // `complete` exists because absence-means-old-hub is a STICKY verdict: a
  // client that probes 200ms after a restart sees a short list, concludes the
  // hub cannot do OAuth, and settles into its password fallback for good. The
  // flag says whether the list is final; a client SHOULD re-probe while it is
  // false rather than downgrade. The pending addon IDS are deliberately not
  // here — this route needs no token, and "not final yet" is the entire signal
  // a client can act on. They are on the session-gated /authorize refusal,
  // where a human is reading them as a diagnosis.
  fastify.get('/api/oauth2/integrations', async (_request, reply) => {
    const registry = deps.getRegistry()
    if (!registry) {
      return reply.status(503).send({ error: 'service_unavailable' })
    }
    const { descriptors, pendingAddons } = await readIntegrationRegistry(registry)
    if (pendingAddons.length > 0) {
      void reply.header('Retry-After', String(INTEGRATION_PENDING_RETRY_AFTER_SEC))
    }
    return reply.send({
      integrations: [...descriptors.values()].map((d) => ({
        integrationId: d.integrationId,
        displayName: d.displayName,
        requiresPkce: d.requiresPkce === true,
      })),
      complete: pendingAddons.length === 0,
    })
  })

  // ─── POST /api/oauth2/authorize ───────────────────────────────────────────
  fastify.post('/api/oauth2/authorize', async (request, reply) => {
    const cookie = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE]
    // `query` is empty here by nature, not by loss: the consent POST carries its
    // parameters as form fields. `method: POST` in the same line says so.
    const call = describeAuthorizeCall(request.url, request.headers, Boolean(cookie))
    if (!cookie) {
      return refuseUnauthenticated(request, reply, deps.logger, call, 'no-session-cookie')
    }

    const consenting = await consentingUserOf(deps, cookie)
    if (!consenting.ok) {
      return refuseUnauthenticated(request, reply, deps.logger, call, consenting.reason)
    }
    const tokenInfo = consenting.user

    const registry = deps.getRegistry()
    if (!registry) {
      return answerRefusal(request, reply, 503, { error: 'service_unavailable' }, 'unavailable')
    }

    const { descriptors, pendingAddons } = await readIntegrationRegistry(registry)
    const body = request.body as Record<string, string | undefined>
    const formQuery: AuthorizeQuery = {
      response_type: body.response_type,
      integration: body.integration,
      redirect_uri: body.redirect_uri,
      state: body.state,
      code_challenge: body.code_challenge,
      code_challenge_method: body.code_challenge_method,
    }
    // Re-validated, not trusted: the hidden fields came back from a browser
    // and every one of them is attacker-editable.
    const v = validateAuthorizeQuery(formQuery, descriptors, pendingAddons)
    if (!v.ok) {
      return refuseAuthorize(request, reply, deps.logger, 'POST', call, v)
    }

    const descriptor = descriptors.get(v.integration)!
    if (
      !isRedirectUriAllowed(
        v.redirectUri,
        descriptor.allowedRedirectPrefixes,
        descriptor.allowedPrivateHostPaths ?? [],
      )
    ) {
      deps.logger.warn('oauth2 authorize refused: redirect_uri not allowed', {
        meta: {
          method: 'POST',
          ...call,
          integration: v.integration,
          redirectUri: v.redirectUri,
          allowedPrefixes: descriptor.allowedRedirectPrefixes,
          allowedPrivateHostPaths: descriptor.allowedPrivateHostPaths ?? [],
        },
      })
      return answerRefusal(
        request,
        reply,
        400,
        { error: 'invalid_request — redirect_uri not allowed for this integration' },
        'invalid_request',
        v.integration,
      )
    }

    if (body.consent !== 'allow') {
      return reply.redirect(
        `${v.redirectUri}?error=access_denied&state=${encodeURIComponent(v.state)}`,
      )
    }

    const userMgmt = registry.getSingleton<IUserManagementProvider>('user-management')
    if (!userMgmt) {
      return reply.status(503).send({ error: 'service_unavailable' })
    }

    const { code } = await userMgmt.oauthIssueCode({
      integrationId: v.integration,
      userId: tokenInfo.userId,
      username: tokenInfo.username,
      scopes: descriptor.requestedScopes,
      redirectUri: v.redirectUri,
      // Prefer the integration's own public origin (e.g. the operator-selected
      // external-access endpoint surfaced by a forked exporter addon) so the
      // claim the cloud Lambda routes back on is the reachable public URL, not
      // the hub-global fallback (which defaults to localhost in dev).
      hubUrl: descriptor.hubUrl ?? (await deps.publicHubUrl()),
      ...(v.codeChallenge !== '' ? { codeChallenge: v.codeChallenge } : {}),
      // The integration declares its own refresh lifetime; omitting the field
      // keeps the 30-day default. Baked in HERE, at consent, so the link the
      // operator approved carries the lifetime they approved.
      ...(descriptor.refreshTokenTtlSec !== undefined
        ? { refreshTtlSec: descriptor.refreshTokenTtlSec }
        : {}),
    })

    return reply.redirect(
      `${v.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(v.state)}`,
    )
  })

  // ─── POST /api/oauth2/token ───────────────────────────────────────────────
  // No session gate — called by Alexa/Lambda directly.
  fastify.post('/api/oauth2/token', async (request, reply) => {
    const registry = deps.getRegistry()
    if (!registry) {
      return reply.status(503).send({ error: 'service_unavailable' })
    }

    const userMgmt = registry.getSingleton<IUserManagementProvider>('user-management')
    if (!userMgmt) {
      return reply.status(503).send({ error: 'service_unavailable' })
    }

    const body = request.body as Record<string, string | undefined>

    type TokenResult = { accessToken: string; refreshToken: string; expiresIn: number } | null

    let tokenResult: TokenResult
    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri) {
        return reply.status(400).send({ error: 'invalid_request' })
      }
      tokenResult = await userMgmt.oauthExchangeCode({
        code: body.code,
        redirectUri: body.redirect_uri,
        // Optional here and mandatory in the grant: the requirement is carried
        // by the CODE (it embeds the challenge), not by this endpoint, so it
        // cannot be dropped by a client that simply omits the parameter.
        ...(body.code_verifier ? { codeVerifier: body.code_verifier } : {}),
      })
    } else if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) {
        return reply.status(400).send({ error: 'invalid_request' })
      }
      tokenResult = await userMgmt.oauthRefresh({ refreshToken: body.refresh_token })
    } else {
      return reply.status(400).send({ error: 'unsupported_grant_type' })
    }

    if (tokenResult === null) {
      return reply.status(400).send({ error: 'invalid_grant' })
    }

    return reply.send({
      access_token: tokenResult.accessToken,
      refresh_token: tokenResult.refreshToken,
      expires_in: tokenResult.expiresIn,
      token_type: 'Bearer',
    })
  })
}
