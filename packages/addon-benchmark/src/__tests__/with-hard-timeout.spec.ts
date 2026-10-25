/**
 * Unit tests for `withHardTimeout` — the benchmark run's hard backstop that
 * guarantees the UI can never hang on "loading" forever, even if a server-side
 * step stalls upstream of the pool's own per-request timeout.
 */
import { describe, expect, it, vi } from 'vitest'
import { withHardTimeout } from '../benchmark-addon.js'

describe('withHardTimeout', () => {
  it('resolves with the value when the work settles before the deadline', async () => {
    const out = await withHardTimeout(Promise.resolve(42), 1_000, 'test')
    expect(out).toBe(42)
  })

  it('rejects with a clear message when the work never settles (the hang guard)', async () => {
    // A promise that never resolves — the exact "loading forever" scenario.
    const hang = new Promise<number>(() => {})
    await expect(withHardTimeout(hang, 20, 'runPipelineTest')).rejects.toThrow(
      /runPipelineTest exceeded 20ms/,
    )
  })

  it('propagates a genuine rejection from the work unchanged', async () => {
    const failed = Promise.reject(new Error('boom'))
    await expect(withHardTimeout(failed, 1_000, 'test')).rejects.toThrow('boom')
  })

  it('does not leave a dangling timer after the work settles', async () => {
    // clearTimeout is called in finally — a fast resolve must not keep a timer.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await withHardTimeout(Promise.resolve('ok'), 5_000, 'test')
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
