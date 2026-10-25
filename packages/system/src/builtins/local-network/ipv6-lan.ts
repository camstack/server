/**
 * IPv6 helpers for LAN advertisement: prefix matching (privacy addresses
 * rotate inside a /64), Linux `/proc/net/if_inet6` flags, and the gate
 * that keeps temporary GUA off the connection candidate list.
 */

const IFA_F_TEMPORARY = 0x01
const IFA_F_DEPRECATED = 0x20
const IFA_F_TENTATIVE = 0x40

/** First 64 bits, canonical hex groups, or null if the address is not IPv6. */
export function ipv6Prefix64Key(address: string): string | null {
  const groups = parseIpv6Groups(address)
  if (groups === null) return null
  return groups
    .slice(0, 4)
    .map((g) => g.toString(16).padStart(4, '0'))
    .join(':')
}

/** 32-char lowercase hex (same encoding as `/proc/net/if_inet6`). */
export function ipv6ToHex32(address: string): string | null {
  const groups = parseIpv6Groups(address)
  if (groups === null) return null
  return groups.map((g) => g.toString(16).padStart(4, '0')).join('')
}

/**
 * Parse Linux `if_inet6` into hex32 → flags. Unknown / malformed lines
 * are skipped. Keys match {@link ipv6ToHex32}.
 */
export function parseProcIfInet6(text: string): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(/\s+/)
    const hex = parts[0]?.toLowerCase()
    const flagsRaw = parts[4]
    if (!hex || hex.length !== 32 || flagsRaw === undefined) continue
    const flags = Number.parseInt(flagsRaw, 16)
    if (!Number.isFinite(flags)) continue
    out.set(hex, flags)
  }
  return out
}

/**
 * Whether this IPv6 should be auto-seeded / advertised.
 * `flags === undefined` means the platform did not tell us (macOS, tests
 * without a proc snapshot) — keep every non-link-local plausible address.
 *
 * On Linux, drop addresses marked TEMPORARY / DEPRECATED / TENTATIVE, and
 * `flags === 0` which is how this kernel reports RFC 4941 privacy temps
 * (the stable GUA is PERMANENT|NODAD). Do **not** require PERMANENT —
 * stateful DHCPv6 GUA often has only NODAD (0x02).
 */
export function shouldAdvertiseIpv6(address: string, flags: number | undefined): boolean {
  const a = address.toLowerCase().split('%')[0] ?? address
  if (a === '::' || a === '::1') return false
  if (a.startsWith('fe80:')) return false
  if (a.startsWith('ff')) return false
  if (flags === undefined) return true
  if ((flags & IFA_F_TEMPORARY) !== 0) return false
  if ((flags & IFA_F_DEPRECATED) !== 0) return false
  if ((flags & IFA_F_TENTATIVE) !== 0) return false
  if (flags === 0) return false
  return true
}

export function ipv6AllowlistMatches(address: string, allowed: readonly string[]): boolean {
  if (allowed.includes(address)) return true
  const key = ipv6Prefix64Key(address)
  if (key === null) return false
  for (const entry of allowed) {
    if (!entry.includes(':')) continue
    if (ipv6Prefix64Key(entry) === key) return true
  }
  return false
}

function parseIpv6Groups(address: string): number[] | null {
  const raw = address.toLowerCase().split('%')[0]
  if (!raw || raw.includes('.')) return null
  const sides = raw.split('::')
  if (sides.length > 2) return null
  const parsePart = (part: string | undefined): number[] | null => {
    if (part === undefined || part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (g === '') return null
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }
  if (sides.length === 1) {
    const groups = parsePart(sides[0])
    if (groups === null || groups.length !== 8) return null
    return groups
  }
  const left = parsePart(sides[0])
  const right = parsePart(sides[1])
  if (left === null || right === null) return null
  const fill = 8 - left.length - right.length
  if (fill < 0) return null
  return [...left, ...Array<number>(fill).fill(0), ...right]
}
