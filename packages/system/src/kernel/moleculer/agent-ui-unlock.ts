/**
 * Agent UI remote unlock tickets (D821, re-keyed by D857).
 *
 * A hub admin mints a short-lived ticket bound to one agent `nodeId`, signed
 * with the MESH CA key (ES256 JWS). The agent verifies it
 * with the CA certificate it pinned at pairing and redeems it once for a tab
 * session Bearer. There is no shared secret: a ticket is worth exactly as much
 * as the CA key that signed it, and the agent trusts exactly the CA its
 * operator confirmed during pairing.
 *
 *   ticket  = b64url(header) '.' b64url(payload) '.' b64url(ES256 signature)
 *   header  = { alg: 'ES256', typ: 'camstack-agent-ui-unlock+jwt' }
 *   payload = { v: 1, use: 'agent-ui-unlock', nodeId, iat (ms), exp (ms), jti }
 *
 * The `typ` and `use` pins keep a join token or a pairing proof (also signed
 * by the CA key) from ever being accepted here, and the reverse.
 */
import { createPrivateKey, randomBytes, sign, verify, X509Certificate } from 'node:crypto'
import { isLocalOnlyHostname, isPrivateAddress } from '../../tls/agent-https.js'

export const AGENT_UI_UNLOCK_TYP = 'camstack-agent-ui-unlock+jwt'
export const AGENT_UI_UNLOCK_USE = 'agent-ui-unlock'
export const AGENT_UI_UNLOCK_VERSION = 1 as const
/** Ticket lifetime — long enough for a redirect hop, short enough to steal poorly. */
export const AGENT_UI_UNLOCK_TTL_MS: number = 5 * 60_000

/**
 * Cluster settings key: extra origins allowed as `returnTo` for Continue-with-hub
 * (NPM hostnames that are not `:4444` on a LAN IP). Comma-separated origins.
 */
export const AGENT_DASHBOARD_ORIGINS_FIELD = 'agentDashboardOrigins'

export interface AgentUiUnlockPayload {
  readonly v: typeof AGENT_UI_UNLOCK_VERSION
  readonly nodeId: string
  /** Epoch ms the ticket was issued; `exp - iat` never exceeds {@link AGENT_UI_UNLOCK_TTL_MS}. */
  readonly iat: number
  /** Epoch ms. */
  readonly exp: number
  readonly jti: string
}

/** In-memory spent `jti` until `exp` (ms). */
export class UnlockTicketJtiStore {
  private readonly spent = new Map<string, number>()

  isSpent(jti: string, nowMs: number = Date.now()): boolean {
    this.gc(nowMs)
    return this.spent.has(jti)
  }

  /** Record a jti as used until `exp`. Returns false if already spent. */
  consume(jti: string, exp: number, nowMs: number = Date.now()): boolean {
    this.gc(nowMs)
    if (this.spent.has(jti)) return false
    this.spent.set(jti, exp)
    return true
  }

  /** Test helper. */
  size(): number {
    return this.spent.size
  }

  private gc(nowMs: number): void {
    for (const [jti, exp] of this.spent) {
      if (exp <= nowMs) this.spent.delete(jti)
    }
  }
}

