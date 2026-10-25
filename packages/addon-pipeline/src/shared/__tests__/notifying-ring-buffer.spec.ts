import { describe, expect, it } from 'vitest'
import { NotifyingRingBuffer } from '../notifying-ring-buffer.js'

/**
 * The server side of the `pullFrames`/`pullHandles` long-poll: an empty drain
 * must block until a real commit (`push`) rather than busy-spinning, resolve on
 * a timeout when nothing commits, and be cancellable on teardown.
 */
describe('NotifyingRingBuffer', () => {
  it('returns immediately when items are already present', async () => {
    const ring = new NotifyingRingBuffer<number>(4)
    ring.push(1)
    const start = Date.now()
    await ring.waitForItem(1000)
    expect(Date.now() - start).toBeLessThan(50)
    expect(ring.drain(4)).toEqual([1])
  })

  it('returns immediately when waitMs <= 0 (legacy immediate-return)', async () => {
    const ring = new NotifyingRingBuffer<number>(4)
    const start = Date.now()
    await ring.waitForItem(0)
    expect(Date.now() - start).toBeLessThan(50)
    expect(ring.drain(4)).toEqual([])
  })

  it('(a) empty ring + waitMs → resolves on a commit, well before waitMs', async () => {
    const ring = new NotifyingRingBuffer<number>(4)
    const waitMs = 5000
    const start = Date.now()
    const wait = ring.waitForItem(waitMs)
    // Commit after a short delay — the wait must be woken by the commit signal,
    // not spin and not wait out the full window.
    setTimeout(() => ring.push(42), 20)
    await wait
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(waitMs / 2)
    expect(ring.drain(4)).toEqual([42])
  })

  it('(b) resolves after waitMs when no commit arrives', async () => {
    const ring = new NotifyingRingBuffer<number>(4)
    const waitMs = 60
    const start = Date.now()
    await ring.waitForItem(waitMs)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(waitMs - 15)
    expect(elapsed).toBeLessThan(waitMs + 500)
    expect(ring.drain(4)).toEqual([])
  })

  it('(c) cancel() resolves an in-flight wait promptly (teardown)', async () => {
    const ring = new NotifyingRingBuffer<number>(4)
    const waitMs = 5000
    const start = Date.now()
    const wait = ring.waitForItem(waitMs)
    setTimeout(() => ring.cancel(), 20)
    await wait
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(waitMs / 2)
    // Nothing committed — the ring is still empty after a cancel.
    expect(ring.drain(4)).toEqual([])
  })
})
