/**
 * Unit tests for `getTailscaleHostAddresses` — the broker's dynamic
 * Tailscale-overlay-address detector.
 *
 * The broker feeds the detected address(es) into werift's
 * `iceAdditionalHostAddresses` so a remote Tailscale viewer can pair a
 * DIRECT host↔host candidate (native H.264, no relay, no re-encode)
 * instead of falling onto the broken relay path. The detection must:
 *   - pick IPv4 in 100.64.0.0/10 (CGNAT) off any interface, including a
 *     point-to-point `utun` that werift's own gathering skips,
 *   - pick IPv6 in fd7a::/16 (ULA), stripping any zone id,
 *   - ignore loopback/internal + ordinary LAN/public addresses,
 *   - never hardcode the address (it follows the host's actual mesh IP).
 */
import { describe, it, expect } from 'vitest'
import { getTailscaleHostAddresses, type NetworkInterfaceMap } from '../webrtc/session.js'

describe('getTailscaleHostAddresses', () => {
  it('returns the 100.64/10 address from a utun (Tailscale) interface', () => {
    const ifaces: NetworkInterfaceMap = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.10.193', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.104.179.3', family: 'IPv4', internal: false }],
    }
    expect(getTailscaleHostAddresses(ifaces)).toEqual(['100.104.179.3'])
  })

  it('returns the fd7a::/16 ULA address and strips its zone id', () => {
    const ifaces: NetworkInterfaceMap = {
      utun4: [{ address: 'fd7a:115c:a1e0::53%utun4', family: 'IPv6', internal: false }],
    }
    expect(getTailscaleHostAddresses(ifaces)).toEqual(['fd7a:115c:a1e0::53'])
  })

  it('accepts numeric family codes (4 / 6)', () => {
    const ifaces: NetworkInterfaceMap = {
      utun4: [
        { address: '100.64.0.1', family: 4, internal: false },
        { address: 'fd7a::1', family: 6, internal: false },
      ],
    }
    const result = getTailscaleHostAddresses(ifaces)
    expect(result).toContain('100.64.0.1')
    expect(result).toContain('fd7a::1')
    expect(result).toHaveLength(2)
  })

  it('ignores loopback, ordinary LAN and public addresses', () => {
    const ifaces: NetworkInterfaceMap = {
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true },
      ],
      en0: [
        { address: '192.168.10.193', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      eth0: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
      // 100.63 is just below the 100.64/10 block — NOT Tailscale.
      ppp0: [{ address: '100.63.255.255', family: 'IPv4', internal: false }],
      // 100.128 is just above the block — NOT Tailscale.
      ppp1: [{ address: '100.128.0.1', family: 'IPv4', internal: false }],
    }
    expect(getTailscaleHostAddresses(ifaces)).toEqual([])
  })

  it('de-dupes when the same address appears twice', () => {
    const ifaces: NetworkInterfaceMap = {
      utun4: [{ address: '100.100.100.100', family: 'IPv4', internal: false }],
      utun5: [{ address: '100.100.100.100', family: 'IPv4', internal: false }],
    }
    expect(getTailscaleHostAddresses(ifaces)).toEqual(['100.100.100.100'])
  })

  it('skips an undefined interface entry', () => {
    const ifaces: NetworkInterfaceMap = {
      missing: undefined,
      utun4: [{ address: '100.64.10.20', family: 'IPv4', internal: false }],
    }
    expect(getTailscaleHostAddresses(ifaces)).toEqual(['100.64.10.20'])
  })
})
