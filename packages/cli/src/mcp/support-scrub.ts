/**
 * What may leave this machine inside a public issue or pull request: the
 * develop package's secret scrub, plus address masking. A private-range IPv4
 * keeps its network part (it explains a setup), any other address is dropped,
 * and a home directory loses the user name.
 */
import { redactToolArgs, scrubSecrets } from '@camstack/develop'

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Four or more colons (a clock time has two), or a compressed `::` between hex groups.
const IPV6 =
  /\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}(?![\w:])|\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6}::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?![\w:])/g
const MAC = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g
const HOME_DIR = /(\/Users|\/home)\/[^/\s'"]+/g

function octets(ip: string): number[] | null {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4) return null
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return parts
}

function maskIpv4(ip: string): string {
  const o = octets(ip)
  if (o === null) return ip
  const [a = 0, b = 0] = o
  if (a === 10) return '10.x.x.x'
  if (a === 192 && b === 168) return '192.168.x.x'
  if (a === 172 && b >= 16 && b <= 31) return `172.${b}.x.x`
  if (a === 169 && b === 254) return '169.254.x.x'
  if (a === 127) return '127.x.x.x'
  return '[ip]'
}

/** Mask addresses and home directories. Version strings (1.2.3) are not touched: they have three parts. */
export function maskAddresses(input: string): string {
  return input
    .replace(MAC, '[mac]')
    .replace(IPV4, (ip) => maskIpv4(ip))
    .replace(IPV6, '[ipv6]')
    .replace(HOME_DIR, '$1/~')
}

/** One string, ready for a public repository. */
export function scrubForPublic(input: string): string {
  return scrubSecrets(maskAddresses(input))
}

/** A structure, ready for a public repository: declared secrets, credential keys, patterns, addresses. */
export function scrubDeepForPublic(value: unknown): unknown {
  return mapStrings(redactToolArgs(value))
}

function mapStrings(value: unknown): unknown {
  if (typeof value === 'string') return scrubForPublic(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v))
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: unknown } = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v)
    return out
  }
  return value
}
