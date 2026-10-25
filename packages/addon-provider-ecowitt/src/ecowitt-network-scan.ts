import type { DiscoveredGateway } from '@apocaliss92/nodewitt'

/**
 * The subset of {@link import('@apocaliss92/nodewitt').Ecowitt.discover} this module drives. A single
 * sweep of ONE broadcast target (the addon node's local subnet when `broadcastAddr` is omitted). The
 * library already dedups its own responders by MAC per call; this module composes MANY such sweeps
 * (one per operator-supplied subnet) into a cross-subnet scan.
 */
export type EcowittDiscoverFn = (options: {
  broadcastAddr?: string
  timeoutMs?: number
}) => Promise<readonly DiscoveredGateway[]>

/** Strict dotted-quad IPv4 octet (0–255), no leading-zero ambiguity beyond what routers accept. */
function parseOctet(token: string): number | null {
  if (!/^\d{1,3}$/.test(token)) return null
  const n = Number(token)
  return n >= 0 && n <= 255 ? n : null
}

/** Parse a dotted-quad into its four octets, or null when malformed. */
function parseIpv4(value: string): readonly [number, number, number, number] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(parseOctet)
  if (octets.some((o) => o === null)) return null
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
}

/**
 * Convert an IPv4 CIDR (e.g. `192.0.2.0/24`) into its directed broadcast address
 * (`192.0.2.255`) — the address `Ecowitt.discover` sweeps to reach a foreign subnet. Returns
 * `null` for anything that is not a well-formed IPv4 CIDR (a bare IP, garbage, or an out-of-range
 * prefix), so the caller can treat the input as a literal broadcast/gateway address instead.
 */
export function cidrToBroadcast(value: string): string | null {
  const slash = value.indexOf('/')
  if (slash < 0) return null
  const ip = parseIpv4(value.slice(0, slash))
  const prefixToken = value.slice(slash + 1)
  if (ip === null || !/^\d{1,2}$/.test(prefixToken)) return null
  const prefix = Number(prefixToken)
  if (prefix < 0 || prefix > 32) return null

  const base = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0
  const hostMask = prefix === 0 ? 0xffffffff : (0xffffffff >>> prefix) >>> 0
  const broadcast = (base | hostMask) >>> 0
  return [
    (broadcast >>> 24) & 0xff,
    (broadcast >>> 16) & 0xff,
    (broadcast >>> 8) & 0xff,
    broadcast & 0xff,
  ].join('.')
}

/**
 * Parse the operator scan input into a de-duplicated, ordered list of directed broadcast targets.
 *
 * Accepts a free-form string of comma / newline / whitespace separated tokens where each token is
 * either a broadcast address (`192.0.2.255`), a bare gateway IP (`192.0.2.10` — the
 * `CMD_BROADCAST` probe answers a unicast too), or a CIDR (`192.0.2.0/24`, expanded to its
 * directed broadcast). Blank input yields an empty list, meaning "sweep the local subnet only".
 * Invalid tokens are dropped rather than throwing — discovery input is best-effort.
 */
export function parseBroadcastTargets(raw: string): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rawToken of raw.split(/[\s,]+/)) {
    const token = rawToken.trim()
    if (token.length === 0) continue
    const target = token.includes('/') ? cidrToBroadcast(token) : parseIpv4(token) ? token : null
    if (target === null || seen.has(target)) continue
    seen.add(target)
    out.push(target)
  }
  return out
}

export interface ScanEcowittGatewaysInput {
  /** The library sweep primitive (usually `Ecowitt.discover`). */
  readonly discover: EcowittDiscoverFn
  /** Directed broadcast targets from {@link parseBroadcastTargets}. Empty → one local sweep. */
  readonly targets: readonly string[]
  /** Per-sweep UDP collection window (ms). */
  readonly timeoutMs?: number
  /** Invoked (never throws) when one subnet sweep fails, so the scan can continue. */
  readonly onError?: (target: string, error: unknown) => void
}

/** Deterministic dedup key for a discovered gateway — MAC is the physical identity. */
function gatewayKey(gateway: DiscoveredGateway): string {
  return gateway.mac.trim().toLowerCase() || gateway.ip
}

/**
 * Cross-subnet Ecowitt discovery: run one {@link EcowittDiscoverFn} sweep per target subnet (or a
 * single local sweep when there are no targets), then merge the responders de-duplicated by MAC.
 *
 * Every sweep runs independently and its failure (an unreachable subnet, a router that drops the
 * directed broadcast, a socket error) is isolated via `onError` — a single bad subnet never fails the
 * whole scan. Sweeps run concurrently; results are flattened in target order so the merged output is
 * stable regardless of which subnet answers first.
 */
export async function scanEcowittGateways(
  input: ScanEcowittGatewaysInput,
): Promise<readonly DiscoveredGateway[]> {
  const { discover, targets, timeoutMs, onError } = input
  const timeoutOpt = timeoutMs !== undefined ? { timeoutMs } : {}

  if (targets.length === 0) {
    try {
      return [...(await discover({ ...timeoutOpt }))]
    } catch (error) {
      onError?.('local', error)
      return []
    }
  }

  const settled = await Promise.all(
    targets.map(async (broadcastAddr) => {
      try {
        return await discover({ broadcastAddr, ...timeoutOpt })
      } catch (error) {
        onError?.(broadcastAddr, error)
        return [] as readonly DiscoveredGateway[]
      }
    }),
  )

  const merged = new Map<string, DiscoveredGateway>()
  for (const batch of settled) {
    for (const gateway of batch) {
      const key = gatewayKey(gateway)
      if (!merged.has(key)) merged.set(key, gateway)
    }
  }
  return [...merged.values()]
}
