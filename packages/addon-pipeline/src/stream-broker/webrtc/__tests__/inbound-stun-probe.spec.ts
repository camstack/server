import { describe, expect, it, vi } from 'vitest'
import { InboundStunProbe } from '../inbound-stun-probe.js'

describe('InboundStunProbe', () => {
  it('reports no requests when the peer never sends a check', () => {
    const probe = new InboundStunProbe(vi.fn())
    expect(probe.summary()).toEqual({
      requests: 0,
      firstFrom: null,
      firstAfterMs: null,
      sources: [],
    })
  })

  it('counts requests, names the first source once, and never vetoes a request', () => {
    let t = 1_000
    const onFirst = vi.fn()
    const probe = new InboundStunProbe(onFirst, () => t)
    t = 1_250
    expect(probe.filter({}, ['3.250.60.234', 5000], {})).toBe(true)
    t = 1_400
    expect(probe.filter({}, ['3.250.60.234', 5000], {})).toBe(true)
    expect(probe.filter({}, ['52.1.2.3', 6000], {})).toBe(true)
    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(onFirst).toHaveBeenCalledWith('3.250.60.234:5000', 250)
    expect(probe.summary()).toEqual({
      requests: 3,
      firstFrom: '3.250.60.234:5000',
      firstAfterMs: 250,
      sources: ['3.250.60.234:5000', '52.1.2.3:6000'],
    })
  })
})
