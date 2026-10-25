import { describe, expect, it } from 'vitest'
import { createSerialQueue } from '../serial-queue.js'

describe('createSerialQueue (agent reconnect serialization)', () => {
  it('SECURITY: concurrent requests run one at a time, in order, never interleaved', async () => {
    const events: string[] = []
    let active = 0
    let maxActive = 0
    let n = 0
    const queue = createSerialQueue(async () => {
      const id = ++n
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start ${id}`)
      await new Promise((r) => setTimeout(r, 15))
      events.push(`end ${id}`)
      active -= 1
      return id
    })
    const results = await Promise.all([queue(), queue(), queue()])
    expect(results).toEqual([1, 2, 3])
    expect(maxActive).toBe(1)
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
  })

  it('a failed job does not block the next one, and each caller sees its own outcome', async () => {
    let calls = 0
    const queue = createSerialQueue(async () => {
      calls += 1
      if (calls === 1) throw new Error('first fails')
      return calls
    })
    const first = queue()
    const second = queue()
    await expect(first).rejects.toThrow('first fails')
    await expect(second).resolves.toBe(2)
  })

  it('SECURITY: a job that never settles is abandoned at its deadline - onTimeout runs and the NEXT job still runs', async () => {
    let n = 0
    const timeouts: string[] = []
    let fire: () => void = () => undefined
    const queue = createSerialQueue(
      () => {
        n += 1
        return n === 1 ? new Promise<number>(() => undefined) : Promise.resolve(n)
      },
      {
        deadlineMs: 90_000,
        onTimeout: () => void timeouts.push('destroyed the half-built broker'),
        setTimer: (fn) => {
          fire = fn
          return { cancel: () => undefined }
        },
      },
    )
    const stuck = queue()
    const next = queue()
    await new Promise((r) => setImmediate(r))
    expect(n).toBe(1) // the second job waits behind the stuck one
    fire()
    await expect(stuck).rejects.toThrow(/did not finish within 90000 ms/)
    expect(timeouts).toEqual(['destroyed the half-built broker'])
    await expect(next).resolves.toBe(2)
  })
})
