import { describe, expect, it } from 'vitest'
import {
  createSocketPlaneMeter,
  createSocketPlaneReader,
  formatSocketPlane,
  type SocketPlaneRegistry,
} from '../socket-plane-report.js'
import type { SocketTrafficSample } from '../transport/socket-traffic.js'

/**
 * Raw-forward makes the parent blind to the bytes of a sibling call on
 * purpose. The one thing it must stay able to say is how often it was blind:
 * the forward census rides the `[mem]` line as `socketFwd=<raw>/<decoded>`,
 * per window, appended after the D446 queue fields so every existing prefix
 * still matches.
 */

const quiet: SocketTrafficSample = {
  tx: { reqMessages: 0, reqBytes: 0, resMessages: 0, resBytes: 0, evtMessages: 0, evtBytes: 0 },
  rx: { reqMessages: 0, reqBytes: 0, resMessages: 0, resBytes: 0, evtMessages: 0, evtBytes: 0 },
}

function registryWith(census: { raw: number; decoded: number } | null): SocketPlaneRegistry {
  return {
    listChildren: () => [{ childId: 'a' }],
    getChildSocketTraffic: () => quiet,
    getChildQueuedBytes: () => 0,
    ...(census === null ? {} : { readForwardCensus: () => census }),
  }
}

describe('the forward census rides the heartbeat, per window', () => {
  it('the reader carries the cumulative census when the registry keeps one', () => {
    const read = createSocketPlaneReader({ registry: () => registryWith({ raw: 40, decoded: 2 }) })
    expect(read()?.forward).toEqual({ raw: 40, decoded: 2 })
  })

  it('a registry without a census yields none — absent, never zero', () => {
    const read = createSocketPlaneReader({ registry: () => registryWith(null) })
    expect(read()?.forward).toBeUndefined()
    expect(formatSocketPlane(createSocketPlaneMeter(read).read())).not.toContain('socketFwd=')
  })

  it('the window is the delta since the previous line, and the line prints it last', () => {
    let census = { raw: 100, decoded: 10 }
    const meter = createSocketPlaneMeter(
      createSocketPlaneReader({ registry: () => registryWith(census) }),
    )
    const first = meter.read()
    expect(first?.forward).toEqual({ raw: 100, decoded: 10 })
    census = { raw: 160, decoded: 13 }
    const second = meter.read()
    expect(second?.forward).toEqual({ raw: 60, decoded: 3 })
    const line = formatSocketPlane(second)
    expect(line.endsWith(' socketFwd=60/3')).toBe(true)
    expect(line.indexOf('socketQueued=')).toBeLessThan(line.indexOf('socketFwd='))
  })

  it('a respawned parent counter reads as a quiet window, never negative', () => {
    let census = { raw: 50, decoded: 5 }
    const meter = createSocketPlaneMeter(
      createSocketPlaneReader({ registry: () => registryWith(census) }),
    )
    meter.read()
    census = { raw: 3, decoded: 0 }
    expect(meter.read()?.forward).toEqual({ raw: 0, decoded: 0 })
  })
})
