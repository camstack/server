import { describe, expect, it } from 'vitest'
import {
  createAuthNetworkPolicy,
  DEFAULT_AUTH_NETWORK_POLICY,
  TRUSTED_NETWORKS_KEY,
  TRUSTED_PROXIES_KEY,
} from '../auth-network-policy.js'

function req(peer: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: peer } }
}

function policy(settings: Record<string, unknown>) {
  return createAuthNetworkPolicy((key) => settings[key])
}

describe('trusted-network second-factor skip (opt-in)', () => {
  const lan = policy({ [TRUSTED_NETWORKS_KEY]: ['192.168.1.0/24'] })

  it('is OFF by default: no list, no skip', () => {
    const address = DEFAULT_AUTH_NETWORK_POLICY.clientAddress(req('192.168.1.40'))
    expect(DEFAULT_AUTH_NETWORK_POLICY.isTrustedNetworkLogin(address)).toBe(false)
  })

  it('a direct request from the listed network may skip', () => {
    expect(lan.isTrustedNetworkLogin(lan.clientAddress(req('192.168.1.40')))).toBe(true)
  })

  it('a direct request from outside the list may not', () => {
    expect(lan.isTrustedNetworkLogin(lan.clientAddress(req('192.168.2.40')))).toBe(false)
  })

  it('SECURITY: never through the tunnel, even when the forwarded client is on the list', () => {
    const viaTunnel = lan.clientAddress(
      req('127.0.0.1', { 'cf-connecting-ip': '192.168.1.40', 'x-forwarded-for': '192.168.1.40' }),
    )
    expect(viaTunnel.ip).toBe('192.168.1.40')
    expect(lan.isTrustedNetworkLogin(viaTunnel)).toBe(false)
  })

  it('SECURITY: never through a configured LAN proxy either', () => {
    const p = policy({
      [TRUSTED_NETWORKS_KEY]: ['192.168.1.0/24'],
      [TRUSTED_PROXIES_KEY]: ['192.168.1.2'],
    })
    const address = p.clientAddress(req('192.168.1.2', { 'x-forwarded-for': '192.168.1.40' }))
    expect(p.isTrustedNetworkLogin(address)).toBe(false)
  })

  it('SECURITY: listing loopback does not open the tunnel (its peer is loopback = a proxy)', () => {
    const p = policy({ [TRUSTED_NETWORKS_KEY]: ['127.0.0.0/8', '0.0.0.0/0'] })
    expect(p.isTrustedNetworkLogin(p.clientAddress(req('127.0.0.1')))).toBe(false)
  })

  it('SECURITY: a forged X-Forwarded-For from outside does not make a LAN address', () => {
    const address = lan.clientAddress(req('203.0.113.4', { 'x-forwarded-for': '192.168.1.40' }))
    expect(lan.isTrustedNetworkLogin(address)).toBe(false)
  })

  it('a setting the store cannot answer fails closed', () => {
    const throwing = createAuthNetworkPolicy(() => {
      throw new Error('settings unavailable')
    })
    expect(throwing.isTrustedNetworkLogin(throwing.clientAddress(req('192.168.1.40')))).toBe(false)
  })

  it('accepts a comma-separated string as the stored value', () => {
    const p = policy({ [TRUSTED_NETWORKS_KEY]: '10.0.0.0/8, 192.168.1.0/24' })
    expect(p.isTrustedNetworkLogin(p.clientAddress(req('10.2.3.4')))).toBe(true)
  })
})
