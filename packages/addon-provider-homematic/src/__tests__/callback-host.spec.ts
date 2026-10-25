import { describe, it, expect } from 'vitest'
import { pickCallbackHost } from '../callback-host.js'

const addrs = [
  { family: 'IPv4', address: '127.0.0.1', internal: true },
  { family: 'IPv6', address: 'fe80::1', internal: false },
  { family: 'IPv4', address: '10.0.0.5', internal: false },
  { family: 'IPv4', address: '192.168.10.10', internal: false },
]

describe('pickCallbackHost', () => {
  it('prefers the IPv4 on the CCU subnet', () => {
    expect(pickCallbackHost('192.168.10.198', addrs)).toBe('192.168.10.10')
  })

  it('falls back to the first non-internal IPv4 when no subnet match', () => {
    expect(pickCallbackHost('172.16.0.9', addrs)).toBe('10.0.0.5')
  })

  it('ignores loopback + IPv6', () => {
    expect(
      pickCallbackHost('192.168.10.198', [
        { family: 'IPv4', address: '127.0.0.1', internal: true },
        { family: 'IPv6', address: '::1', internal: false },
      ]),
    ).toBeNull()
  })

  it('handles the node "4"/"6" numeric family too', () => {
    expect(
      pickCallbackHost('192.168.10.198', [
        { family: '4', address: '192.168.10.22', internal: false },
      ]),
    ).toBe('192.168.10.22')
  })
})
