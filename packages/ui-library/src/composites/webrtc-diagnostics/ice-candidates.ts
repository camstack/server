/**
 * ICE candidate parsing for the WebRTC diagnostics.
 *
 * The hub session test has to answer "what addresses did the HUB offer this
 * browser?" — the one fact that decides whether a remote or relay-only client
 * can ever reach it. The answer lives in two places: the `a=candidate` lines of
 * the hub's answer SDP and the candidates it trickles afterwards
 * (`webrtcSession.getIceCandidates`). Both are the RFC 8839 grammar:
 *
 *   candidate:<foundation> <component> <transport> <priority> <address> <port>
 *     typ <type> [raddr <address> rport <port>] [tcptype <t>] ...
 *
 * Everything that could not be read stays `null` (D393): a candidate whose
 * port did not parse has an unknown port, not port 0.
 */

export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown'

/** Where an address is reachable from. `tailscale` is the 100.64.0.0/10
 *  CGNAT range and Tailscale's `fd7a:115c:a1e0::/48` — reachable only from
 *  inside that tailnet, exactly like a LAN address. */
export type AddressScope =
  | 'loopback'
  | 'link-local'
  | 'lan'
  | 'tailscale'
  | 'mdns'
  | 'public'
  | 'unknown'

export type AddressFamily = 'ipv4' | 'ipv6' | 'mdns' | 'unknown'

export interface ParsedIceCandidate {
  readonly type: IceCandidateType
  readonly protocol: string | null
  readonly address: string | null
  readonly port: number | null
  readonly relatedAddress: string | null
  readonly relatedPort: number | null
  readonly family: AddressFamily
  readonly scope: AddressScope
  /** The candidate attribute as received, without `a=`. */
  readonly raw: string
}

/**
 * How reachable the hub's offered set is from outside its own networks.
 * - `public-path`: at least one srflx, relay or public host candidate.
 * - `private-only`: candidates exist, all LAN / Tailscale / loopback / mDNS.
 * - `none`: the hub answered and offered nothing (yet).
 * - `unknown`: no answer was received, so nothing was measured.
 */
export type HubReachabilityFlag = 'public-path' | 'private-only' | 'none' | 'unknown'

export interface HubCandidateSummary {
  readonly candidates: readonly ParsedIceCandidate[]
  readonly fromSdp: number
  readonly fromTrickle: number
  readonly countByType: Readonly<Record<IceCandidateType, number>>
  readonly hasSrflx: boolean
  readonly hasRelay: boolean
  readonly hasPublicHost: boolean
  readonly flag: HubReachabilityFlag
  /** Whether the hub reported its gathering complete; null when never asked. */
  readonly trickleDone: boolean | null
}

export interface SummarizeHubCandidatesInput {
  readonly sdpAnswer: string | null
  readonly trickled: readonly string[]
  readonly trickleDone: boolean | null
}

const CANDIDATE_TYPES: readonly IceCandidateType[] = ['host', 'srflx', 'prflx', 'relay']

function intOrNull(token: string | undefined): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null
  const n = Number(token)
  return Number.isSafeInteger(n) ? n : null
}

function familyOf(address: string): AddressFamily {
  if (address.length === 0) return 'unknown'
  if (address.toLowerCase().endsWith('.local')) return 'mdns'
  if (address.includes(':')) return 'ipv6'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return 'ipv4'
  return 'unknown'
}

function ipv4Octets(address: string): readonly number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => Number(p))
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null
}

function ipv4Scope(address: string): AddressScope {
  const o = ipv4Octets(address)
  if (o === null) return 'unknown'
  const [a = -1, b = -1] = o
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'lan'
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
  return 'public'
}

function ipv6Scope(address: string): AddressScope {
  const lower = address.toLowerCase()
  if (lower === '::1') return 'loopback'
  if (/^fe[89ab]/.test(lower)) return 'link-local'
  if (lower.startsWith('fd7a:115c:a1e0:')) return 'tailscale'
  if (/^f[cd]/.test(lower)) return 'lan'
  return 'public'
}

