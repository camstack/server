/**
 * CIDR lists for the auth settings that name networks: the trusted reverse
 * proxies whose forwarding headers the hub believes, and the trusted local
 * networks a login may skip its second factor from.
 *
 * Built on `net.BlockList`, so IPv4 and IPv6 are matched by the platform, not
 * by string prefixes. A bare address is read as a single host. Anything that
 * does not parse is REPORTED back (`invalid`) so the settings form can refuse
 * it — a list that silently dropped a typo would quietly trust less than the
 * operator wrote, and one that guessed would trust more.
 */
import { BlockList, isIP } from 'node:net'

/** Strip an IPv4-mapped IPv6 prefix and a zone id, so ranges see a clean address. */
export function normalizeIp(ip: string): string {
  let out = ip.trim()
  if (out.toLowerCase().startsWith('::ffff:') && isIP(out.slice(7)) === 4) out = out.slice(7)
  const pct = out.indexOf('%')
  if (pct !== -1) out = out.slice(0, pct)
  return out
}

export interface ParsedCidr {
  readonly network: string
  readonly prefix: number
  readonly family: 'ipv4' | 'ipv6'
}

export interface ParsedCidrList {
  readonly valid: readonly ParsedCidr[]
  readonly invalid: readonly string[]
}

function parseCidr(raw: string): ParsedCidr | null {
  const text = raw.trim()
  const slash = text.indexOf('/')
  const address = normalizeIp(slash === -1 ? text : text.slice(0, slash))
  const version = isIP(address)
  if (version === 0) return null
  const max = version === 4 ? 32 : 128
  let prefix = max
  if (slash !== -1) {
    const bits = text.slice(slash + 1)
    if (!/^\d{1,3}$/.test(bits)) return null
    prefix = Number.parseInt(bits, 10)
    if (prefix > max) return null
  }
  return { network: address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' }
}

/** Parse a list of CIDR strings; blanks are skipped, unparseable entries returned. */
export function parseCidrList(entries: readonly string[]): ParsedCidrList {
  const valid: ParsedCidr[] = []
  const invalid: string[] = []
  for (const entry of entries) {
    if (entry.trim().length === 0) continue
    const parsed = parseCidr(entry)
    if (parsed === null) invalid.push(entry)
    else valid.push(parsed)
  }
  return { valid, invalid }
}

/** A stored setting as a string list — accepts a list, or one comma/space separated string. */
export function readCidrSetting(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return value.split(/[\s,]+/).filter((v) => v.length > 0)
  return []
}

export interface CidrMatcher {
  contains(ip: string): boolean
  /** How many valid ranges the matcher holds (0 = matches nothing). */
  readonly size: number
}

/** A matcher over the VALID entries of `entries`; invalid ones match nothing. */
export function createCidrMatcher(entries: readonly string[]): CidrMatcher {
  const { valid } = parseCidrList(entries)
  const list = new BlockList()
  for (const cidr of valid) list.addSubnet(cidr.network, cidr.prefix, cidr.family)
  return {
    size: valid.length,
    contains(ip: string): boolean {
      if (valid.length === 0) return false
      const address = normalizeIp(ip)
      const version = isIP(address)
      if (version === 0) return false
      return list.check(address, version === 4 ? 'ipv4' : 'ipv6')
    },
  }
}
