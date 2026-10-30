/**
 * Why a push to Home Assistant failed, in words an operator can act on.
 *
 * The reason used to live only in the log line's `meta.error`, which a log
 * viewer that shows the message alone never displays: an operator saw
 * "push failed, messages dropped" every 30 s for hours with nothing to act on.
 */

/** Where the custom component registers its push view inside HA. */
export const PUSH_PATH = '/api/camstack/push'

const MAX_BODY_CHARS = 200

/** A non-2xx answer from Home Assistant's push view. */
export class PushHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Home Assistant answered ${String(status)}`)
    this.name = 'PushHttpError'
  }
}

/** First 200 chars of a response body, with any bearer token removed. */
export function scrubBody(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, MAX_BODY_CHARS)
}

export type PushFailureKind =
  | 'token-rejected'
  | 'component-missing'
  | 'too-large'
  | 'unreachable'
  | 'other'

export interface PushFailure {
  readonly kind: PushFailureKind
  /** One sentence, the whole reason; goes in the log message and on the status page. */
  readonly text: string
  /** A state that will not fix itself: do not retry it every tick. */
  readonly permanent: boolean
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
])

function networkCode(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return code
    current = current.cause
  }
  return undefined
}

export function describePushFailure(err: unknown): PushFailure {
  if (err instanceof PushHttpError) {
    const http = `HTTP ${String(err.status)}`
    if (err.status === 404) {
      return {
        kind: 'component-missing',
        permanent: true,
        text: `${http} — Home Assistant has no CamStack integration installed (the ${PUSH_PATH} endpoint is missing). Install it from HACS, or turn off Home Assistant export`,
      }
    }
    if (err.status === 401 || err.status === 403) {
      return {
        kind: 'token-rejected',
        permanent: false,
        text: `${http} — Home Assistant rejected the access token (revoked, or the user lacks rights); create a new long-lived token`,
      }
    }
    if (err.status === 413) {
      return {
        kind: 'too-large',
        permanent: false,
        text: `${http} — the batch is too large for Home Assistant or a proxy in front of it`,
      }
    }
    const body = scrubBody(err.body)
    return {
      kind: 'other',
      permanent: false,
      text: body.length > 0 ? `${http} — ${body}` : http,
    }
  }
  const timedOut =
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
  const code = networkCode(err)
  const fetchFailed = err instanceof TypeError && err.message === 'fetch failed'
  if (timedOut || code !== undefined || fetchFailed) {
    const why = timedOut ? 'timed out' : (code ?? 'network error')
    return {
      kind: 'unreachable',
      permanent: false,
      text: `Home Assistant is unreachable (${why}) — check the address and that it is running`,
    }
  }
  return {
    kind: 'other',
    permanent: false,
    text: err instanceof Error ? err.message : String(err),
  }
}

/**
 * POST one message to Home Assistant's push view.
 *
 * Authenticated with the broker's OWN long-lived token: the component
 * registers its view behind HA auth, so there is no second shared secret
 * to configure or rotate. A non-2xx throws `PushHttpError` carrying the first
 * 200 chars of the body (never the request headers), which is how the push
 * client learns why the instance is not taking the push.
 */
export async function postToHomeAssistant(
  baseUrl: string,
  token: string,
  message: unknown,
): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${PUSH_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new PushHttpError(response.status, scrubBody(body))
  }
}
