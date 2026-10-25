/**
 * `subscribeEvent` fans one WS subscription out to N listeners.
 *
 * Measured on the viewer's boot: ~40 tRPC subscriptions before first paint,
 * of which 24 were twelve camera cards subscribing to the SAME two motion
 * categories and filtering by deviceId inside their own callbacks. Each was a
 * separate handshake on a transport that does not batch.
 *
 * The tests exercise the real `System` with a stubbed tRPC client, so
 * what is asserted is the number of `live.onEvent.subscribe` calls the SDK
 * actually makes — not a mock of the deduping itself.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { System } from '../system.js'

interface FakeSub {
  readonly category: string
  readonly onData: (event: unknown) => void
  unsubscribed: boolean
}

/** Records every subscription the SDK opens, and lets a test push events. */
class FakeTrpc {
  readonly subs: FakeSub[] = []
  readonly live = {
    onEvent: {
      subscribe: (
        input: { category: string },
        opts: { onData: (event: unknown) => void },
      ): { unsubscribe: () => void } => {
        const sub: FakeSub = { category: input.category, onData: opts.onData, unsubscribed: false }
        this.subs.push(sub)
        return {
          unsubscribe: () => {
            sub.unsubscribed = true
          },
        }
      },
    },
  }

  emit(category: string, event: unknown): void {
    for (const s of this.subs) {
      if (s.category === category && !s.unsubscribed) s.onData(event)
    }
  }

  get open(): FakeSub[] {
    return this.subs.filter((s) => !s.unsubscribed)
  }
}

let trpc: FakeTrpc
let system: System

/** Build a system without touching the network, then swap in the fake client. */
function makeSystem(): System {
  const s = Object.create(System.prototype) as System
  const mutable = s as unknown as Record<string, unknown>
  mutable['_trpcClient'] = trpc
  mutable['_eventSubs'] = new Map()
  return s
}

beforeEach(() => {
  trpc = new FakeTrpc()
  system = makeSystem()
})

describe('one subscription per category', () => {
  it('opens ONE for twelve cameras on the same category', () => {
    // The exact production shape: every card subscribes and filters itself.
    const seen: number[] = []
    for (let deviceId = 1; deviceId <= 12; deviceId += 1) {
      system.subscribeEvent('detection.motion', (e) => {
        const id = (e as unknown as { deviceId: number }).deviceId
        if (id === deviceId) seen.push(deviceId)
      })
    }

    expect(trpc.open).toHaveLength(1)

    // And every listener still receives it — dedupe must not cost delivery.
    for (let deviceId = 1; deviceId <= 12; deviceId += 1) {
      trpc.emit('detection.motion', { deviceId })
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('keeps distinct categories apart', () => {
    const a: string[] = []
    const b: string[] = []
    system.subscribeEvent('cat.a', () => a.push('a'))
    system.subscribeEvent('cat.b', () => b.push('b'))

    expect(trpc.open).toHaveLength(2)
    trpc.emit('cat.a', {})
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })
})

describe('teardown', () => {
  it('keeps the subscription alive while ANY listener remains', () => {
    const offA = system.subscribeEvent('cat', () => {})
    system.subscribeEvent('cat', () => {})

    offA()
    expect(trpc.open).toHaveLength(1)
  })

  it('closes it once the last listener leaves', () => {
    const offA = system.subscribeEvent('cat', () => {})
    const offB = system.subscribeEvent('cat', () => {})
    offA()
    offB()

    expect(trpc.open).toHaveLength(0)
  })

  it('re-opens after the last listener left', () => {
    system.subscribeEvent('cat', () => {})()
    const received: number[] = []
    system.subscribeEvent('cat', () => received.push(1))

    expect(trpc.open).toHaveLength(1)
    trpc.emit('cat', {})
    expect(received).toEqual([1])
  })

  it('survives an unsubscribe called twice', () => {
    // React effects run their cleanup more than once under StrictMode; a
    // second call must not tear down the subscription the NEXT mount is using.
    const off = system.subscribeEvent('cat', () => {})
    off()
    const received: number[] = []
    system.subscribeEvent('cat', () => received.push(1))
    off()

    trpc.emit('cat', {})
    expect(received).toEqual([1])
  })
})

describe('delivery', () => {
  it('a throwing listener does not stop the others', () => {
    const ok: number[] = []
    system.subscribeEvent('cat', () => {
      throw new Error('boom')
    })
    system.subscribeEvent('cat', () => ok.push(1))

    trpc.emit('cat', {})
    expect(ok).toEqual([1])
  })

  it('a listener that unsubscribes itself on receipt does not break the loop', () => {
    // A one-shot waiter mutates the listener set mid-iteration.
    const ok: number[] = []
    const off = system.subscribeEvent('cat', () => {
      off()
    })
    system.subscribeEvent('cat', () => ok.push(1))

    expect(() => trpc.emit('cat', {})).not.toThrow()
    expect(ok).toEqual([1])
  })
})
