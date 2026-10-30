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

/** One library sweep of ONE directed broadcast address. */
export type GreeSweep = (broadcastAddress: string) => Promise<readonly DiscoveredDevice[]>

/**
 * Gree's scan is an encrypted UDP exchange that only its library speaks, so the
 * engine cannot run it: this addon sweeps the directed broadcast of every
 * subnet the engine covered and merges the responders by MAC. A sweep that
 * fails is reported and skipped, never fatal.
 */
export async function scanGreeSubnets(input: {
  readonly subnets: readonly string[]
  readonly sweep: GreeSweep
  readonly onError?: (broadcastAddress: string, error: unknown) => void
}): Promise<readonly DiscoveredDevice[]> {
  const targets = [
    ...new Set(
      input.subnets.map((subnet) => cidrToBroadcast(subnet)).filter((t): t is string => t !== null),
    ),
  ]
  const settled = await Promise.all(
    targets.map(async (target) => {
      try {
        return await input.sweep(target)
      } catch (error) {
        input.onError?.(target, error)
        return []
      }
    }),
  )
  const merged = new Map<string, DiscoveredDevice>()
  for (const batch of settled) {
    for (const device of batch) {
      const key = device.mac.trim().toLowerCase()
      if (!merged.has(key)) merged.set(key, device)
    }
  }
  return [...merged.values()]
}
