/**
 * Small pure helpers shared by the Lambda's modules. No I/O here.
 */
'use strict'

/** Base64url-decode a JWT's payload WITHOUT verifying it — routing only. */
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

function normaliseHubUrl(raw) {
  return raw.replace(/\/+$/, '')
}

function decodeBody(event) {
  if (!event.body) return ''
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8')
  }
  return event.body
}

function parseFormUrlEncoded(body) {
  const out = {}
  if (!body) return out
  for (const pair of body.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' ')
    const value = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '').replace(/\+/g, ' ')
    out[key] = value
  }
  return out
}

function encodeFormUrlEncoded(obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(obj[k]))}`)
    .join('&')
}

/** JSON body of a Function URL request, or null when absent/unparseable. */
function parseJsonBody(event) {
  const raw = decodeBody(event)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** `Authorization: Bearer <x>` from a Function URL event (headers are lower-cased). */
function readBearer(event) {
  const headers = event.headers || {}
  const value = headers.authorization || headers.Authorization
  if (typeof value !== 'string') return null
  const m = /^bearer\s+(.+)$/i.exec(value.trim())
  return m ? m[1].trim() : null
}

/**
 * The broker's public origin, as hubs must call it. `BROKER_PUBLIC_URL` when
 * set, else the origin of `LAMBDA_REDIRECT_URI` (which is the Function URL +
 * `/token`). HTTPS only — a hub refuses anything else.
 */
function resolveBrokerPublicUrl(env) {
  const raw = env.BROKER_PUBLIC_URL || env.LAMBDA_REDIRECT_URI
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  }
}

/**
 * `Alexa.ErrorResponse` for a directive. Amazon requires the directive's
 * `correlationToken` and the target `endpoint` on it (alexa-errorresponse);
 * both are copied when the directive carried them.
 */
function errorEnvelope(header, type, message, endpoint) {
  const endpointId =
    endpoint && typeof endpoint.endpointId === 'string' ? endpoint.endpointId : null
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        messageId: header.messageId,
        ...(typeof header.correlationToken === 'string'
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      ...(endpointId !== null ? { endpoint: { endpointId } } : {}),
      payload: { type, message },
    },
  }
}

/** AcceptGrant's own error: `Alexa.Authorization/ErrorResponse` (alexa-authorization). */
function acceptGrantErrorEnvelope(header, message) {
  return {
    event: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'ErrorResponse',
        messageId: header.messageId,
        payloadVersion: '3',
      },
      payload: { type: 'ACCEPT_GRANT_FAILED', message },
    },
  }
}

/**
 * Fill in what an `Alexa.ErrorResponse` from a hub may lack — a hub running an
 * older addon omits `correlationToken` and `endpoint`. Any other body is
 * returned as it is.
 */
function completeErrorResponse(body, directive) {
  const ev = body && body.event
  if (!ev || !ev.header || ev.header.name !== 'ErrorResponse' || ev.header.namespace !== 'Alexa') {
    return body
  }
  const header = { ...ev.header }
  if (
    header.correlationToken === undefined &&
    typeof directive.header.correlationToken === 'string'
  ) {
    header.correlationToken = directive.header.correlationToken
  }
  const endpointId =
    directive.endpoint && typeof directive.endpoint.endpointId === 'string'
      ? directive.endpoint.endpointId
      : null
  const endpoint = ev.endpoint || (endpointId !== null ? { endpointId } : undefined)
  return { ...body, event: { ...ev, header, ...(endpoint ? { endpoint } : {}) } }
}

function describe(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

module.exports = {
  decodeJwtPayload,
  normaliseHubUrl,
  decodeBody,
  parseFormUrlEncoded,
  encodeFormUrlEncoded,
  parseJsonBody,
  readBearer,
  resolveBrokerPublicUrl,
  jsonResponse,
  errorEnvelope,
  acceptGrantErrorEnvelope,
  completeErrorResponse,
  describe,
}
