import { describe, expect, it } from 'vitest'
import { resolveClientAddress } from '../client-address.js'

/**
 * Behind the Cloudflare tunnel every request reached the hub from loopback, so
 * every limiter keyed on `127.0.0.1` and one bucket served the whole internet.
 * The real client comes from the forwarding headers — but ONLY when the hop
 * that sent them is a proxy the hub trusts. A header from anyone else is a
 * claim, not an address.
 */

function req(peer: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: peer } }
}

const NO_EXTRA_PROXIES = { trustedProxies: [] as string[] }

describe('resolveClientAddress', () => {
  it('a direct LAN request is its socket peer, not via a proxy', () => {
    expect(resolveClientAddress(req('192.168.1.40'), NO_EXTRA_PROXIES)).toEqual({
      ip: '192.168.1.40',
      peer: '192.168.1.40',
      viaProxy: false,
    })
  })

  it('the tunnel connector on loopback: CF-Connecting-IP is the client', () => {
    const address = resolveClientAddress(
      req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }),
      NO_EXTRA_PROXIES,
    )
    expect(address).toEqual({ ip: '203.0.113.9', peer: '127.0.0.1', viaProxy: true })
  })

  it('SECURITY: a forged X-Forwarded-For from a non-trusted peer is ignored', () => {
    const address = resolveClientAddress(
      req('198.51.100.7', { 'x-forwarded-for': '192.168.1.10', 'cf-connecting-ip': '10.0.0.1' }),
      NO_EXTRA_PROXIES,
    )
    expect(address.ip).toBe('198.51.100.7')
    expect(address.viaProxy).toBe(false)
  })

  it('SECURITY: a LAN host cannot claim another address either — LAN is not a proxy', () => {
    const address = resolveClientAddress(
      req('192.168.1.66', { 'x-forwarded-for': '192.168.1.10' }),
      NO_EXTRA_PROXIES,
    )
    expect(address.ip).toBe('192.168.1.66')
  })

  it('X-Forwarded-For through a trusted proxy: the right-most UNTRUSTED hop is the client', () => {
    // client 203.0.113.5 → (spoofs a first entry) → proxy 192.168.1.2 → hub.
    const address = resolveClientAddress(
      req('192.168.1.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.5' }),
      { trustedProxies: ['192.168.1.2'] },
    )
    expect(address.ip).toBe('203.0.113.5')
    expect(address.viaProxy).toBe(true)
  })

  it('a chain of trusted proxies is walked through', () => {
    const address = resolveClientAddress(
      req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5, 192.168.1.2' }),
      { trustedProxies: ['192.168.1.0/24'] },
    )
    expect(address.ip).toBe('203.0.113.5')
  })

  it('a trusted peer with no forwarding header is itself the client (and still via a proxy)', () => {
    const address = resolveClientAddress(req('::ffff:127.0.0.1'), NO_EXTRA_PROXIES)
    expect(address).toEqual({ ip: '127.0.0.1', peer: '127.0.0.1', viaProxy: true })
  })

  it('a garbage header value from a trusted peer falls back to the next signal', () => {
    const address = resolveClientAddress(
      req('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'junk, 203.0.113.8' }),
      NO_EXTRA_PROXIES,
    )
    expect(address.ip).toBe('203.0.113.8')
  })

  it('no socket (a mesh call) has no address', () => {
    expect(resolveClientAddress({ headers: {} }, NO_EXTRA_PROXIES)).toEqual({
      ip: null,
      peer: null,
      viaProxy: false,
    })
  })
})
