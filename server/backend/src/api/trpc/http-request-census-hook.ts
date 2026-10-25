/**
 * The seam that feeds {@link HttpRequestCensus} from a live tRPC request.
 *
 * ## Why this hangs off `createContext` and not `onRequest`
 *
 * `onRequest` sees every HTTP request the hub serves, but it does not know WHO
 * sent it: the bearer has not been validated yet, so the only identity
 * available there is the raw `Authorization` header - which must never be
 * logged, copied or keyed on. The tRPC context factory is the FIRST place a
 * principal exists, and `@trpc/server` calls it exactly ONCE per HTTP request
 * (`resolveResponse` -> `ctxManager.create`), after the batch has been parsed
 * and before any procedure resolves. So it is also the only place where one
 * call = one request, batched or not.
 *
 * What it does not see: a request so malformed that `getRequestInfo` throws
 * before a context is built. That request never invoked a procedure either, so
 * it cannot be part of a procedure-call storm and its absence does not weaken
 * the conclusion the totals support.
 *
 * ## Cost when disarmed
 *
 * The armed check is the FIRST statement, before the request is touched at
 * all: no header read, no URL parse, no `Date.now()`, no allocation. The spec
 * pins this with a request whose every property getter throws - if the guard
 * ever moves below a field access, that test fails instead of the hub paying
 * for a diagnostic nobody switched on.
 */

import type { AuthenticatedAgent } from './trpc.context.js'
import { type ClientRequest, extractClientIp, extractUserAgent } from './client-ip.js'
import { type HttpRequestCensus, parseTrpcProcedures } from './http-request-census.js'
import { describeTrpcPrincipal } from './trpc-error-principal.js'

/**
 * Count one tRPC HTTP request against `census`.
 *
 * `user` is the resolved principal or `null`; it is rendered by
 * `describeTrpcPrincipal`, the same function the tRPC error log already uses -
 * a username and a credential KIND, never a token and never a header.
 */
export function recordTrpcHttpRequest(
  census: HttpRequestCensus,
  req: ClientRequest | undefined,
  user: AuthenticatedAgent | null,
): void {
  if (!census.armed) return
  if (req === undefined) return

  const url = typeof req.url === 'string' ? req.url : ''
  const procedures = parseTrpcProcedures(url, headerValue(req, 'content-type'))
  if (procedures.length === 0) return

  census.observeHttpRequest({
    procedures,
    userAgent: extractUserAgent(req),
    ip: extractClientIp(req),
    principal: describeTrpcPrincipal(user),
  })
}

/** First value of a possibly-repeated header, or `null`. */
function headerValue(req: ClientRequest, name: string): string | null {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : null
}
