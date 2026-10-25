import { isIP } from 'node:net'

export type ParseLocalHostnameResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: string }

const DNS_NAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/

/**
 * Parse the operator-typed local hostname.
 *
 * Empty / whitespace → `null` (advertise the raw LAN IP). A DNS name is
 * lowercased. A URL, port suffix, path, or bare IP is rejected so it cannot
 * leak into a SAN or a candidate URL.
 */
export function parseLocalHostname(raw: string): ParseLocalHostnameResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (/[\s/:?#]/.test(trimmed) || trimmed.includes('\\')) {
    return { ok: false, error: 'Enter a DNS name such as camstack.lan, without a scheme or port.' }
  }
  const lowered = trimmed.toLowerCase()
  if (isIP(lowered) !== 0) {
    return { ok: false, error: 'Use the address allowlist for IPs — this field is a DNS name.' }
  }
  if (!DNS_NAME.test(lowered)) {
    return { ok: false, error: 'Enter a DNS name such as camstack.lan, without a scheme or port.' }
  }
  return { ok: true, value: lowered }
}
