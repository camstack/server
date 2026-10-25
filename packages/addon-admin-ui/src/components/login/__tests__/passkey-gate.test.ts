import { describe, it, expect } from 'vitest'
import { isIpLiteral, passkeyUsableOnOrigin } from '../passkey-gate'

describe('isIpLiteral', () => {
  it('flags an IPv4 dotted-quad', () => {
    expect(isIpLiteral('192.0.2.10')).toBe(true)
  })

  it('flags a bracketed IPv6 literal', () => {
    expect(isIpLiteral('[::1]')).toBe(true)
  })

  it('flags a bare IPv6 literal', () => {
    expect(isIpLiteral('::1')).toBe(true)
  })

  it('flags a bare non-loopback IPv6 literal', () => {
    expect(isIpLiteral('fdda:abcd::1')).toBe(true)
  })

  it('does NOT flag localhost as an IP literal', () => {
    expect(isIpLiteral('localhost')).toBe(false)
  })

  it('does NOT flag a normal domain', () => {
    expect(isIpLiteral('example.com')).toBe(false)
  })

  it('does NOT flag a subdomain', () => {
    expect(isIpLiteral('hub.example.com')).toBe(false)
  })
})

describe('passkeyUsableOnOrigin', () => {
  it('rejects an IPv4 origin even when rpId matches numerically', () => {
    expect(passkeyUsableOnOrigin('192.0.2.10', '192.0.2.10')).toBe(false)
  })

  it('rejects a bracketed IPv6 origin', () => {
    expect(passkeyUsableOnOrigin('[::1]', 'example.com')).toBe(false)
  })

  it('rejects a bare IPv6 origin', () => {
    expect(passkeyUsableOnOrigin('fdda:abcd::1', 'example.com')).toBe(false)
  })

  it('allows localhost only when rpId is exactly localhost', () => {
    expect(passkeyUsableOnOrigin('localhost', 'localhost')).toBe(true)
  })

  it('rejects localhost when rpId is a real domain', () => {
    expect(passkeyUsableOnOrigin('localhost', 'example.com')).toBe(false)
  })

  it('allows an exact rpId match', () => {
    expect(passkeyUsableOnOrigin('example.com', 'example.com')).toBe(true)
  })

  it('allows a subdomain of rpId', () => {
    expect(passkeyUsableOnOrigin('hub.example.com', 'example.com')).toBe(true)
  })

  it('rejects a mismatched domain', () => {
    expect(passkeyUsableOnOrigin('evil.com', 'example.com')).toBe(false)
  })

  it('rejects a domain that merely ends with rpId as a substring (not a subdomain)', () => {
    expect(passkeyUsableOnOrigin('notexample.com', 'example.com')).toBe(false)
  })

  it('rejects when rpId is empty', () => {
    expect(passkeyUsableOnOrigin('example.com', '')).toBe(false)
  })

  it('rejects when both hostname and rpId are empty', () => {
    expect(passkeyUsableOnOrigin('', '')).toBe(false)
  })
})
