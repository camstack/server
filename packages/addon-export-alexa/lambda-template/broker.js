/**
 * The Alexa token broker (D753).
 *
 * The skill's LWA client secret authenticates every grant exchange and every
 * refresh at api.amazon.com. Before D753 a copy of it lived in every hub — in
 * public source and in a public npm package. Now it lives ONLY here (read from
 * an SSM SecureString parameter), together with each user's LWA refresh token, and a hub
 * gets exactly what it needs to push events: a short-lived access token.
 *
 * A hub authenticates to the broker with a PER-LINK credential
 * `csb1.<linkId>.<secret>` minted at link time:
 *   - no shared secret: each link has its own, so one leaked hub exposes one
 *     link, never the skill;
 *   - only sha256(secret) is stored, compared in constant time;
 *   - revocable: delete the item (`/broker/revoke`, or the item's TTL lapses);
 *   - rotatable: `/broker/rotate` swaps the secret atomically, and every
 *     re-link mints a fresh one (the old item expires on its idle TTL).
 *
 * HTTP routes (Function URL, POST only):
 *   /broker/token    Bearer <credential>         → { accessToken, expiresAt }
 *   /broker/migrate  { refreshToken }            → { brokerCredential, brokerUrl, accessToken, expiresAt }
 *   /broker/rotate   Bearer <credential>         → { brokerCredential }
 *   /broker/revoke   Bearer <credential>         → { ok: true }
 *
 * `/broker/migrate` is the zero-touch path for a hub linked before D753: it
 * still holds a refresh token (and, until it updates, the leaked secret). The
 * broker proves the token is a live grant OF THIS SKILL by refreshing it with
 * the skill's secret — possession of that token is already the full power of
 * the grant, so the broker hands back nothing the caller did not have. The hub
 * then deletes its copy. Disable with `ALLOW_MIGRATION=0` once every hub moved.
 *
 * Nothing here logs a token, a code, a credential or a secret.
 */
'use strict'

const crypto = require('node:crypto')
const { encodeFormUrlEncoded, jsonResponse, parseJsonBody, readBearer } = require('./util.js')

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
const CREDENTIAL_PREFIX = 'csb1'
/** Hand out a cached access token only while it has at least this much life left. */
const ACCESS_TOKEN_MIN_LIFE_MS = 5 * 60 * 1000
/** A pending (mid-AcceptGrant) item that never activated is gone after this. */
const PENDING_TTL_SEC = 60 * 60
/** An active link nobody refreshed for this long is purged by DynamoDB TTL. */
const IDLE_TTL_SEC = 180 * 24 * 60 * 60

class BrokerError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// ── Credentials ──────────────────────────────────────────────────────

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

/** @param {(n: number) => Buffer} randomBytes */
function mintCredential(randomBytes, linkId) {
  const id = linkId || randomBytes(16).toString('base64url')
  const secret = randomBytes(32).toString('base64url')
  return {
    linkId: id,
    secretHash: sha256Hex(secret),
    credential: `${CREDENTIAL_PREFIX}.${id}.${secret}`,
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/

function parseCredential(raw) {
  if (typeof raw !== 'string') return null
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== CREDENTIAL_PREFIX) return null
  const [, linkId, secret] = parts
  if (!B64URL.test(linkId) || !B64URL.test(secret)) return null
  if (linkId.length < 16 || linkId.length > 64 || secret.length < 32 || secret.length > 128) {
    return null
  }
  return { linkId, secret }
}

function secretMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length !== 64) return false
  const a = Buffer.from(sha256Hex(secret), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ── LWA ──────────────────────────────────────────────────────────────

async function postLwa(deps, params, creds) {
  const resp = await deps.fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodeFormUrlEncoded({
      ...params,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  })
  const text = await resp.text().catch(() => '')
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { ok: resp.ok, status: resp.status, body }
}

function lwaErrorCode(res) {
  return res.body && typeof res.body.error === 'string' ? res.body.error : null
}

/**
 * One call to the LWA token endpoint with the skill's credentials. On
 * `invalid_client` with a Parameter-Store-sourced secret, drops the cache and
 * retries once with a freshly read value — so a rotation takes effect on the
 * very next call instead of after the cache TTL.
 */
async function lwaTokenCall(deps, params) {
  const creds = await deps.secrets.lwa()
  if (!creds) {
    throw new BrokerError(500, 'unconfigured', 'LWA client credentials are not configured')
  }
  let res = await postLwa(deps, params, creds)
  if (lwaErrorCode(res) === 'invalid_client' && creds.source === 'ssm') {
    deps.secrets.invalidate('lwa')
    const fresh = await deps.secrets.lwa()
    if (fresh && fresh.clientSecret !== creds.clientSecret) {
      deps.log.warn('broker: LWA rejected the cached client secret; retried with a fresh read')
      res = await postLwa(deps, params, fresh)
    }
  }
  return res
}

function readLwaTokens(res, fallbackRefreshToken) {
  const b = res.body || {}
  if (typeof b.access_token !== 'string' || b.access_token.length === 0) return null
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600
  const refreshToken =
    typeof b.refresh_token === 'string' && b.refresh_token.length > 0
      ? b.refresh_token
      : fallbackRefreshToken
  if (!refreshToken) return null
  return { accessToken: b.access_token, refreshToken, expiresInSec: expiresIn }
}

/** Exchange an AcceptGrant code. Throws BrokerError on any failure. */
async function exchangeGrantCode(deps, code, redirectUri) {
  const res = await lwaTokenCall(deps, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })
  const tokens = res.ok ? readLwaTokens(res, null) : null
  if (!tokens) {
    throw new BrokerError(
      502,
      'lwa_exchange_failed',
      `LWA exchange ${res.status} ${lwaErrorCode(res) || ''}`.trim(),
    )
  }
  return tokens
}

