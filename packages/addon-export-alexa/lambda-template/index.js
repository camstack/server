/**
 * CamStack Alexa Smart Home Lambda — one skill, many hubs, and the skill's
 * token broker (D753).
 *
 * One Lambda + one skill serves every CamStack hub. Directives are routed by
 * the `hubUrl` claim each hub bakes into the OAuth tokens it mints. Since D753
 * the Lambda is also the ONLY holder of the skill's LWA client secret: it
 * exchanges AcceptGrant codes itself, keeps each user's LWA refresh token in
 * DynamoDB, and hands hubs short-lived Event Gateway access tokens against a
 * per-link credential (see broker.js).
 *
 * Invocation shapes:
 *   1. Function URL GET  /authorize      → hub-URL entry form
 *   2. Function URL POST /token          → OAuth token exchange, proxied to the hub
 *   3. Function URL POST /broker/*       → token broker (broker.js)
 *   4. Smart Home directive:
 *      - Alexa.Authorization/AcceptGrant → exchange the LWA code here, store the
 *        grant, give the hub a broker credential (legacy: give it the tokens)
 *      - everything else                 → forward to the hub
 *
 * Configuration (env — none of these is a secret once D753 is deployed):
 *   LWA_PARAM            SSM SecureString parameter name (e.g.
 *                        /camstack/alexa/lwa) holding {"clientId","clientSecret"}
 *                        for the skill's "Send Alexa Events" LWA client.
 *   SKILL_PARAM          SSM SecureString parameter name (e.g.
 *                        /camstack/alexa/skill) holding {"clientId",
 *                        "clientSecret"[,"previousClientSecret"]} for account
 *                        linking.
 *   TOKENS_TABLE         DynamoDB table of broker links. Unset = broker off
 *                        (pre-D753 behaviour: tokens are handed to the hub).
 *   LAMBDA_REDIRECT_URI  Function URL + "/token"; the AcceptGrant redirect_uri.
 *   BROKER_PUBLIC_URL    Optional; defaults to LAMBDA_REDIRECT_URI's origin.
 *   LEGACY_HUB_FALLBACK  "0" = a hub without the broker route fails AcceptGrant
 *                        instead of receiving the refresh token. Default on.
 *   ALLOW_MIGRATION      "0" = refuse /broker/migrate. Default on.
 *   HUB_INGRESS_TOKEN    Optional defense-in-depth header for hub calls.
 *   DEBUG_DIRECTIVES     "1" = log one `directive_trace` line per directive
 *                        (debug-trace.js; never the bearer). Default off.
 * Legacy (read only when the *_PARAM is unset): LWA_CLIENT_ID,
 * LWA_CLIENT_SECRET, SKILL_CLIENT_ID, SKILL_CLIENT_SECRET.
 *
 * Ships as plain files — no node_modules, no transpile (`zip` the folder's
 * .js files). AWS SDK v3 comes with the nodejs22.x runtime.
 */
'use strict'

const crypto = require('node:crypto')

const { createAwsClients } = require('./aws.js')
const {
  activateLink,
  createLink,
  exchangeGrantCode,
  handleBrokerRoute,
  isBrokerPath,
  shortId,
} = require('./broker.js')
const { handleAuthorizePage } = require('./authorize-page.js')
const { traceDirective } = require('./debug-trace.js')
const { timedFetch } = require('./http.js')
const { createSecretSource } = require('./secrets.js')
const { createDynamoTokenStore } = require('./token-store.js')
const {
  decodeBody,
  acceptGrantErrorEnvelope,
  completeErrorResponse,
  decodeJwtPayload,
  describe,
  encodeFormUrlEncoded,
  errorEnvelope,
  jsonResponse,
  normaliseHubUrl,
  parseFormUrlEncoded,
  resolveBrokerPublicUrl,
} = require('./util.js')

/** The header that tells a hub where its skill's broker lives (D753). */
const BROKER_HEADER = 'x-camstack-broker'

/**
 * Build the dependency set once per container — the secret cache and the SDK
 * clients must survive across invocations. Anything passed in wins (tests).
 */