export interface MintAgentUiUnlockTicketInput {
  /** The mesh CA's private key, PKCS#8 PEM (`MeshCaSigner.keyPem`). */
  readonly caKeyPem: string
  readonly nodeId: string
  readonly ttlMs?: number
  readonly nowMs?: number
  readonly jti?: string
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function mintAgentUiUnlockTicket(input: MintAgentUiUnlockTicketInput): string {
  const nowMs = input.nowMs ?? Date.now()
  const ttl = Math.min(
    Math.max(1_000, input.ttlMs ?? AGENT_UI_UNLOCK_TTL_MS),
    AGENT_UI_UNLOCK_TTL_MS,
  )
  const payload = {
    v: AGENT_UI_UNLOCK_VERSION,
    use: AGENT_UI_UNLOCK_USE,
    nodeId: input.nodeId,
    iat: nowMs,
    exp: nowMs + ttl,
    jti: input.jti ?? randomBytes(16).toString('base64url'),
  }
  const signingInput = `${b64urlJson({ alg: 'ES256', typ: AGENT_UI_UNLOCK_TYP })}.${b64urlJson(payload)}`
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: createPrivateKey(input.caKeyPem),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

export interface VerifyAgentUiUnlockTicketOptions {
  readonly expectedNodeId: string
  readonly nowMs?: number
  /**
   * Refuse a ticket issued before this instant (the agent's boot): the one-use ledger lives in
   * memory, so a ticket from before a restart could otherwise be replayed.
   */
  readonly notBeforeMs?: number
}

/** A ticket is issued now-ish, lives at most the TTL, and not before `notBeforeMs`. */
function issuedSanely(
  payload: AgentUiUnlockPayload,
  nowMs: number,
  notBeforeMs: number | undefined,
): boolean {
  if (payload.iat > nowMs + 60_000) return false
  if (payload.exp - payload.iat > AGENT_UI_UNLOCK_TTL_MS) return false
  return notBeforeMs === undefined || payload.iat >= notBeforeMs
}

/**
 * Verify a ticket against the mesh CA certificate the agent pinned. Returns the
 * payload, or `null` when the signature, header, shape, expiry or nodeId fails
 * (no reason string — refuse quietly).
 */
export function verifyAgentUiUnlockTicket(
  caCertPem: string,
  ticket: string,
  options: VerifyAgentUiUnlockTicketOptions,
): AgentUiUnlockPayload | null {
  const nowMs = options.nowMs ?? Date.now()
  const parts = ticket.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
    return null
  }
  let header: unknown
  let parsed: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof header !== 'object' || header === null) return null
  if (
    Reflect.get(header, 'alg') !== 'ES256' ||
    Reflect.get(header, 'typ') !== AGENT_UI_UNLOCK_TYP
  ) {
    return null
  }
  let valid = false
  try {
    valid = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      { key: new X509Certificate(caCertPem).publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    )
  } catch {
    return null
  }
  if (!valid) return null
  const payload = parsePayload(parsed)
  if (payload === null) return null
  if (payload.exp <= nowMs) return null
  if (payload.nodeId !== options.expectedNodeId) return null
  if (!issuedSanely(payload, nowMs, options.notBeforeMs)) return null
  return payload
}

/**
 * True when `returnTo` may receive a ticket redirect. Default: any http(s)
 * origin whose port is 4444. Extra origins come from
 * {@link AGENT_DASHBOARD_ORIGINS_FIELD} (exact origin match).
 */
export function isAllowedAgentDashboardReturnTo(
  returnTo: string,
  extraOrigins: readonly string[] = [],
): boolean {
  let url: URL
  try {
    url = new URL(returnTo)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  // Path must be root or empty — never open an arbitrary path with a ticket.
  if (url.pathname !== '/' && url.pathname !== '') return false
  // An unlock ticket must never leave the operator's own network: a public host is not an agent.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = host === 'localhost' || isPrivateAddress(host) || isLocalOnlyHostname(host)
  if (url.port === '4444') return local
  const origin = url.origin
  return extraOrigins.some((o) => o === origin)
}

/** Parse a stored comma/whitespace-separated origins list. */
/**
 * True when `returnTo` points at an address the hub itself knows for the node (`knownNames`: its id
 * and the address of its live mesh socket), or at an origin the operator listed. `knownNames` of
 * `null` (nothing recorded for the node yet) refuses.
 */
export function isKnownAgentAddress(
  returnTo: string,
  knownNames: readonly string[] | null,
  listedOrigins: readonly string[] = [],
): boolean {
  let url: URL
  try {
    url = new URL(returnTo)
  } catch {
    return false
  }
  if (listedOrigins.includes(url.origin)) return true
  // No names recorded for the node: no returnTo (the UI then shows the link without auto-return).
  if (knownNames === null) return false
  return knownNames.includes(url.hostname.replace(/^\[|\]$/g, '').toLowerCase())
}

export function parseAgentDashboardOrigins(stored: unknown): readonly string[] {
  if (typeof stored !== 'string' || stored.trim().length === 0) return []
  const out: string[] = []
  for (const part of stored.split(/[,\s]+/)) {
    const t = part.trim()
    if (t.length === 0) continue
    try {
      const u = new URL(t)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.origin)
    } catch {
      /* skip malformed */
    }
  }
  return out
}

function parsePayload(value: unknown): AgentUiUnlockPayload | null {
  if (typeof value !== 'object' || value === null) return null
  const rec = value as Record<string, unknown>
  if (rec['v'] !== AGENT_UI_UNLOCK_VERSION) return null
  if (rec['use'] !== AGENT_UI_UNLOCK_USE) return null
  const nodeId = rec['nodeId']
  const exp = rec['exp']
  const jti = rec['jti']
  const iat = rec['iat']
  if (typeof nodeId !== 'string' || nodeId.length === 0) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (typeof jti !== 'string' || jti.length === 0) return null
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null
  return { v: AGENT_UI_UNLOCK_VERSION, nodeId, iat, exp, jti }
}
