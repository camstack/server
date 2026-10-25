import { describe, it, expect, vi } from 'vitest'
import { DisposerChain } from '../disposer-chain.js'

describe('DisposerChain', () => {
  it('runs disposers in LIFO order', async () => {
    const calls: number[] = []
    const chain = new DisposerChain()
    chain.add(() => {
      calls.push(1)
    })
    chain.add(() => {
      calls.push(2)
    })
    chain.add(() => {
      calls.push(3)
    })
    await chain.dispose()
    expect(calls).toEqual([3, 2, 1])
  })

  it('awaits async disposers in order', async () => {
    const calls: number[] = []
    const chain = new DisposerChain()
    chain.add(async () => {
      await new Promise((r) => setTimeout(r, 10))
      calls.push(1)
    })
    chain.add(async () => {
      await new Promise((r) => setTimeout(r, 5))
      calls.push(2)
    })
    await chain.dispose()
    expect(calls).toEqual([2, 1])
  })

  it('continues running disposers after one throws', async () => {
    const errors: unknown[] = []
    const chain = new DisposerChain({ onError: (err) => errors.push(err) })
    const a = vi.fn(() => {
      throw new Error('boom')
    })
    const b = vi.fn()
    const c = vi.fn()
    chain.add(a)
    chain.add(b)
    chain.add(c)
    await chain.dispose()
    expect(c).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    expect(a).toHaveBeenCalled()
    expect(errors).toHaveLength(1)
  })

  it('the unsubscribe handle removes a single disposer', async () => {
    const calls: number[] = []
    const chain = new DisposerChain()
    chain.add(() => {
      calls.push(1)
    })
    const unsub = chain.add(() => {
      calls.push(2)
    })
    chain.add(() => {
      calls.push(3)
    })
    unsub()
    await chain.dispose()
    expect(calls).toEqual([3, 1])
  })

  it('dispose() is idempotent', async () => {
    const fn = vi.fn()
    const chain = new DisposerChain()
    chain.add(fn)
    await chain.dispose()
    await chain.dispose()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('add() after dispose() runs the disposer immediately', async () => {
    const chain = new DisposerChain()
    await chain.dispose()
    const fn = vi.fn()
    chain.add(fn)
    expect(fn).toHaveBeenCalled()
  })

  it('size reflects current disposers and resets to 0 after dispose', async () => {
    const chain = new DisposerChain()
    chain.add(() => undefined)
    chain.add(() => undefined)
    expect(chain.size).toBe(2)
    await chain.dispose()
    expect(chain.size).toBe(0)
    expect(chain.isDisposed).toBe(true)
  })
})