function resolveDeps(overrides) {
  const o = overrides || {}
  const env = o.env || process.env
  let aws = null
  const awsClients = () => {
    if (!aws) aws = createAwsClients()
    return aws
  }
  const store =
    o.store !== undefined
      ? o.store
      : env.TOKENS_TABLE
        ? createDynamoTokenStore({
            send: (name, input) => awsClients().send(name, input),
            tableName: env.TOKENS_TABLE,
          })
        : null
  return {
    env,
    fetch: o.fetch || timedFetch,
    now: o.now || Date.now,
    randomBytes: o.randomBytes || crypto.randomBytes,
    log: o.log || console,
    secrets:
      o.secrets ||
      createSecretSource({
        env,
        readParameter: (name) => awsClients().readParameter(name),
      }),
    store,
    publicUrl: resolveBrokerPublicUrl(env),
  }
}

function createHandler(overrides) {
  let deps = null
  return async (event) => {
    if (!deps) deps = resolveDeps(overrides)
    const startedAt = deps.now()
    try {
      if (event && event.requestContext && event.requestContext.http) {
        return await handleLambdaUrl(event, deps)
      }
      if (event && event.directive && event.directive.header) {
        const res = await handleDirective(event, deps)
        traceDirective(deps, event, res, startedAt)
        return res
      }
      return jsonResponse(400, { error: 'unknown_event' })
    } catch (err) {
      deps.log.error('camstack-alexa: unhandled error', describe(err))
      if (event && event.directive && event.directive.header) {
        const res = errorEnvelope(
          event.directive.header,
          'INTERNAL_ERROR',
          describe(err),
          event.directive.endpoint,
        )
        traceDirective(deps, event, res, startedAt)
        return res
      }
      return jsonResponse(500, { error: 'internal_error', message: describe(err) })
    }
  }
}

// ── Lambda Function URL (HTTP) routes ────────────────────────────────

async function handleLambdaUrl(event, deps) {
  const path = event.rawPath || '/'
  if (path === '/authorize') return handleAuthorizePage(event, deps)
  if (path === '/token') return handleTokenProxy(event, deps)
  if (isBrokerPath(path)) return handleBrokerRoute(event, deps)
  return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' }
}

/** Constant-time string equality that does not leak length via timing. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab)
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Proxy the OAuth token exchange. Alexa POSTs a form-urlencoded body with the
 * account-linking client_id/client_secret; we verify those (current secret, or
 * `previousClientSecret` mid-rotation), decode the code/refresh_token JWT
 * payload to find the hub URL claim, then forward the body to the hub's own
 * /api/oauth2/token endpoint.
 */
async function handleTokenProxy(event, deps) {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' })
  }
  const body = parseFormUrlEncoded(decodeBody(event))
  const skill = await deps.secrets.skill()
  if (!skill) {
    return jsonResponse(500, {
      error: 'unconfigured',
      message: 'account-linking client credentials are not configured',
    })
  }
  const secretOk =
    typeof body.client_secret === 'string' &&
    (safeEqual(body.client_secret, skill.clientSecret) ||
      (skill.previousClientSecret !== undefined &&
        safeEqual(body.client_secret, skill.previousClientSecret)))
  if (body.client_id !== skill.clientId || !secretOk) {
    return jsonResponse(401, { error: 'invalid_client', message: 'client credentials mismatch' })
  }

  const tokenInput = body.grant_type === 'refresh_token' ? body.refresh_token : body.code
  if (!tokenInput) {
    return jsonResponse(400, {
      error: 'invalid_request',
      message: 'code or refresh_token is required',
    })
  }
  const claims = decodeJwtPayload(tokenInput)
  if (!claims || typeof claims.hubUrl !== 'string' || claims.hubUrl.length === 0) {
    return jsonResponse(400, {
      error: 'invalid_grant',
      message: 'token has no hubUrl claim — was it minted by a hub that supports cloud-mode?',
    })
  }

  const target = `${normaliseHubUrl(claims.hubUrl)}/api/oauth2/token`
  const upstream = await deps.fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodeFormUrlEncoded(body),
  })
  const text = await upstream.text()
  return {
    statusCode: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
    body: text,
  }
}

