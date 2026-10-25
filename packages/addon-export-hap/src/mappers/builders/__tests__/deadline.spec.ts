import { describe, expect, it, vi } from 'vitest'

import { withDeadline } from '../deadline.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withDeadline', () => {
  it('returns the real value when the work finishes in time', async () => {
    const onTimeout = vi.fn()
    const value = await withDeadline(Promise.resolve('real'), 50, 'fallback', onTimeout)
    expect(value).toBe('real')
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('returns the fallback and REPORTS it when the work overruns', async () => {
    // Silence is what made this cost a session: the handler simply took 21 s
    // and nothing said why. A deadline that fires without a log just moves the
    // mystery.
    const onTimeout = vi.fn()
    const slow = deferred<string>()
    const value = await withDeadline(slow.promise, 5, 'fallback', onTimeout)
    expect(value).toBe('fallback')
    expect(onTimeout).toHaveBeenCalledTimes(1)
    slow.resolve('late')
  })

  it('does not reject when the abandoned work fails later', async () => {
    // The work keeps running after we stop waiting. An unhandled rejection
    // from a probe we already gave up on must not take the process down.
    const onTimeout = vi.fn()
    const doomed = deferred<string>()
    const value = await withDeadline(doomed.promise, 5, 'fallback', onTimeout)
    expect(value).toBe('fallback')
    doomed.reject(new Error('probe died after we stopped waiting'))
    await new Promise((r) => setTimeout(r, 10))
  })

  it('uses the fallback when the work rejects INSIDE the deadline', async () => {
    // A failed probe is missing evidence, not a failed session.
    const onTimeout = vi.fn()
    const value = await withDeadline(Promise.reject(new Error('nope')), 50, 'fallback', onTimeout)
    expect(value).toBe('fallback')
  })

  it('settles promptly rather than waiting out the deadline', async () => {
    // A timer that outlives the work would hold the handler open for the full
    // budget on every call — the opposite of the point.
    const started = Date.now()
    await withDeadline(Promise.resolve(1), 5_000, 0, vi.fn())
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
