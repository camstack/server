import type { DiscoveredDevice } from '@apocaliss92/nodegree'
import type { DiscoveryMode } from '@camstack/types'

/** The scan is an AES-encrypted JSON exchange only the nodegree library speaks (its keys and framing are not exported). */
export const GREE_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  {
    kind: 'custom',
    reason:
      'Gree answers a {"t":"scan"} UDP datagram with an AES-encrypted pack that only the nodegree library can decode; this addon sweeps each covered subnet through it',
  },
]

/** Dotted-quad IPv4 into its four octets, or null when malformed. */
function parseIpv4(value: string): readonly [number, number, number, number] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    octets.push(n)
  }
  const [a, b, c, d] = octets
  return a === undefined || b === undefined || c === undefined || d === undefined
    ? null
    : [a, b, c, d]
}

/** The directed broadcast address of an IPv4 CIDR; null for anything that is not one. */
export function cidrToBroadcast(cidr: string): string | null {
  const slash = cidr.indexOf('/')
  if (slash < 0) return null
  const ip = parseIpv4(cidr.slice(0, slash))
  const prefixToken = cidr.slice(slash + 1)
  if (ip === null || !/^\d{1,2}$/.test(prefixToken)) return null
  const prefix = Number(prefixToken)
  if (prefix > 32) return null
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

/** An IPv4 address as an unsigned 32-bit integer. */
function ipv4ToInt(ip: readonly [number, number, number, number]): number {
  return ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  )
}

/** The inclusive address range of an IPv4 CIDR, or null when it is not one. */
function cidrRange(cidr: string): {
  readonly first: number
  readonly last: number
  readonly prefix: number
} | null {
  const slash = cidr.indexOf('/')
  if (slash < 0) return null
  const ip = parseIpv4(cidr.slice(0, slash))
  const prefixToken = cidr.slice(slash + 1)
  if (ip === null || !/^\d{1,2}$/.test(prefixToken)) return null
  const prefix = Number(prefixToken)
  if (prefix > 32) return null
  const hostMask = prefix === 0 ? 0xffffffff : (0xffffffff >>> prefix) >>> 0
  const base = ipv4ToInt(ip)
  return {
    first: (base & ~hostMask) >>> 0,
    last: (base | hostMask) >>> 0,
    prefix,
  }
}

/** Largest subnet the addon unicasts across: a /24 (254 hosts). A bigger one is refused. */
export const GREE_UNICAST_MAX_HOSTS = 254
/** Unicast probes in flight at once. */
export const GREE_UNICAST_CONCURRENCY = 32

/** A configured subnet the sweep will not probe, with the reason to log. */
export interface GreeRefusedSubnet {
  readonly subnet: string
  readonly reason: string
}

/** True for a `/24` IPv4 CIDR (`192.168.20.0/24`): the only shape the operator may list as an extra sweep subnet. */
export function isGreeSweepCidr(value: string): boolean {
  return value.endsWith('/24') && cidrRange(value) !== null
}

/** What one sweep sends: directed broadcasts everywhere, plus a unicast per host of each routed subnet. */
export interface GreeSweepPlan {
  readonly broadcasts: readonly string[]
  readonly unicast: readonly string[]
  readonly refused: readonly GreeRefusedSubnet[]
}

/**
 * Plan a sweep. A directed broadcast is always sent. A subnet this node is NOT
 * attached to (no local address inside it) is routed: routers drop directed
 * broadcasts, so every host of it is also probed by unicast. `extraSubnets` are the
 * operator-listed subnets of the integration: swept like any other, and a value that
 * is not a /24 CIDR is refused. Pure.
 */