// ── Smart Home directives ────────────────────────────────────────────

async function handleDirective(event, deps) {
  const header = event.directive.header
  const ns = `${header.namespace}/${header.name}`
  if (ns === 'Alexa.Authorization/AcceptGrant') {
    return handleAcceptGrant(event, deps)
  }
  return forwardDirective(event, deps)
}

function hubHeaders(deps, bearer) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer}`,
    // Defense-in-depth shared secret — the export-alexa "Ingress token"
    // setting. Sent only when configured; the hub enforces it when the
    // operator turns on "Require ingress token".
    ...(deps.env.HUB_INGRESS_TOKEN ? { 'x-camstack-ingress': deps.env.HUB_INGRESS_TOKEN } : {}),
  }
}

function brokerAvailable(deps) {
  return deps.store !== null && typeof deps.publicUrl === 'string'
}

function acceptGrantResponse(header) {
  return {
    event: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'AcceptGrant.Response',
        messageId: header.messageId,
        payloadVersion: '3',
      },
      payload: {},
    },
  }
}

async function handleAcceptGrant(event, deps) {
  const header = event.directive.header
  const payload = event.directive.payload || {}
  const grantCode = payload.grant && payload.grant.code
  const granteeToken = payload.grantee && payload.grantee.token
  if (!grantCode || !granteeToken) {
    return acceptGrantErrorEnvelope(header, 'payload missing grant.code or grantee.token')
  }
  const claims = decodeJwtPayload(granteeToken)
  if (!claims || typeof claims.hubUrl !== 'string' || claims.hubUrl.length === 0) {
    return acceptGrantErrorEnvelope(header, 'grantee token has no hubUrl claim')
  }
  const redirectUri = deps.env.LAMBDA_REDIRECT_URI
  if (!redirectUri) {
    return acceptGrantErrorEnvelope(header, 'LAMBDA_REDIRECT_URI not set on the Lambda')
  }

  let tokens
  try {
    tokens = await exchangeGrantCode(deps, grantCode, redirectUri)
  } catch (err) {
    return acceptGrantErrorEnvelope(header, describe(err))
  }
  const hubUrl = normaliseHubUrl(claims.hubUrl)

  if (brokerAvailable(deps)) {
    const outcome = await linkViaBroker(deps, { hubUrl, granteeToken, tokens })
    if (outcome.kind === 'linked') return acceptGrantResponse(header)
    if (outcome.kind !== 'hub-without-broker' || deps.env.LEGACY_HUB_FALLBACK === '0') {
      return acceptGrantErrorEnvelope(header, outcome.message)
    }
    deps.log.warn(
      'accept_grant: hub has no broker route; falling back to the legacy token hand-off',
    )
  }
  return deliverTokensToLegacyHub(deps, header, { hubUrl, granteeToken, tokens })
}

/**
 * The D753 link: store the grant here, give the hub only a credential and a
 * first access token. The item stays `pending` until the hub accepted it, so a
 * hub that refuses (or does not have the route) leaves nothing behind.
 */
async function linkViaBroker(deps, input) {
  const { item, credential } = await createLink(deps, {
    status: 'pending',
    tokens: input.tokens,
    hubUrl: input.hubUrl,
    origin: 'accept-grant',
  })
  let resp
  try {
    resp = await deps.fetch(`${input.hubUrl}/addon/export-alexa/oauth/broker-link`, {
      method: 'POST',
      headers: hubHeaders(deps, input.granteeToken),
      body: JSON.stringify({
        brokerUrl: deps.publicUrl,
        brokerCredential: credential,
        lwaAccessToken: item.accessToken,
        expiresAt: item.accessExpiresAt,
      }),
    })
  } catch (err) {
    await deps.store.remove(item.linkId)
    return { kind: 'failed', message: `hub broker-link unreachable: ${describe(err)}` }
  }
  if (resp.ok) {
    await activateLink(deps, item)
    deps.log.info('accept_grant: linked via broker', { link: shortId(item.linkId) })
    return { kind: 'linked' }
  }
  await deps.store.remove(item.linkId)
  if (resp.status === 404) return { kind: 'hub-without-broker', message: 'hub broker-link 404' }
  const text = await resp.text().catch(() => '')
  return { kind: 'failed', message: `hub broker-link ${resp.status}: ${text.slice(0, 200)}` }
}

/** Pre-D753 hand-off: the hub receives the refresh token itself. */
async function deliverTokensToLegacyHub(deps, header, input) {
  const callbackResp = await deps.fetch(`${input.hubUrl}/addon/export-alexa/oauth/lwa-tokens`, {
    method: 'POST',
    headers: hubHeaders(deps, input.granteeToken),
    body: JSON.stringify({
      lwaAccessToken: input.tokens.accessToken,
      lwaRefreshToken: input.tokens.refreshToken,
      expiresAt: deps.now() + input.tokens.expiresInSec * 1000,
    }),
  })
  if (!callbackResp.ok) {
    const text = await callbackResp.text().catch(() => '')
    return acceptGrantErrorEnvelope(
      header,
      `hub callback ${callbackResp.status}: ${text.slice(0, 200)}`,
    )
  }
  return acceptGrantResponse(header)
}

/** HTTP statuses that mean the hub itself is down or unreachable behind its tunnel. */
function isBridgeDownStatus(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)
}

async function forwardDirective(event, deps) {
  const directive = event.directive
  const header = directive.header
  const endpoint = directive.endpoint
  const bearer = extractBearer(directive)
  if (!bearer) {
    return errorEnvelope(
      header,
      'INVALID_AUTHORIZATION_CREDENTIAL',
      'directive has no bearer token',
      endpoint,
    )
  }
  const claims = decodeJwtPayload(bearer)
  if (!claims || typeof claims.hubUrl !== 'string' || claims.hubUrl.length === 0) {
    return errorEnvelope(
      header,
      'INVALID_AUTHORIZATION_CREDENTIAL',
      'bearer has no hubUrl claim',
      endpoint,
    )
  }
  const target = `${normaliseHubUrl(claims.hubUrl)}/addon/export-alexa/directive`
  let resp
  try {
    resp = await deps.fetch(target, {
      method: 'POST',
      headers: {
        ...hubHeaders(deps, bearer),
        // Where this skill's broker lives. A hub linked before D753 uses it to
        // migrate its refresh token here (zero-touch); the hub only believes it
        // on a directive whose bearer it verified.
        ...(brokerAvailable(deps) ? { [BROKER_HEADER]: deps.publicUrl } : {}),
      },
      body: JSON.stringify(event),
    })
  } catch (err) {
    // The hub is the bridge every endpoint sits behind (alexa-errorresponse).
    return errorEnvelope(
      header,
      'BRIDGE_UNREACHABLE',
      `hub unreachable: ${describe(err)}`,
      endpoint,
    )
  }
  const text = await resp.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    const type = isBridgeDownStatus(resp.status) ? 'BRIDGE_UNREACHABLE' : 'INTERNAL_ERROR'
    return errorEnvelope(header, type, `hub returned ${resp.status}, non-JSON`, endpoint)
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.event || !parsed.event.header) {
    // e.g. `{ error: 'invalid_ingress_token' }` — never hand Alexa a non-event.
    return errorEnvelope(
      header,
      'INTERNAL_ERROR',
      `hub returned ${resp.status} without an Alexa event`,
      endpoint,
    )
  }
  return completeErrorResponse(parsed, directive)
}

function extractBearer(directive) {
  if (
    directive.endpoint &&
    directive.endpoint.scope &&
    typeof directive.endpoint.scope.token === 'string'
  ) {
    return directive.endpoint.scope.token
  }
  if (
    directive.payload &&
    directive.payload.scope &&
    typeof directive.payload.scope.token === 'string'
  ) {
    return directive.payload.scope.token
  }
  return null
}

exports.handler = createHandler()
exports.createHandler = createHandler
exports.BROKER_HEADER = BROKER_HEADER
