/**
 * ReadinessRestore drain must overlap attempts. The live 1.2.125 boot spent
 * +223 s before the first recorder pin because `drain()` awaited each camera
 * in order: a `getStreamWithCodec … not published` on hall blocked
 * parking / front door even when those sources were already up.
 *
 * There is still no timer and no polling — a throw stays pending for the next
 * ready signal. The only change is that one slow failure cannot serialise the
 * rest of the fleet.
 */
import { describe, expect, it } from 'vitest'
import { ReadinessRestore } from '../readiness-restore.js'

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('ReadinessRestore drain overlap', () => {
  it('pins a ready device without waiting for an earlier unpublished one', async () => {
    let slowStarted = false
    let slowDone = false
    const finished: number[] = []
    const restore = new ReadinessRestore<number, true>({
      subscribeReady: () => () => {},
      attempt: async (key) => {
        if (key === 104) {
          slowStarted = true
          await delay(80)
          slowDone = true
          throw new Error('getStreamWithCodec: profile "high" source not published')
        }
        await delay(10)
        expect(slowStarted).toBe(true)
        expect(slowDone).toBe(false)
        finished.push(key)
      },
    })

    await restore.start([
      [104, true],
      [101, true],
      [102, true],
    ])

    expect(finished).toEqual([101, 102])
    expect(slowDone).toBe(true)
    expect(restore.pendingCount).toBe(1)
    expect(restore.hasPending(104)).toBe(true)
  })

  it('caps in-flight attempts at the configured concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const restore = new ReadinessRestore<number, true>({
      subscribeReady: () => () => {},
      concurrency: 2,
      attempt: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await delay(30)
        inFlight -= 1
      },
    })

    await restore.start([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ])
    expect(peak).toBe(2)
    expect(restore.pendingCount).toBe(0)
  })

  it('keeps a thrown item pending and retries it on the next ready signal', async () => {
    let attempts = 0
    let fireReady: (() => void) | undefined
    const restore = new ReadinessRestore<string, true>({
      subscribeReady: (handler) => {
        fireReady = handler
        return () => {}
      },
      attempt: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('broker not ready')
      },
    })

    await restore.start([['cam', true]])
    expect(restore.pendingCount).toBe(1)
    expect(attempts).toBe(1)

    fireReady?.()
    await delay(20)
    expect(attempts).toBe(2)
    expect(restore.pendingCount).toBe(0)
  })
})
