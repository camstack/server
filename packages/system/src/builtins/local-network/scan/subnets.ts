/**
 * Subnet arithmetic for the LAN scan engine: CIDR parsing, the host cap and
 * the union of the hub's own links, the saved list and a per-call list.
 *
 * Pure — no sockets, no clock — so the limits are unit-testable.
 */
import type { LocalInterface } from '@camstack/types'

/** Total hosts one scan may visit across every subnet. */
export const MAX_SCAN_HOSTS = 4096
/** The widest extra subnet one entry may name: a /22 is 1022 hosts. */
export const MIN_SCAN_PREFIX = 22
/** The hub's own links are scanned as /24 at most, whatever their real mask. */
export const OWN_LINK_PREFIX = 24

/** A refused subnet input: the operator typed something the engine will not sweep. */
export class ScanSubnetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScanSubnetError'
  }
}

export interface Subnet {
  /** Canonical `a.b.c.d/p` (network address, not the typed host). */
  readonly cidr: string
  /** Network address as an unsigned 32-bit number. */
  readonly base: number
  readonly prefix: number
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function ipv4ToInt(address: string): number | null {
  const m = IPV4.exec(address.trim())
  if (m === null) return null
  let out = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255) return null
    out = out * 256 + octet
  }
  return out
}

export function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
}

/** Parse `a.b.c.d/p`. A bare address is a /32. Throws {@link ScanSubnetError}. */
export function parseCidr(input: string): Subnet {
  const text = input.trim()
  const [addr, rest, ...extra] = text.split('/')
  if (extra.length > 0 || addr === undefined) throw new ScanSubnetError(`Invalid CIDR "${input}"`)
  const ip = ipv4ToInt(addr)
  if (ip === null) throw new ScanSubnetError(`Invalid CIDR "${input}": not an IPv4 address`)
  const prefix = rest === undefined ? 32 : /^\d{1,2}$/.test(rest) ? Number(rest) : -1
  if (prefix < 0 || prefix > 32) throw new ScanSubnetError(`Invalid CIDR "${input}": bad prefix`)
  if (prefix < MIN_SCAN_PREFIX) {
    throw new ScanSubnetError(`CIDR "${input}" is wider than /${MIN_SCAN_PREFIX}`)
  }
  const base = (ip & prefixMask(prefix)) >>> 0
  return { cidr: `${intToIpv4(base)}/${prefix}`, base, prefix }
}

/** Host addresses of a subnet, network and broadcast excluded (a /32 is its own host). */
export function hostsOf(subnet: Subnet): readonly string[] {
  if (subnet.prefix === 32) return [intToIpv4(subnet.base)]
  const size = 2 ** (32 - subnet.prefix)
  if (subnet.prefix === 31) return [intToIpv4(subnet.base), intToIpv4(subnet.base + 1)]
  const out: string[] = []
  for (let i = 1; i < size - 1; i++) out.push(intToIpv4(subnet.base + i))
  return out
}

/** The directed-broadcast address of a subnet. */
export function broadcastOf(subnet: Subnet): string {
  return intToIpv4(subnet.base + 2 ** (32 - subnet.prefix) - 1)
}

export function containsAddress(subnet: Subnet, address: string): boolean {
  const ip = ipv4ToInt(address)
  return ip !== null && (ip & prefixMask(subnet.prefix)) >>> 0 === subnet.base
}

function prefixOfNetmask(netmask: string): number {
  const mask = ipv4ToInt(netmask)
  if (mask === null) return OWN_LINK_PREFIX
  let bits = 0
  for (let bit = 31; bit >= 0 && ((mask >>> bit) & 1) === 1; bit--) bits++
  return bits
}

/** A link the hub sits on and can scan: IPv4, not loopback / link-local, LAN or Wi-Fi. */
export function isScannableLink(iface: LocalInterface): boolean {
  if (iface.family !== 'IPv4' || iface.internal) return false
  if (iface.address.startsWith('169.254.')) return false
  return iface.kind === 'lan' || iface.kind === 'wifi'
}

/** The hub's own /24 (or narrower) per scannable link. */
export function ownLinkSubnets(interfaces: readonly LocalInterface[]): readonly Subnet[] {
  const out = new Map<string, Subnet>()
  for (const iface of interfaces) {
    if (!isScannableLink(iface)) continue
    const prefix = Math.max(prefixOfNetmask(iface.netmask), OWN_LINK_PREFIX)
    const ip = ipv4ToInt(iface.address)
    if (ip === null) continue
    const base = (ip & prefixMask(prefix)) >>> 0
    const subnet: Subnet = { cidr: `${intToIpv4(base)}/${prefix}`, base, prefix }
    out.set(subnet.cidr, subnet)
  }
  return [...out.values()]
}

export interface ResolvedSubnets {
  /** Every subnet to cover, deduplicated, the hub's own first. */
  readonly all: readonly Subnet[]
  /** The subnets that are NOT one of the hub's own links: multicast does not reach them. */
  readonly extra: readonly Subnet[]
  /** Unique host addresses across `all`, the hub's own addresses removed. */
  readonly hosts: readonly string[]
}

export interface ResolveSubnetsInput {
  readonly interfaces: readonly LocalInterface[]
  readonly saved: readonly string[]
  readonly perCall: readonly string[]
}

/**
 * hub /24s ∪ saved ∪ per-call. An invalid CIDR, or a union above
 * {@link MAX_SCAN_HOSTS} hosts, throws {@link ScanSubnetError}.
 */
export function resolveScanSubnets(input: ResolveSubnetsInput): ResolvedSubnets {
  const own = ownLinkSubnets(input.interfaces)
  const ownCidrs = new Set(own.map((s) => s.cidr))
  const extraParsed = [...input.saved, ...input.perCall].map(parseCidr)
  const all = new Map<string, Subnet>()
  for (const s of own) all.set(s.cidr, s)
  const extra = new Map<string, Subnet>()
  for (const s of extraParsed) {
    if (!all.has(s.cidr)) all.set(s.cidr, s)
    if (!ownCidrs.has(s.cidr)) extra.set(s.cidr, s)
  }
  const ownAddresses = new Set(input.interfaces.map((i) => i.address))
  const hosts = new Set<string>()
  for (const s of all.values()) {
    for (const h of hostsOf(s)) if (!ownAddresses.has(h)) hosts.add(h)
    if (hosts.size > MAX_SCAN_HOSTS) {
      throw new ScanSubnetError(
        `The subnets cover more than ${MAX_SCAN_HOSTS} hosts; remove or narrow one`,
      )
    }
  }
  return { all: [...all.values()], extra: [...extra.values()], hosts: [...hosts] }
}

/** Validate a list to be saved: same rules as a scan, returned canonical and deduplicated. */
export function validateSavedSubnets(list: readonly string[]): readonly string[] {
  const parsed = list.map(parseCidr)
  const cidrs = [...new Set(parsed.map((s) => s.cidr))]
  resolveScanSubnets({ interfaces: [], saved: cidrs, perCall: [] })
  return cidrs
}
