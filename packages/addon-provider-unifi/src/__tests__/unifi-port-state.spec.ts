import { NetworkLinkStatusSchema } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { portNetworkLinkStatus } from '../unifi-port-state.js'
import { port } from './unifi-fixtures.js'

describe('portNetworkLinkStatus — a PoE port as an Ethernet link', () => {
  it('an up gigabit port reports linkUp and its speed in kbps (Mbps × 1000)', () => {
    const slice = portNetworkLinkStatus(port({ idx: 1, linkUp: true, speedMbps: 1000 }), 5)
    expect(slice).toEqual({
      type: 'ethernet',
      signal: null,
      linkUp: true,
      speedKbps: 1_000_000,
      lastUpdated: 5,
    })
    expect(NetworkLinkStatusSchema.parse(slice)).toEqual(slice)
  })

  it('a down port is linkUp false with no speed', () => {
    const slice = portNetworkLinkStatus(port({ idx: 2, linkUp: false, speedMbps: null }), 5)
    expect(slice.linkUp).toBe(false)
    expect(slice.speedKbps).toBeNull()
  })

  it('a port the controller did not describe is unknown (null), never down or 0', () => {
    const slice = portNetworkLinkStatus(port({ idx: 3 }), 5)
    expect(slice.linkUp).toBeNull()
    expect(slice.speedKbps).toBeNull()
  })
})
