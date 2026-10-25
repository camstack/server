import { describe, expect, it } from 'vitest'
import { KeyedCommitLock } from '../keyed-commit-lock.js'

describe('KeyedCommitLock', () => {
  it('serializes concurrent work on the same key', async () => {
    const lock = new KeyedCommitLock<string>()
    let depth = 0
    let maxDepth = 0
    const hold = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    const work = async () => {
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
      await hold(5)
      depth -= 1
    }
    await Promise.all([
      lock.run('frame-a', work),
      lock.run('frame-a', work),
      lock.run('frame-a', work),
    ])
    expect(maxDepth).toBe(1)
  })

  it('does not block different keys', async () => {
    const lock = new KeyedCommitLock<string>()
    let depth = 0
    let maxDepth = 0
    const hold = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    const work = async () => {
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
      await hold(10)
      depth -= 1
    }
    await Promise.all([lock.run('a', work), lock.run('b', work)])
    expect(maxDepth).toBe(2)
  })
})
