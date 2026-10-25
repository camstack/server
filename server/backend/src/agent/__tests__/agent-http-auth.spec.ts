import { describe, expect, it } from 'vitest'
import {
  isAuthorizedAgentRequest,
  isLoopbackAddress,
  isPairingProtocolRequest,
  isUnlockInfoRequest,
  isUnlockSessionRequest,
  readBearerToken,
} from '../agent-http-auth.js'

describe('isLoopbackAddress', () => {
  it('recognises IPv4 / IPv6 loopback incl. the IPv4-mapped form', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.1.2.3')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejects everything else, including look-alikes', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('127.evil.host')).toBe(false)
    expect(isLoopbackAddress('128.0.0.1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('readBearerToken', () => {
  it('reads a Bearer token and nothing else', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc')
    expect(readBearerToken('Bearer ')).toBeNull()
    expect(readBearerToken('abc')).toBeNull()
    expect(readBearerToken(undefined)).toBeNull()
  })
})

/**
 * Model (D857, which replaced the Bearer cluster secret):
 *   - loopback callers are always allowed;
 *   - remote callers need a session token minted from a hub unlock ticket;
 *   - a Bearer that is not a live session is worth nothing — there is no static secret to guess.
 */
describe('isAuthorizedAgentRequest', () => {
  const live = (token: string): boolean => token === 'live-session'

  it('always allows loopback', () => {
    expect(isAuthorizedAgentRequest({ remoteAddress: '127.0.0.1' })).toBe(true)
    expect(isAuthorizedAgentRequest({ remoteAddress: '::1' }, live)).toBe(true)
  })

  it('allows a remote caller only with a live session token', () => {
    expect(
      isAuthorizedAgentRequest(
        { remoteAddress: '192.168.10.50', authorization: 'Bearer live-session' },
        live,
      ),
    ).toBe(true)
    expect(
      isAuthorizedAgentRequest(
        { remoteAddress: '192.168.10.50', authorization: 'Bearer anything-else' },
        live,
      ),
    ).toBe(false)
    expect(isAuthorizedAgentRequest({ remoteAddress: '192.168.10.50' }, live)).toBe(false)
  })

  it('denies a remote caller when no session can be valid', () => {
    expect(
      isAuthorizedAgentRequest({
        remoteAddress: '192.168.10.50',
        authorization: 'Bearer live-session',
      }),
    ).toBe(false)
  })
})

describe('the network-reachable surface', () => {
  it('is the pairing protocol, and only that', () => {
    for (const [method, url] of [
      ['GET', '/api/agent/pairing/hello'],
      ['GET', '/api/agent/pairing/status?x=1'],
      ['POST', '/api/agent/pairing/offer'],
      ['POST', '/api/agent/pairing/reveal'],
      ['POST', '/api/agent/pairing/confirm'],
      ['POST', '/api/agent/pairing/reject'],
      ['POST', '/api/agent/pairing/complete'],
    ] as const) {
      expect(isPairingProtocolRequest(method, url), `${method} ${url}`).toBe(true)
    }
    for (const [method, url] of [
      ['POST', '/api/agent/pairing/forget'],
      ['GET', '/api/agent/status'],
      ['GET', '/api/agent/config'],
      ['POST', '/api/agent/config'],
      ['POST', '/api/agent/restart'],
      ['GET', '/api/agent/processes'],
      ['GET', '/api/agent/hubs-found'],
      ['POST', '/api/agent/server-update/apply'],
      ['GET', '/api/agent/pairing/offer'],
    ] as const) {
      expect(isPairingProtocolRequest(method, url), `${method} ${url}`).toBe(false)
    }
  })

  it('exposes the unlock redeem and the unlock probe, nothing more', () => {
    expect(isUnlockSessionRequest('POST', '/api/agent/session')).toBe(true)
    expect(isUnlockSessionRequest('GET', '/api/agent/session')).toBe(false)
    expect(isUnlockInfoRequest('GET', '/api/agent/unlock-info')).toBe(true)
    expect(isUnlockInfoRequest('POST', '/api/agent/unlock-info')).toBe(false)
  })
})
