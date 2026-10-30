/**
 * Client-side CIDR check for the scan subnet editor. The server validates
 * again (max /22 per entry, 4096 hosts in total); this only catches typos
 * before the round trip.
 */
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

export type SubnetCheck =
  | { readonly ok: true; readonly cidr: string }
  | { readonly ok: false; readonly reason: 'format' | 'prefix' }

/** Smallest prefix the server accepts for one entry (a /22 is 1024 addresses). */
export const MIN_SCAN_PREFIX = 22

export function checkSubnet(raw: string): SubnetCheck {
  const match = IPV4_CIDR.exec(raw.trim())
  if (match === null) return { ok: false, reason: 'format' }
  const octets = [match[1], match[2], match[3], match[4]].map((o) => Number(o))
  if (octets.some((o) => o > 255)) return { ok: false, reason: 'format' }
  const prefix = Number(match[5])
  if (prefix > 32) return { ok: false, reason: 'format' }
  if (prefix < MIN_SCAN_PREFIX) return { ok: false, reason: 'prefix' }
  return { ok: true, cidr: `${octets.join('.')}/${prefix}` }
}
