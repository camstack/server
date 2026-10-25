/**
 * Two queues, one lane (D549 16).
 *
 * The library's CoverPreview lane is one-in-flight per host with a 50-deep
 * FIFO and a process-wide host-keyed 400 backoff. A FIFO cannot express
 * priority, so the provider keeps its OWN two queues — interactive and
 * prefetch — hands the library at most one CoverPreview at a time, drains
 * interactive first, and re-checks between every prefetch mint.
 *
 * The bound matters because the alternative is WAITING: an overflowing queue
 * answers 204 with a reason rather than holding a request open behind
 * forty-nine others (the recorder still route's contract).
 */
import { describe, expect, it, vi } from 'vitest'
import { ClipThumbQueue, THUMB_QUEUE_CAPACITY } from '../clips/clip-thumb-queue.js'
import { ThumbQueueRefusedError } from '../clips/clip-still-refusal.js'

const deferred = () => {
  let resolve: (value: Buffer) => void = () => {}
  let reject: (err: Error) => void = () => {}
  const promise = new Promise<Buffer>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ClipThumbQueue', () => {
  it('runs one mint at a time per host', async () => {
    let inFlight = 0
    let peak = 0
    const queue = new ClipThumbQueue()
    const mint = async (): Promise<Buffer> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return Buffer.from('jpeg')
    }
    await Promise.all([
      queue.submit({ host: 'h', lane: 'interactive', run: mint }),
      queue.submit({ host: 'h', lane: 'interactive', run: mint }),
      queue.submit({ host: 'h', lane: 'interactive', run: mint }),
    ])
    expect(peak).toBe(1)
  })

  it('keeps two hosts in two lanes — one hub must not block a standalone', async () => {
    const first = deferred()
    const queue = new ClipThumbQueue()
    const slow = queue.submit({ host: 'hub', lane: 'interactive', run: () => first.promise })
    const fast = await queue.submit({
      host: 'standalone',
      lane: 'interactive',
      run: async () => Buffer.from('fast'),
    })
    expect(fast.toString()).toBe('fast')
    first.resolve(Buffer.from('slow'))
    await slow
  })

  it('drains INTERACTIVE before PREFETCH regardless of arrival order', async () => {
    const gate = deferred()
    const order: string[] = []
    const queue = new ClipThumbQueue()
    const head = queue.submit({ host: 'h', lane: 'interactive', run: () => gate.promise })
    const prefetch = queue.submit({
      host: 'h',
      lane: 'prefetch',
      run: async () => {
        order.push('prefetch')
        return Buffer.from('p')
      },
    })
    const interactive = queue.submit({
      host: 'h',
      lane: 'interactive',
      run: async () => {
        order.push('interactive')
        return Buffer.from('i')
      },
    })
    gate.resolve(Buffer.from('head'))
    await Promise.all([head, prefetch, interactive])
    expect(order).toEqual(['interactive', 'prefetch'])
  })

  it('answers OVERFLOW rather than waiting when the queue is full', async () => {
    const gate = deferred()
    const queue = new ClipThumbQueue()
    const head = queue.submit({ host: 'h', lane: 'interactive', run: () => gate.promise })
    const queued = Array.from({ length: THUMB_QUEUE_CAPACITY }, () =>
      queue.submit({ host: 'h', lane: 'interactive', run: async () => Buffer.from('x') }),
    )
    await expect(
      queue.submit({ host: 'h', lane: 'interactive', run: async () => Buffer.from('x') }),
    ).rejects.toThrow(/queue-full/)
    gate.resolve(Buffer.from('head'))
    await Promise.all([head, ...queued])
  })

  it('opens a host backoff on a camera 400, and says so rather than waiting', async () => {
    const queue = new ClipThumbQueue({ now: () => 0 })
    await expect(
      queue.submit({
        host: 'h',
        lane: 'interactive',
        run: async () => {
          throw new Error(
            'Baichuan CoverPreview request rejected (cmdId=298 responseCode=400 payloadOffset=0)',
          )
        },
      }),
    ).rejects.toThrow(/400/)
    // A PREFETCH is skipped entirely while a host's backoff is open...
    await expect(
      queue.submit({ host: 'h', lane: 'prefetch', run: async () => Buffer.from('x') }),
    ).rejects.toThrow(/backoff/)
    // ...and only an INTERACTIVE request may probe it.
    const probe = vi.fn(async () => Buffer.from('ok'))
    await expect(
      queue.submit({ host: 'h', lane: 'interactive', run: probe }),
    ).resolves.toBeInstanceOf(Buffer)
    expect(probe).toHaveBeenCalled()
  })

  it('clears the backoff once the host answers', async () => {
    let now = 0
    const queue = new ClipThumbQueue({ now: () => now })
    await queue
      .submit({
        host: 'h',
        lane: 'interactive',
        run: async () => {
          throw new Error('rejected responseCode=400')
        },
      })
      .catch(() => {})
    expect(queue.backoffOpen('h')).toBe(true)
    await queue.submit({ host: 'h', lane: 'interactive', run: async () => Buffer.from('ok') })
    expect(queue.backoffOpen('h')).toBe(false)
  })

  it('does NOT open a backoff for a failure that was not a camera refusal', async () => {
    // A decode failure is ours, not the camera's; punishing the host for it
    // would stop minting for every clip on the hub.
    const queue = new ClipThumbQueue({ now: () => 0 })
    await queue
      .submit({
        host: 'h',
        lane: 'interactive',
        run: async () => {
          throw new Error('Failed to decode CoverPreview frame to JPEG (encoding=H264)')
        },
      })
      .catch(() => {})
    expect(queue.backoffOpen('h')).toBe(false)
  })

  it('doubles the backoff on repeated refusals, under a ceiling', async () => {
    let now = 0
    const queue = new ClipThumbQueue({ now: () => now })
    const refuse = () =>
      queue
        .submit({
          host: 'h',
          lane: 'interactive',
          run: async () => {
            throw new Error('rejected responseCode=400')
          },
        })
        .catch(() => {})
    await refuse()
    const first = queue.backoffUntil('h')
    now = first
    await refuse()
    expect(queue.backoffUntil('h') - now).toBeGreaterThan(first)
  })
})