export function classifyAddressScope(address: string): AddressScope {
  switch (familyOf(address)) {
    case 'mdns':
      return 'mdns'
    case 'ipv4':
      return ipv4Scope(address)
    case 'ipv6':
      return ipv6Scope(address)
    default:
      return 'unknown'
  }
}

/** Parse one candidate attribute (`candidate:…`, with or without `a=`). */
export function parseIceCandidate(line: string): ParsedIceCandidate | null {
  const raw = line.trim().replace(/^a=/, '')
  if (!raw.startsWith('candidate:')) return null
  const parts = raw.slice('candidate:'.length).split(/\s+/)
  // [foundation, component, transport, priority, address, port, 'typ', type, ...]
  const address = parts[4] ?? ''
  const typIdx = parts.indexOf('typ')
  const typeToken = typIdx >= 0 ? parts[typIdx + 1] : undefined
  const type: IceCandidateType = CANDIDATE_TYPES.find((t) => t === typeToken) ?? 'unknown'
  const raddrIdx = parts.indexOf('raddr')
  const rportIdx = parts.indexOf('rport')
  const protocol = parts[2]?.toLowerCase()
  return {
    type,
    protocol: protocol !== undefined && protocol.length > 0 ? protocol : null,
    address: address.length > 0 ? address : null,
    port: intOrNull(parts[5]),
    relatedAddress: raddrIdx >= 0 ? (parts[raddrIdx + 1] ?? null) : null,
    relatedPort: rportIdx >= 0 ? intOrNull(parts[rportIdx + 1]) : null,
    family: familyOf(address),
    scope: classifyAddressScope(address),
    raw,
  }
}

/** Every `a=candidate` line of an SDP, in order. */
export function candidateLinesFromSdp(sdp: string): readonly string[] {
  return sdp
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('a=candidate:'))
}

function candidateKey(c: ParsedIceCandidate): string {
  return `${c.type}|${c.protocol ?? '?'}|${c.address ?? '?'}|${String(c.port ?? '?')}`
}

const PRIVATE_SCOPES: ReadonlySet<AddressScope> = new Set([
  'loopback',
  'link-local',
  'lan',
  'tailscale',
  'mdns',
])

function emptyCounts(): Record<IceCandidateType, number> {
  return { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 }
}

export function countCandidateTypes(
  candidates: readonly ParsedIceCandidate[],
): Readonly<Record<IceCandidateType, number>> {
  const counts = emptyCounts()
  for (const c of candidates) counts[c.type] += 1
  return counts
}

function reachabilityFlag(
  answered: boolean,
  candidates: readonly ParsedIceCandidate[],
): HubReachabilityFlag {
  if (!answered && candidates.length === 0) return 'unknown'
  if (candidates.length === 0) return 'none'
  const publicPath = candidates.some(
    (c) => c.type === 'srflx' || c.type === 'relay' || (c.type === 'host' && c.scope === 'public'),
  )
  if (publicPath) return 'public-path'
  return candidates.every((c) => PRIVATE_SCOPES.has(c.scope)) ? 'private-only' : 'public-path'
}

/** The hub's offered candidates: answer SDP plus trickle, deduplicated. */
export function summarizeHubCandidates(input: SummarizeHubCandidatesInput): HubCandidateSummary {
  const seen = new Set<string>()
  const candidates: ParsedIceCandidate[] = []
  const add = (line: string): boolean => {
    const c = parseIceCandidate(line)
    if (c === null) return false
    const key = candidateKey(c)
    if (seen.has(key)) return false
    seen.add(key)
    candidates.push(c)
    return true
  }
  let fromSdp = 0
  for (const line of candidateLinesFromSdp(input.sdpAnswer ?? '')) if (add(line)) fromSdp += 1
  let fromTrickle = 0
  for (const line of input.trickled) if (add(line)) fromTrickle += 1
  return {
    candidates,
    fromSdp,
    fromTrickle,
    countByType: countCandidateTypes(candidates),
    hasSrflx: candidates.some((c) => c.type === 'srflx'),
    hasRelay: candidates.some((c) => c.type === 'relay'),
    hasPublicHost: candidates.some((c) => c.type === 'host' && c.scope === 'public'),
    flag: reachabilityFlag(input.sdpAnswer !== null, candidates),
    trickleDone: input.trickleDone,
  }
}
