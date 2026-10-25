import { describe, it, expect } from 'vitest'
import { Semaphore } from '../semaphore.js'

describe('Semaphore', () => {
  it('starts with all slots available', () => {
    const sem = new Semaphore(3)
    expect(sem.available).toBe(3)
    expect(sem.concurrency).toBe(3)
  })

  it('decrements available count on each acquire', async () => {
    const sem = new Semaphore(3)

    await sem.acquire()
    expect(sem.available).toBe(2)

    await sem.acquire()
    expect(sem.available).toBe(1)

    await sem.acquire()
    expect(sem.available).toBe(0)
  })

  it('restores available count when release is called', async () => {
    const sem = new Semaphore(2)

    const release1 = await sem.acquire()
    const release2 = await sem.acquire()
    expect(sem.available).toBe(0)

    release1()
    expect(sem.available).toBe(1)

    release2()
    expect(sem.available).toBe(2)
  })

  it('blocks the (N+1)th acquire until a slot is released', async () => {
    const sem = new Semaphore(2)
    const order: number[] = []

    const release1 = await sem.acquire()
    const release2 = await sem.acquire()

    const p3 = sem.acquire().then((release) => {
      order.push(3)
      return release
    })

    expect(order).toEqual([])
    expect(sem.available).toBe(0)

    release1()
    order.push(1)

    const release3 = await p3
    expect(order).toEqual([1, 3])

    release2()
    release3()
    expect(sem.available).toBe(2)
  })

  it('queues multiple waiters and unblocks them in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    const release1 = await sem.acquire()

    const p2 = sem.acquire().then((r) => {
      order.push(2)
      return r
    })
    const p3 = sem.acquire().then((r) => {
      order.push(3)
      return r
    })

    release1()
    const release2 = await p2

    release2()
    const release3 = await p3

    expect(order).toEqual([2, 3])

    release3()
    expect(sem.available).toBe(1)
  })

  // ── resize() — Phase 6 (settings redesign) hot-reload ─────────────

  it('resize grows concurrency and wakes pending waiters up to the new limit', async () => {
    const sem = new Semaphore(1)

    const release1 = await sem.acquire()
    // Two queued waiters, neither can proceed (concurrency=1, 0 available)
    const waiters: Array<Promise<() => void>> = [sem.acquire(), sem.acquire()]

    // Grow to 3 → should wake both queued waiters immediately.
    sem.resize(3)
    expect(sem.concurrency).toBe(3)

    const [r2, r3] = await Promise.all(waiters)
    expect(sem.available).toBe(0) // 3 acquired, 0 available

    release1()
    r2!()
    r3!()
    expect(sem.available).toBe(3)
  })

  it('resize shrinks concurrency without revoking in-flight permits', async () => {
    const sem = new Semaphore(3)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.available).toBe(1)

    sem.resize(2)
    expect(sem.concurrency).toBe(2)
    // 2 permits in flight, new ceiling 2 → available drops to 0
    expect(sem.available).toBe(0)

    r1()
    expect(sem.available).toBe(1)
    r2()
    expect(sem.available).toBe(2)
  })

  it('resize throws on concurrency < 1', () => {
    const sem = new Semaphore(2)
    expect(() => sem.resize(0)).toThrow(/concurrency must be >= 1/)
    // state unchanged after failed resize
    expect(sem.concurrency).toBe(2)
    expect(sem.available).toBe(2)
  })

  it('allows a single-slot semaphore to act as a mutex', async () => {
    const sem = new Semaphore(1)
    const log: string[] = []

    async function criticalSection(id: string): Promise<void> {
      const release = await sem.acquire()
      log.push(`enter:${id}`)
      await Promise.resolve()
      log.push(`exit:${id}`)
      release()
    }

    await Promise.all([criticalSection('A'), criticalSection('B')])

    expect(log[0]).toBe('enter:A')
    expect(log[1]).toBe('exit:A')
    expect(log[2]).toBe('enter:B')
    expect(log[3]).toBe('exit:B')
  })
})