// ── what the periodic catalog refresh asks before it spends the lane ──────

describe('busy() — the question the catalog refresh asks first (D562)', () => {
  it('is false for a host nothing has touched', () => {
    const queue = new ClipThumbQueue({ now: () => 0 })
    expect(queue.busy('h')).toBe(false)
  })

  it('is true while an INTERACTIVE mint holds the lane', async () => {
    const gate = deferred()
    const queue = new ClipThumbQueue({ now: () => 0 })
    const inFlight = queue.submit({ host: 'h', lane: 'interactive', run: () => gate.promise })
    expect(queue.busy('h')).toBe(true)
    gate.resolve(Buffer.from('jpeg'))
    await inFlight
    expect(queue.busy('h')).toBe(false)
  })

  it('is true while a PREFETCH holds the lane too — the refresh is below both', async () => {
    // One lane per host. The periodic refresh is the lowest-priority thing on
    // it, so it yields to a prefetch as readily as to an operator's click.
    const gate = deferred()
    const queue = new ClipThumbQueue({ now: () => 0 })
    const inFlight = queue.submit({ host: 'h', lane: 'prefetch', run: () => gate.promise })
    expect(queue.busy('h')).toBe(true)
    gate.resolve(Buffer.from('jpeg'))
    await inFlight
    expect(queue.busy('h')).toBe(false)
  })

  it('is true while the host is sulking — only somebody WAITING may probe a 400', async () => {
    const queue = new ClipThumbQueue({ now: () => 0 })
    await queue
      .submit({
        host: 'h',
        lane: 'interactive',
        run: async () => {
          throw new Error('rejected responseCode=400')
        },
      })
      .catch(() => {})
    expect(queue.backoffOpen('h')).toBe(true)
    expect(queue.busy('h')).toBe(true)
  })
})

/**
 * The queue is the ONLY thing that knows a refusal is about the LANE rather
 * than about the camera — and it is the only thing that knows when the lane
 * will be free. So it throws a typed refusal carrying both, instead of a
 * message the caller has to read with a regex.
 *
 * This is what lets the route answer `deferred` with a real `retry-after`: a
 * measured 43 of 60 tiles on one page of 592 hit this path on a parallel first
 * paint, and every one of them is a still that arrives seconds later.
 */
describe('the queue refuses with a TYPE, not a sentence', () => {
  it('names a full lane, and how long it is holding', async () => {
    const gate = deferred()
    const queue = new ClipThumbQueue()
    const head = queue.submit({ host: 'h', lane: 'interactive', run: () => gate.promise })
    const queued = Array.from({ length: THUMB_QUEUE_CAPACITY }, () =>
      queue.submit({ host: 'h', lane: 'interactive', run: async () => Buffer.from('x') }),
    )
    const refusal = await queue
      .submit({ host: 'h', lane: 'interactive', run: async () => Buffer.from('x') })
      .then(() => null)
      .catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(ThumbQueueRefusedError)
    expect((refusal as ThumbQueueRefusedError).code).toBe('queue-full')
    // The hint is the DEPTH it is holding, not a constant: a lane 16 deep and
    // a lane 2 deep are not the same wait.
    expect((refusal as ThumbQueueRefusedError).retryAfterMs).toBeGreaterThanOrEqual(
      THUMB_QUEUE_CAPACITY * 1_000,
    )
    gate.resolve(Buffer.from('head'))
    await Promise.all([head, ...queued])
  })

  it('names a sulking host, and the instant its backoff really closes', async () => {
    let now = 0
    const queue = new ClipThumbQueue({ now: () => now })
    await queue
      .submit({
        host: 'h',
        lane: 'interactive',
        run: async () => {
          throw new Error('rejected responseCode=400')
        },
      })
      .catch(() => {})
    now = 400
    const refusal = await queue
      .submit({ host: 'h', lane: 'prefetch', run: async () => Buffer.from('x') })
      .then(() => null)
      .catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(ThumbQueueRefusedError)
    expect((refusal as ThumbQueueRefusedError).code).toBe('camera-backoff')
    // Measured, not guessed: the backoff opened at 0 for 1 000 ms and it is
    // now 400, so 600 ms remain.
    expect((refusal as ThumbQueueRefusedError).retryAfterMs).toBe(600)
  })

  it('a CAMERA failure is not the queue’s refusal — it stays an ordinary error', async () => {
    const queue = new ClipThumbQueue()
    const err = await queue
      .submit({
        host: 'h',
        lane: 'interactive',
        run: async () => {
          throw new Error('Baichuan socket closed')
        },
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ThumbQueueRefusedError)
  })
})
