/**
 * Local hostname the operator types on Network → Local access.
 *
 * Empty means "advertise the raw LAN IP". Anything else must be a DNS name
 * the SDK can put in a URL and the cert-manager can put in a SAN — not an
 * IP (those already come from the interface list) and not a URL.
 */
import { describe, expect, it } from 'vitest'
import { parseLocalHostname } from '../local-hostname.js'

describe('parseLocalHostname', () => {
  it('treats empty and whitespace as no name', () => {
    expect(parseLocalHostname('')).toEqual({ ok: true, value: null })
    expect(parseLocalHostname('   ')).toEqual({ ok: true, value: null })
  })

  it('accepts a lowercased DNS name', () => {
    expect(parseLocalHostname('camstack.lan')).toEqual({ ok: true, value: 'camstack.lan' })
    expect(parseLocalHostname('Hub.HOME')).toEqual({ ok: true, value: 'hub.home' })
    expect(parseLocalHostname('nvr.local')).toEqual({ ok: true, value: 'nvr.local' })
  })

  it('rejects a URL, a port suffix, and a path', () => {
    expect(parseLocalHostname('http://camstack.lan').ok).toBe(false)
    expect(parseLocalHostname('hub:4480').ok).toBe(false)
    expect(parseLocalHostname('camstack.lan/path').ok).toBe(false)
  })

  it('rejects a bare IPv4 or IPv6', () => {
    expect(parseLocalHostname('192.168.10.9').ok).toBe(false)
    expect(parseLocalHostname('::1').ok).toBe(false)
  })
})