/** Refresh a grant. `invalid_grant` → 410 (the user disabled the skill / Amazon revoked it). */
async function refreshGrant(deps, refreshToken) {
  const res = await lwaTokenCall(deps, { grant_type: 'refresh_token', refresh_token: refreshToken })
  if (!res.ok) {
    if (lwaErrorCode(res) === 'invalid_grant') {
      throw new BrokerError(
        410,
        'grant_revoked',
        'Amazon no longer honours this grant; re-link the skill',
      )
    }
    throw new BrokerError(
      502,
      'lwa_unavailable',
      `LWA refresh ${res.status} ${lwaErrorCode(res) || ''}`.trim(),
    )
  }
  const tokens = readLwaTokens(res, refreshToken)
  if (!tokens)
    throw new BrokerError(502, 'lwa_malformed', 'LWA refresh answered without an access token')
  return tokens
}

// ── Link lifecycle ───────────────────────────────────────────────────

function nowSec(deps) {
  return Math.floor(deps.now() / 1000)
}

/**
 * Create a link item for freshly obtained tokens. `status` is `pending` for an
 * AcceptGrant (activated only after the hub accepted the credential) and
 * `active` for a migration (the caller already proved possession).
 */
async function createLink(deps, opts) {
  const minted = mintCredential(deps.randomBytes)
  const now = deps.now()
  const item = {
    linkId: minted.linkId,
    secretHash: minted.secretHash,
    status: opts.status,
    refreshToken: opts.tokens.refreshToken,
    accessToken: opts.tokens.accessToken,
    accessExpiresAt: now + opts.tokens.expiresInSec * 1000,
    ...(opts.hubUrl ? { hubUrl: opts.hubUrl } : {}),
    origin: opts.origin,
    createdAt: now,
    lastUsedAt: now,
    ttl: nowSec(deps) + (opts.status === 'pending' ? PENDING_TTL_SEC : IDLE_TTL_SEC),
    version: 1,
  }
  await deps.store.create(item)
  return { item, credential: minted.credential }
}

async function activateLink(deps, item) {
  const next = {
    ...item,
    status: 'active',
    ttl: nowSec(deps) + IDLE_TTL_SEC,
    version: item.version + 1,
  }
  const ok = await deps.store.replace(next, item.version)
  if (!ok) throw new BrokerError(409, 'conflict', 'link changed while activating')
  return next
}

/** Resolve the request's credential to an ACTIVE item, or throw 401. */
async function authenticate(deps, event) {
  const parsed = parseCredential(readBearer(event))
  if (!parsed)
    throw new BrokerError(401, 'invalid_credential', 'broker credential missing or malformed')
  const item = await deps.store.get(parsed.linkId)
  // One answer for "no such link", "not active" and "wrong secret" — the
  // response must not tell a prober which linkIds exist.
  if (!item || item.status !== 'active' || !secretMatches(parsed.secret, item.secretHash)) {
    throw new BrokerError(401, 'invalid_credential', 'broker credential not recognised')
  }
  return item
}

