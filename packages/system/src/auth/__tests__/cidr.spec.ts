import { describe, expect, it } from 'vitest'
import { createCidrMatcher, normalizeIp, parseCidrList } from '../cidr.js'

describe('parseCidrList', () => {
  it('accepts IPv4 / IPv6 CIDRs and bare addresses (as /32 and /128)', () => {
    const parsed = parseCidrList(['192.168.1.0/24', '10.0.0.5', 'fd00::/8', '::1'])
    expect(parsed.invalid).toEqual([])
    expect(parsed.valid).toHaveLength(4)
  })

  it('reports — never silently widens — what it cannot read', () => {
    const parsed = parseCidrList(['192.168.1.0/33', 'not-an-ip', '0.0.0.0/0x', ' '])
    expect(parsed.valid).toEqual([])
    expect(parsed.invalid).toEqual(['192.168.1.0/33', 'not-an-ip', '0.0.0.0/0x'])
  })
})

describe('createCidrMatcher', () => {
  it('matches inside the range and nothing outside it', () => {
    const m = createCidrMatcher(['192.168.1.0/24', 'fd00::/8'])
    expect(m.contains('192.168.1.77')).toBe(true)
    expect(m.contains('192.168.2.1')).toBe(false)
    expect(m.contains('fd12::1')).toBe(true)
    expect(m.contains('2001:db8::1')).toBe(false)
  })

  it('reads an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(createCidrMatcher(['10.0.0.0/8']).contains('::ffff:10.1.2.3')).toBe(true)
  })

  it('an empty list matches nothing (the default: off)', () => {
    const m = createCidrMatcher([])
    expect(m.contains('127.0.0.1')).toBe(false)
    expect(m.size).toBe(0)
  })

  it('a garbage address is never "inside"', () => {
    expect(createCidrMatcher(['0.0.0.0/0']).contains('garbage')).toBe(false)
  })
})

describe('normalizeIp', () => {
  it('strips the IPv4-mapped prefix and a zone id', () => {
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5')
    expect(normalizeIp('fe80::1%en0')).toBe('fe80::1')
    expect(normalizeIp(' 10.0.0.1 ')).toBe('10.0.0.1')
  })
})
