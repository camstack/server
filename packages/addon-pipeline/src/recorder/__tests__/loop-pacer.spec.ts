/**
 * The pacer that keeps a background recovery from costing the live write path.
 *
 * Every case here drives an injected clock + sleep, so nothing waits on real
 * time and the back-off is asserted by the milliseconds it ASKED for.
 */
import { describe, expect, it } from 'vitest'
import { LoopPacer } from '../loop-pacer.js'

/**
 * A pacer whose hop cost is scripted: `lags[i]` is what the i-th zero-delay
 * sleep appears to have taken. Records every sleep the pacer requests.
 */
function paced(lags: readonly number[]) {
  const sleeps: number[] = []
  let clock = 0
  let hop = 0
  const pacer = new LoopPacer({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      // Only the zero-delay probe advances the clock by the scripted lag; a
      // back-off sleep costs exactly what it asked for.
      clock += ms === 0 ? (lags[hop++] ?? 0) : ms
    },
    busyLagMs: 25,
    backoffStepMs: 25,
    maxBackoffMs: 100,
  })
  return { pacer, sleeps }
}

describe('LoopPacer', () => {
  it('costs one plain hop when the loop is idle', async () => {
    const { pacer, sleeps } = paced([0, 1, 0])
    await pacer.hop()
    await pacer.hop()
    await pacer.hop()
    expect(sleeps).toEqual([0, 0, 0])
    expect(pacer.stats()).toMatchObject({ hops: 3, contendedHops: 0, pausedMs: 0 })
  })

  it('stands further back the longer the loop stays contended', async () => {
    const { pacer, sleeps } = paced([40, 40, 40, 40, 40])
    for (let i = 0; i < 5; i++) await pacer.hop()
    // 25, 50, 75, then the 100 ms ceiling twice — never unbounded, so a
    // permanently busy node still drains the backlog.
    expect(sleeps.filter((ms) => ms > 0)).toEqual([25, 50, 75, 100, 100])
  })

  it('forgets the back-off as soon as one hop comes back clean', async () => {
    const { pacer, sleeps } = paced([40, 40, 0, 40])
    for (let i = 0; i < 4; i++) await pacer.hop()
    expect(sleeps.filter((ms) => ms > 0)).toEqual([25, 50, 25])
  })

  it('reports what it observed, so the pass can say whether it stood back', async () => {
    const { pacer } = paced([40, 0, 60])
    for (let i = 0; i < 3; i++) await pacer.hop()
    expect(pacer.stats()).toEqual({ hops: 3, contendedHops: 2, pausedMs: 50, maxLagMs: 60 })
  })
})
