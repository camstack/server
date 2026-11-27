import { describe, expect, it } from 'vitest'
import { probeZ2m } from '../z2m-probe.js'
import { FakeNet, ManualTimers } from './fakes.js'

const endpoint = { host: 'z2m.lan', port: 8080, tls: false, token: null }

describe('probeZ2m', () => {
  it('validates once the server pushes a bridge message', async () => {
    const net = new FakeNet()
    const result = probeZ2m(endpoint, { factory: net.factory, timers: new ManualTimers() })
    net.last.open()
    net.last.push('bridge/state', { state: 'online' })
    await expect(result).resolves.toEqual({ success: true, status: 'validated' })
    expect(net.last.closed).toBe(true)
  })

  it('rejects a refused token (4401) as a definite no', async () => {
    const net = new FakeNet()
    const result = probeZ2m(endpoint, { factory: net.factory, timers: new ManualTimers() })
    net.last.drop(4401, 'Unauthorized')
    await expect(result).resolves.toMatchObject({ success: false, status: 'rejected' })
  })

  it('is inconclusive, not a pass, when nothing answers or the host is unreachable', async () => {
    const net = new FakeNet()
    const timers = new ManualTimers()
    const silent = probeZ2m(endpoint, { factory: net.factory, timers })
    net.last.open()
    timers.fire()
    await expect(silent).resolves.toMatchObject({ success: false, status: 'inconclusive' })
    const refused = probeZ2m(endpoint, { factory: net.factory, timers: new ManualTimers() })
    net.last.drop(1006)
    await expect(refused).resolves.toMatchObject({ success: false, status: 'inconclusive' })
  })
})