export function planGreeSweep(input: {
  readonly subnets: readonly string[]
  readonly extraSubnets?: readonly string[]
  readonly localAddresses: readonly string[]
}): GreeSweepPlan {
  const locals = new Set<number>()
  for (const address of input.localAddresses) {
    const parsed = parseIpv4(address)
    if (parsed !== null) locals.add(ipv4ToInt(parsed))
  }
  const broadcasts = new Set<string>()
  const unicast = new Set<string>()
  const refused: GreeRefusedSubnet[] = []
  const extra = new Set(input.extraSubnets ?? [])
  for (const subnet of extra) {
    if (!isGreeSweepCidr(subnet)) refused.push({ subnet, reason: 'not a /24 IPv4 CIDR' })
  }
  const wanted = new Set([...input.subnets, ...[...extra].filter(isGreeSweepCidr)])
  for (const subnet of wanted) {
    const range = cidrRange(subnet)
    const broadcast = cidrToBroadcast(subnet)
    if (range === null || broadcast === null) {
      refused.push({ subnet, reason: 'not an IPv4 CIDR' })
      continue
    }
    broadcasts.add(broadcast)
    const onLink = [...locals].some((l) => l >= range.first && l <= range.last)
    if (onLink) continue
    const firstHost = range.prefix >= 31 ? range.first : range.first + 1
    const lastHost = range.prefix >= 31 ? range.last : range.last - 1
    if (lastHost - firstHost + 1 > GREE_UNICAST_MAX_HOSTS) {
      refused.push({
        subnet,
        reason: `routed subnet larger than a /24 (${GREE_UNICAST_MAX_HOSTS} hosts) — broadcast only`,
      })
      continue
    }
    for (let host = firstHost; host <= lastHost; host += 1) unicast.add(intToIpv4(host))
  }
  return { broadcasts: [...broadcasts], unicast: [...unicast], refused }
}

/** One library sweep of ONE address (a directed broadcast, or a single host for a unicast probe). */
export type GreeSweep = (broadcastAddress: string) => Promise<readonly DiscoveredDevice[]>

/** Run `task` over `items` with at most `limit` in flight. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item !== undefined) out[index] = await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Gree's scan is an encrypted UDP exchange that only its library speaks, so the
 * engine cannot run it: this addon sweeps the directed broadcast of every
 * subnet the engine covered and merges the responders by MAC. When
 * `localAddresses` is given, a subnet this node is not attached to is also
 * unicast host by host (`sweep` aimed at one IP), bounded. A sweep that fails
 * is reported and skipped, never fatal.
 */
export async function scanGreeSubnets(input: {
  readonly subnets: readonly string[]
  /** Operator-listed extra subnets (the integration's setting). */
  readonly extraSubnets?: readonly string[]
  readonly sweep: GreeSweep
  /** This node's own IPv4 addresses; omitted = no unicast probing. */
  readonly localAddresses?: readonly string[]
  readonly onError?: (broadcastAddress: string, error: unknown) => void
  readonly onRefused?: (refused: GreeRefusedSubnet) => void
}): Promise<readonly DiscoveredDevice[]> {
  const plan = planGreeSweep({
    subnets: input.subnets,
    ...(input.extraSubnets !== undefined ? { extraSubnets: input.extraSubnets } : {}),
    localAddresses: input.localAddresses ?? [],
  })
  for (const refused of plan.refused) input.onRefused?.(refused)
  const probe = async (target: string): Promise<readonly DiscoveredDevice[]> => {
    try {
      return await input.sweep(target)
    } catch (error) {
      input.onError?.(target, error)
      return []
    }
  }
  const unicast = input.localAddresses === undefined ? [] : plan.unicast
  const [broadcastBatches, unicastBatches] = await Promise.all([
    Promise.all(plan.broadcasts.map(probe)),
    mapBounded(unicast, GREE_UNICAST_CONCURRENCY, probe),
  ])
  const merged = new Map<string, DiscoveredDevice>()
  for (const batch of [...broadcastBatches, ...unicastBatches]) {
    for (const device of batch) {
      const key = device.mac.trim().toLowerCase()
      if (!merged.has(key)) merged.set(key, device)
    }
  }
  return [...merged.values()]
}