/** A valid access token for the item, refreshing (and persisting) when needed. */
async function currentAccessToken(deps, item) {
  const now = deps.now()
  if (item.accessToken && item.accessExpiresAt - now > ACCESS_TOKEN_MIN_LIFE_MS) return item
  let tokens
  try {
    tokens = await refreshGrant(deps, item.refreshToken)
  } catch (err) {
    if (err instanceof BrokerError && err.code === 'grant_revoked') {
      await deps.store.remove(item.linkId)
      deps.log.warn('broker: grant revoked by Amazon; link removed', { link: shortId(item.linkId) })
    }
    throw err
  }
  const next = {
    ...item,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: now + tokens.expiresInSec * 1000,
    lastUsedAt: now,
    ttl: nowSec(deps) + IDLE_TTL_SEC,
    version: item.version + 1,
  }
  if (await deps.store.replace(next, item.version)) return next
  // Someone refreshed concurrently. Their write carries the newest refresh
  // token; serve what they stored rather than overwrite it.
  const fresh = await deps.store.get(item.linkId)
  if (fresh && fresh.status === 'active' && fresh.accessExpiresAt > now) return fresh
  throw new BrokerError(503, 'conflict', 'concurrent refresh; retry')
}

function shortId(linkId) {
  return typeof linkId === 'string' ? linkId.slice(0, 6) : '?'
}

// ── HTTP routes ──────────────────────────────────────────────────────

const ROUTES = {
  '/broker/token': routeToken,
  '/broker/migrate': routeMigrate,
  '/broker/rotate': routeRotate,
  '/broker/revoke': routeRevoke,
}

function isBrokerPath(path) {
  return Object.prototype.hasOwnProperty.call(ROUTES, path)
}

async function handleBrokerRoute(event, deps) {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' })
  }
  if (!deps.store) {
    return jsonResponse(503, { error: 'broker_unconfigured', message: 'TOKENS_TABLE is not set' })
  }
  try {
    return await ROUTES[event.rawPath](event, deps)
  } catch (err) {
    if (err instanceof BrokerError) {
      if (err.status >= 500)
        deps.log.warn('broker: request failed', { route: event.rawPath, code: err.code })
      return jsonResponse(err.status, { error: err.code, message: err.message })
    }
    throw err
  }
}

async function routeToken(event, deps) {
  const item = await authenticate(deps, event)
  const current = await currentAccessToken(deps, item)
  return jsonResponse(200, { accessToken: current.accessToken, expiresAt: current.accessExpiresAt })
}

async function routeMigrate(event, deps) {
  if (deps.env.ALLOW_MIGRATION === '0') {
    return jsonResponse(403, { error: 'migration_disabled', message: 're-link the skill instead' })
  }
  const brokerUrl = deps.publicUrl
  if (!brokerUrl) {
    return jsonResponse(503, { error: 'broker_unconfigured', message: 'broker public URL unknown' })
  }
  const body = parseJsonBody(event)
  const refreshToken = body && typeof body.refreshToken === 'string' ? body.refreshToken : ''
  if (refreshToken.length === 0 || refreshToken.length > 4096) {
    return jsonResponse(400, { error: 'invalid_request', message: 'refreshToken is required' })
  }
  let tokens
  try {
    tokens = await refreshGrant(deps, refreshToken)
  } catch (err) {
    if (err instanceof BrokerError && err.code === 'grant_revoked') {
      throw new BrokerError(400, 'invalid_grant', 'not a live grant of this skill')
    }
    throw err
  }
  const hubUrl = body && typeof body.hubUrl === 'string' ? body.hubUrl.slice(0, 512) : undefined
  const { item, credential } = await createLink(deps, {
    status: 'active',
    tokens,
    hubUrl,
    origin: 'migration',
  })
  deps.log.info('broker: migrated a pre-broker grant', { link: shortId(item.linkId) })
  return jsonResponse(200, {
    brokerCredential: credential,
    brokerUrl,
    accessToken: item.accessToken,
    expiresAt: item.accessExpiresAt,
  })
}

async function routeRotate(event, deps) {
  const item = await authenticate(deps, event)
  const minted = mintCredential(deps.randomBytes, item.linkId)
  const next = { ...item, secretHash: minted.secretHash, version: item.version + 1 }
  if (!(await deps.store.replace(next, item.version))) {
    throw new BrokerError(409, 'conflict', 'link changed while rotating; retry')
  }
  deps.log.info('broker: credential rotated', { link: shortId(item.linkId) })
  return jsonResponse(200, { brokerCredential: minted.credential })
}

async function routeRevoke(event, deps) {
  const item = await authenticate(deps, event)
  await deps.store.remove(item.linkId)
  deps.log.info('broker: link revoked by its hub', { link: shortId(item.linkId) })
  return jsonResponse(200, { ok: true })
}

module.exports = {
  BrokerError,
  LWA_TOKEN_URL,
  ACCESS_TOKEN_MIN_LIFE_MS,
  PENDING_TTL_SEC,
  IDLE_TTL_SEC,
  mintCredential,
  parseCredential,
  secretMatches,
  sha256Hex,
  lwaTokenCall,
  exchangeGrantCode,
  refreshGrant,
  createLink,
  activateLink,
  currentAccessToken,
  isBrokerPath,
  handleBrokerRoute,
  shortId,
}
