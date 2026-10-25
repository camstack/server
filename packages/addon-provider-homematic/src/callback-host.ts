import { networkInterfaces } from 'node:os'

/** A network interface address, narrowed to what we need (testable without os). */
export interface NetAddr {
  readonly family: string
  readonly address: string
  readonly internal: boolean
}

/**
 * Pick the hub LAN IPv4 a CCU at `ccuHost` can call back to. Prefers an
 * address on the same /24 as the CCU; otherwise the first non-internal IPv4.
 * Returns null when nothing suitable is found. Pure over the supplied addrs.
 */
export function pickCallbackHost(ccuHost: string, addrs: readonly NetAddr[]): string | null {
  const ipv4 = addrs.filter((a) => (a.family === 'IPv4' || a.family === '4') && !a.internal)
  const first = ipv4[0]
  if (first === undefined) return null
  const prefix = ccuHost.split('.').slice(0, 3).join('.') // '192.168.1'
  const sameSubnet =
    prefix.split('.').length === 3
      ? ipv4.find((a) => a.address.startsWith(prefix + '.'))
      : undefined
  return (sameSubnet ?? first).address
}

/** Resolve the hub callback host from the live OS interfaces. */
export function inferCallbackHost(ccuHost: string): string | null {
  const addrs: NetAddr[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      addrs.push({ family: String(a.family), address: a.address, internal: a.internal })
    }
  }
  return pickCallbackHost(ccuHost, addrs)
}
