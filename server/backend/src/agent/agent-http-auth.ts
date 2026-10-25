/**
 * Agent HTTP auth — pure request-authorization helpers for the agent's
 * port-4444 API (mirrors the hub's /health hardening).
 *
 * Model (D857, which replaced the Bearer cluster secret):
 *   - loopback callers (the Electron renderer, the agent's own page on its own
 *     machine, in-container probes) are always allowed — whoever is at the
 *     machine is the operator;
 *   - remote callers need a session token, minted by redeeming a hub unlock
 *     ticket (D821): an ES256 ticket signed by the mesh CA the agent was paired
 *     with, redeemed through `POST /api/agent/session`;
 *   - the PAIRING protocol endpoints are reachable by anyone on the network,
 *     in either state: each is authorized by what it carries (a pairing id the
 *     agent made up, a proof the mesh CA signed), never by who calls. An
 *     unpaired agent offers nothing else remotely.
 */

/** The header/socket facts needed to authorize one request. */
export interface AgentAuthInput {
  readonly remoteAddress?: string | undefined
  readonly authorization?: string | undefined
  /** The request carried a forwarding header: a proxy is in front, so the socket peer is not the caller. */
  readonly forwarded?: boolean | undefined
  /** Request line method and the headers a web page cannot forge or omit (D857, DNS rebinding / CSRF). */
  readonly method?: string | undefined
  readonly host?: string | undefined
  readonly origin?: string | undefined
  readonly contentType?: string | undefined
}

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** `host[:port]` of the agent's own machine: localhost, 127.0.0.1 or [::1]. */
export function isLocalHostHeader(host: string): boolean {
  const lower = host.trim().toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name !== undefined && LOCAL_HOSTNAMES.has(name)
}

/**
 * The Host/Origin/Content-Type checks that keep a WEB PAGE from being "this machine". A page on
 * any site can make the browser call 127.0.0.1:4444 (CORS blocks reading, not sending) or rebind
 * a hostname to it; what it cannot do is send a local Host, a same-origin Origin or a JSON
 * content type on a cross-site request (D857).
 */
function isBrowserSafeLocal(input: AgentAuthInput): boolean {
  if (input.host !== undefined && !isLocalHostHeader(input.host)) return false
  if (input.origin !== undefined) {
    let originHost: string
    try {
      originHost = new URL(input.origin).host
    } catch {
      return false
    }
    if (!isLocalHostHeader(originHost)) return false
    if (input.host !== undefined && originHost.toLowerCase() !== input.host.trim().toLowerCase()) {
      return false
    }
  }
  const method = input.method?.toUpperCase()
  if (method !== undefined && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const type = (input.contentType ?? '').split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') return false
  }
  return true
}

/** Build the auth input of a Node/Fastify request. */
export function authInputOf(req: {
  readonly method: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly socket: { readonly remoteAddress?: string | undefined }
}): AgentAuthInput {
  const one = (name: string): string | undefined => {
    const v = req.headers[name]
    return typeof v === 'string' ? v : undefined
  }
  return {
    remoteAddress: req.socket.remoteAddress ?? undefined,
    forwarded: hasForwardingHeader(req.headers),
    method: req.method,
    host: one('host'),
    origin: one('origin'),
    contentType: one('content-type'),
    authorization: one('authorization'),
  }
}

const FORWARDING_HEADERS: readonly string[] = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'via',
  'cf-connecting-ip',
]

/** True when any header says the request was relayed (D857): then loopback proves nothing. */
export function hasForwardingHeader(headers: Readonly<Record<string, unknown>>): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined)
}

/**
 * A request from this machine itself: a loopback peer AND no forwarding header. A reverse proxy on
 * the same host makes every caller look like 127.0.0.1; the header it adds is what gives it away.
 */
export function isGenuineLoopback(input: AgentAuthInput): boolean {
  return (
    input.forwarded !== true && isLoopbackAddress(input.remoteAddress) && isBrowserSafeLocal(input)
  )
}

/** IPv4/IPv6 loopback (incl. the IPv4-mapped IPv6 form Node reports). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  if (addr === '::1') return true
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr
  // 127.0.0.0/8 — every octet must be numeric so '127.evil.host' fails.
  const parts = v4.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((p) => /^\d{1,3}$/.test(p))
}

/** Extract the bearer token value, or `null`. */
export function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice('Bearer '.length)
  return token.length > 0 ? token : null
}

/**
 * True when the request may access the protected agent API: it comes from this
 * machine, or it carries a session token minted from a hub unlock ticket.
 */
export function isAuthorizedAgentRequest(
  input: AgentAuthInput,
  sessionTokenOk: (token: string) => boolean = () => false,
): boolean {
  if (isGenuineLoopback(input)) return true
  const token = readBearerToken(input.authorization)
  return token !== null && sessionTokenOk(token)
}

const PAIRING_GET: ReadonlySet<string> = new Set([
  '/api/agent/pairing/hello',
  '/api/agent/pairing/status',
])
const PAIRING_POST: ReadonlySet<string> = new Set([
  '/api/agent/pairing/offer',
  '/api/agent/pairing/reveal',
  '/api/agent/pairing/poll',
  '/api/agent/pairing/reset',
  '/api/agent/pairing/cancel',
  '/api/agent/pairing/confirm',
  '/api/agent/pairing/reject',
  '/api/agent/pairing/complete',
])

/**
 * The pairing protocol endpoints (D857): the only `/api/` routes reachable from
 * the network without a session. `forget` is NOT among them — leaving a hub is an
 * authenticated action (this machine, or a hub-unlocked session).
 */
export function isPairingProtocolRequest(method: string, urlPath: string): boolean {
  const pathOnly = urlPath.split('?')[0] ?? urlPath
  if (method === 'GET') return PAIRING_GET.has(pathOnly)
  if (method === 'POST') return PAIRING_POST.has(pathOnly)
  return false
}

/**
 * Redeem a hub unlock ticket for a session token — reachable remotely without
 * a prior session (the ticket IS the proof). Paired agents only.
 */
export function isUnlockSessionRequest(method: string, urlPath: string): boolean {
  const pathOnly = urlPath.split('?')[0] ?? urlPath
  return method === 'POST' && pathOnly === '/api/agent/session'
}

/**
 * Public unlock probe: `nodeId` + hub HTTPS origin for Continue-with-hub (D821).
 * No secrets, no metrics — only what the locked unlock screen needs.
 */
export function isUnlockInfoRequest(method: string, urlPath: string): boolean {
  const pathOnly = urlPath.split('?')[0] ?? urlPath
  return method === 'GET' && pathOnly === '/api/agent/unlock-info'
}
