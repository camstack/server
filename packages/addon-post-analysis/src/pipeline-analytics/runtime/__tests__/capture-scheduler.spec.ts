import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  CaptureScheduler,
  captureCoalesceKey,
  DEFAULT_CAPTURE_PRIORITY,
  deriveFrameDispatchKind,
  type CaptureDropNotice,
} from '../capture-scheduler.js'

interface LoggedEntry {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

function stubLogger(entries: LoggedEntry[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => entries.push({ level: 'debug', message, extras }),
    info: (message, extras) => entries.push({ level: 'info', message, extras }),
    warn: (message, extras) => entries.push({ level: 'warn', message, extras }),
    error: (message, extras) => entries.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (err: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  let rejectFn: (err: Error) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/** Let queued microtasks (settle → pump chains) drain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

interface SchedulerHarness {
  readonly scheduler: CaptureScheduler
  readonly entries: LoggedEntry[]
  clock: number
}

function makeScheduler(options?: {
  maxInFlightPerDevice?: number
  logWindowMs?: number
}): SchedulerHarness {
  const entries: LoggedEntry[] = []
  const harness: SchedulerHarness = {
    entries,
    clock: 0,
    scheduler: new CaptureScheduler({
      logger: stubLogger(entries),
      ...(options?.maxInFlightPerDevice !== undefined
        ? { maxInFlightPerDevice: options.maxInFlightPerDevice }
        : {}),
      ...(options?.logWindowMs !== undefined ? { logWindowMs: options.logWindowMs } : {}),
      now: () => harness.clock,
    }),
  }
  return harness
}

describe('CaptureScheduler', () => {
  describe('no-contention semantics (byte-identical to the pre-S3 direct call)', () => {
    it('invokes exec SYNCHRONOUSLY inside request() while under budget', () => {
      const { scheduler } = makeScheduler()
      let started = false
      void scheduler.request({
        deviceId: 1,
        kind: 'thumbnail',
        exec: async () => {
          started = true
          return 'ok'
        },
      })
      expect(started).toBe(true)
    })

    it('resolves with the exec value and preserves per-call start order', async () => {
      const { scheduler } = makeScheduler()
      const order: string[] = []
      const first = scheduler.request({
        deviceId: 1,
        kind: 'keyFrame',
        exec: async () => {
          order.push('a')
          return 'A'
        },
      })
      const second = scheduler.request({
        deviceId: 1,
        kind: 'firstFrame',
        exec: async () => {
          order.push('b')
          return 'B'
        },
      })
      // Under budget nothing is reordered — priority only affects the QUEUE.
      expect(order).toEqual(['a', 'b'])
      expect(await first).toBe('A')
      expect(await second).toBe('B')
    })

    it('propagates an exec rejection to the caller and frees the budget slot', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const failing = scheduler.request({
        deviceId: 1,
        kind: 'other',
        exec: async () => {
          throw new Error('boom')
        },
      })
      await expect(failing).rejects.toThrow('boom')
      await flushMicrotasks()
      expect(scheduler.inFlight(1)).toBe(0)
      let ran = false
      await scheduler.request({
        deviceId: 1,
        kind: 'other',
        exec: async () => {
          ran = true
        },
      })
      expect(ran).toBe(true)
    })

    it('a synchronously-throwing exec rejects and frees the budget slot', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const failing = scheduler.request({
        deviceId: 1,
        kind: 'other',
        exec: (): Promise<void> => {
          throw new Error('sync boom')
        },
      })
      await expect(failing).rejects.toThrow('sync boom')
      expect(scheduler.inFlight(1)).toBe(0)
    })
  })

  describe('per-device budget', () => {
    it('runs at most N execs per device; the 4th waits until one settles', async () => {
      const { scheduler } = makeScheduler() // default budget 3
      const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
      const startedFourth = { value: false }
      for (const gate of gates) {
        void scheduler.request({ deviceId: 1, kind: 'snapshot', exec: () => gate.promise })
      }
      const fourth = scheduler.request({
        deviceId: 1,
        kind: 'snapshot',
        exec: async () => {
          startedFourth.value = true
        },
      })
      expect(scheduler.inFlight(1)).toBe(3)
      expect(scheduler.queueDepth(1)).toBe(1)
      expect(startedFourth.value).toBe(false)

      gates[0]?.resolve()
      await flushMicrotasks()
      expect(startedFourth.value).toBe(true)
      await fourth
      expect(scheduler.queueDepth(1)).toBe(0)
    })

    it('budgets are per device — a second device is not blocked', () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 1, kind: 'snapshot', exec: () => gate.promise })
      let otherStarted = false
      void scheduler.request({
        deviceId: 2,
        kind: 'snapshot',
        exec: async () => {
          otherStarted = true
        },
      })
      expect(otherStarted).toBe(true)
      gate.resolve()
    })
  })

  describe('priority ordering', () => {
    it('a queued firstFrame runs before an earlier-queued thumbnail', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      const order: string[] = []
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      void scheduler.request({
        deviceId: 1,
        kind: 'thumbnail',
        exec: async () => {
          order.push('thumbnail')
        },
      })
      void scheduler.request({
        deviceId: 1,
        kind: 'firstFrame',
        exec: async () => {
          order.push('firstFrame')
        },
      })
      gate.resolve()
      await flushMicrotasks()
      expect(order).toEqual(['firstFrame', 'thumbnail'])
    })

    it('explicit priority overrides the kind default; FIFO within a priority', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      const order: string[] = []
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      void scheduler.request({
        deviceId: 1,
        kind: 'embed',
        priority: 0,
        exec: async () => {
          order.push('embed-boosted')
        },
      })
      void scheduler.request({
        deviceId: 1,
        kind: 'firstFrame',
        exec: async () => {
          order.push('firstFrame-1')
        },
      })
      void scheduler.request({
        deviceId: 1,
        kind: 'firstFrame',
        exec: async () => {
          order.push('firstFrame-2')
        },
      })
      gate.resolve()
      await flushMicrotasks()
      expect(order).toEqual(['embed-boosted', 'firstFrame-1', 'firstFrame-2'])
    })
  })

  describe("S4 confirmation crop (kind 'confirm') — never starved", () => {
    it('a confirm request jumps a FULL queue of every other kind', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      const order: string[] = []
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      // Queue the whole non-confirm ladder FIRST (each would run before a
      // late arrival of equal-or-lower priority)…
      const kinds = [
        'keyFrame',
        'thumbnail',
        'timeline',
        'lastFrame',
        'snapshot',
        'embed',
        'face',
        'plate',
        'other',
      ] as const
      const settled: Promise<unknown>[] = []
      for (const kind of kinds) {
        settled.push(
          scheduler.request({
            deviceId: 1,
            kind,
            exec: async () => {
              order.push(kind)
            },
          }),
        )
      }
      // …then the confirmation crop arrives LAST and must still run FIRST.
      settled.push(
        scheduler.request({
          deviceId: 1,
          kind: 'confirm',
          exec: async () => {
            order.push('confirm')
          },
        }),
      )
      gate.resolve()
      await Promise.all(settled)
      expect(order[0]).toBe('confirm')
      // Nothing is lost either — every queued capture still ran.
      expect(order).toHaveLength(kinds.length + 1)
    })

    it('a queued confirm WITHOUT staleAfterMs is never stale-dropped, however late', async () => {
      const harness = makeScheduler({ maxInFlightPerDevice: 1 })
      const { scheduler } = harness
      const gate = deferred<void>()
      let ran = false
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      const confirm = scheduler.request({
        deviceId: 1,
        kind: 'confirm',
        trackId: 't-birth',
        exec: async () => {
          ran = true
          return Buffer.from('crop')
        },
      })
      // An absurdly long queue wait — a stale-droppable request would be
      // dropped at dequeue; the confirmation must still exec.
      harness.clock += 3_600_000
      gate.resolve()
      await flushMicrotasks()
      expect(ran).toBe(true)
      expect(Buffer.isBuffer(await confirm)).toBe(true)
      expect(scheduler.counters(1)?.droppedStale ?? 0).toBe(0)
    })
  })

  describe('coalescing (the RC-1 in-flight-Set replacement)', () => {
    it('same coalesceKey while running returns the SAME promise, one exec, counted', async () => {
      const { scheduler } = makeScheduler()
      const gate = deferred<string>()
      let execs = 0
      const key = captureCoalesceKey(101, 'keyFrame', 'trk')
      const first = scheduler.request({
        deviceId: 101,
        trackId: 'trk',
        kind: 'keyFrame',
        coalesceKey: key,
        exec: () => {
          execs += 1
          return gate.promise
        },
      })
      const second = scheduler.request({
        deviceId: 101,
        trackId: 'trk',
        kind: 'keyFrame',
        coalesceKey: key,
        exec: () => {
          execs += 1
          return gate.promise
        },
      })
      expect(second).toBe(first)
      expect(execs).toBe(1)
      expect(scheduler.isKeyActive(key)).toBe(true)
      expect(scheduler.counters(101)?.coalesced).toBe(1)
      expect(scheduler.counters(101)?.started).toBe(1)

      gate.resolve('done')
      expect(await second).toBe('done')
      await flushMicrotasks()
      // Key released on settle → a re-fire execs again (the retry path).
      expect(scheduler.isKeyActive(key)).toBe(false)
      await scheduler.request({
        deviceId: 101,
        trackId: 'trk',
        kind: 'keyFrame',
        coalesceKey: key,
        exec: () => {
          execs += 1
          return Promise.resolve('again')
        },
      })
      expect(execs).toBe(2)
    })

    it('coalesces against a QUEUED request too', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      let execs = 0
      const key = captureCoalesceKey(1, 'keyFrame', 't')
      const queued = scheduler.request({
        deviceId: 1,
        kind: 'keyFrame',
        coalesceKey: key,
        exec: async () => {
          execs += 1
        },
      })
      const joined = scheduler.request({
        deviceId: 1,
        kind: 'keyFrame',
        coalesceKey: key,
        exec: async () => {
          execs += 1
        },
      })
      expect(joined).toBe(queued)
      expect(scheduler.queueDepth(1)).toBe(1)
      gate.resolve()
      await flushMicrotasks()
      expect(execs).toBe(1)
    })
  })

  describe('hold keys (batch-dispatch demand-side gates)', () => {
    it('holdKeys are active while running and released on settle, refcounted', async () => {
      const { scheduler } = makeScheduler()
      const gateA = deferred<void>()
      const gateB = deferred<void>()
      const shared = captureCoalesceKey(1, 'thumbnail', 't1')
      void scheduler.request({
        deviceId: 1,
        kind: 'thumbnail',
        holdKeys: [shared, captureCoalesceKey(1, 'lastFrame', 't2')],
        exec: () => gateA.promise,
      })
      void scheduler.request({
        deviceId: 1,
        kind: 'thumbnail',
        holdKeys: [shared],
        exec: () => gateB.promise,
      })
      expect(scheduler.isKeyActive(shared)).toBe(true)
      expect(scheduler.isKeyActive(captureCoalesceKey(1, 'lastFrame', 't2'))).toBe(true)
      gateA.resolve()
      await flushMicrotasks()
      // Still held by the second request (refcount), the exclusive key is gone.
      expect(scheduler.isKeyActive(shared)).toBe(true)
      expect(scheduler.isKeyActive(captureCoalesceKey(1, 'lastFrame', 't2'))).toBe(false)
      gateB.resolve()
      await flushMicrotasks()
      expect(scheduler.isKeyActive(shared)).toBe(false)
    })

    it('holdKeys do NOT dedupe (unlike coalesceKey)', () => {
      const { scheduler } = makeScheduler()
      const gate = deferred<void>()
      let execs = 0
      const key = captureCoalesceKey(1, 'thumbnail', 't')
      void scheduler.request({
        deviceId: 1,
        kind: 'thumbnail',
        holdKeys: [key],
        exec: () => {
          execs += 1
          return gate.promise
        },
      })
      void scheduler.request({
        deviceId: 1,
        kind: 'thumbnail',
        holdKeys: [key],
        exec: () => {
          execs += 1
          return gate.promise
        },
      })
      expect(execs).toBe(2)
      gate.resolve()
    })
  })

  describe('staleness drop', () => {
    it('a queued request older than staleAfterMs resolves null without exec', async () => {
      const harness = makeScheduler({ maxInFlightPerDevice: 1 })
      const { scheduler } = harness
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      let ran = false
      const stale = scheduler.request({
        deviceId: 1,
        kind: 'snapshot',
        staleAfterMs: 100,
        exec: async () => {
          ran = true
          return 'late'
        },
      })
      harness.clock = 200 // older than staleAfterMs by dequeue time
      gate.resolve()
      await flushMicrotasks()
      expect(await stale).toBeNull()
      expect(ran).toBe(false)
      expect(scheduler.counters(1)?.droppedStale).toBe(1)
    })

    it('a fresh queued request still execs (staleness checked at dequeue)', async () => {
      const harness = makeScheduler({ maxInFlightPerDevice: 1 })
      const { scheduler } = harness
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      const fresh = scheduler.request({
        deviceId: 1,
        kind: 'snapshot',
        staleAfterMs: 100,
        exec: async () => 'in-time',
      })
      harness.clock = 50
      gate.resolve()
      await flushMicrotasks()
      expect(await fresh).toBe('in-time')
    })
  })

  describe('cancelForTrack (wired from TrackResidentState.close)', () => {
    it('drops QUEUED requests of the track (null, no exec); running is not interrupted', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<string>()
      let cancelledExecs = 0
      const running = scheduler.request({
        deviceId: 1,
        trackId: 'closing',
        kind: 'keyFrame',
        exec: () => gate.promise,
      })
      const queuedA = scheduler.request({
        deviceId: 1,
        trackId: 'closing',
        kind: 'thumbnail',
        exec: async () => {
          cancelledExecs += 1
        },
      })
      const queuedOther = scheduler.request({
        deviceId: 1,
        trackId: 'other',
        kind: 'thumbnail',
        exec: async () => 'other-ran',
      })

      expect(scheduler.cancelForTrack('closing')).toBe(1)
      expect(await queuedA).toBeNull()
      expect(cancelledExecs).toBe(0)
      expect(scheduler.counters(1)?.cancelled).toBe(1)

      // The RUNNING exec of the closed track settles normally.
      gate.resolve('running-finished')
      expect(await running).toBe('running-finished')
      await flushMicrotasks()
      // The other track's queued request was untouched and ran after.
      expect(await queuedOther).toBe('other-ran')
    })

    it('releases the cancelled request coalesce/hold keys', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      const key = captureCoalesceKey(1, 'keyFrame', 'x')
      const queued = scheduler.request({
        deviceId: 1,
        trackId: 'x',
        kind: 'keyFrame',
        coalesceKey: key,
        exec: async () => 'never',
      })
      expect(scheduler.isKeyActive(key)).toBe(true)
      scheduler.cancelForTrack('x')
      expect(await queued).toBeNull()
      await flushMicrotasks()
      expect(scheduler.isKeyActive(key)).toBe(false)
      gate.resolve()
    })
  })

  describe('metrics + aggregated window log (MediaCaptureLogAggregator idiom)', () => {
    it('emits ONE info line per device once the window elapses, with the sums', async () => {
      const harness = makeScheduler({ maxInFlightPerDevice: 1, logWindowMs: 60_000 })
      const { scheduler, entries } = harness
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 9, kind: 'other', exec: () => gate.promise })
      const key = captureCoalesceKey(9, 'keyFrame', 't')
      void scheduler
        .request({ deviceId: 9, kind: 'keyFrame', coalesceKey: key, exec: async () => undefined })
        .catch(() => undefined)
      void scheduler
        .request({ deviceId: 9, kind: 'keyFrame', coalesceKey: key, exec: async () => undefined })
        .catch(() => undefined)
      expect(entries).toHaveLength(0) // still accumulating — never per-request

      harness.clock = 60_001
      gate.resolve()
      await flushMicrotasks()
      // The settle bumps flush the elapsed window.
      const infoLines = entries.filter((e) => e.message === 'capture scheduler (window)')
      expect(infoLines).toHaveLength(1)
      const first = infoLines[0]
      expect(first?.level).toBe('info')
      expect(first?.extras).toMatchObject({
        tags: { deviceId: 9 },
        meta: {
          requested: 3,
          coalesced: 1,
          maxQueueDepth: 1,
        },
      })
    })

    it('counters snapshot exposes the current window (visibility for late batches)', () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 3, kind: 'other', exec: () => gate.promise })
      void scheduler.request({ deviceId: 3, kind: 'snapshot', exec: async () => undefined })
      void scheduler.request({ deviceId: 3, kind: 'snapshot', exec: async () => undefined })
      const counters = scheduler.counters(3)
      expect(counters?.requested).toBe(3)
      expect(counters?.started).toBe(1)
      expect(counters?.maxQueueDepth).toBe(2)
      gate.resolve()
    })
  })

  describe('clear (addon dispose)', () => {
    it('drops all queued requests as null and resets state', async () => {
      const { scheduler } = makeScheduler({ maxInFlightPerDevice: 1 })
      const gate = deferred<void>()
      void scheduler.request({ deviceId: 1, kind: 'other', exec: () => gate.promise })
      let ran = false
      const queued = scheduler.request({
        deviceId: 1,
        kind: 'snapshot',
        exec: async () => {
          ran = true
        },
      })
      scheduler.clear()
      expect(await queued).toBeNull()
      expect(ran).toBe(false)
      expect(scheduler.queueDepth(1)).toBe(0)
      gate.resolve()
    })
  })

  describe('helpers', () => {
    it('captureCoalesceKey formats deviceId:kind:trackId', () => {
      expect(captureCoalesceKey(101, 'thumbnail', 'trk-1')).toBe('101:thumbnail:trk-1')
    })

    it('kind-derived default priorities match the spec ladder', () => {
      expect(DEFAULT_CAPTURE_PRIORITY.firstFrame).toBe(0)
      // S4: the confirmation-gate crop GATES track birth (the frame path
      // awaits it) — it must rank at the very top so it can never be starved
      // behind queued media/enrichment captures.
      expect(DEFAULT_CAPTURE_PRIORITY.confirm).toBe(0)
      expect(DEFAULT_CAPTURE_PRIORITY.keyFrame).toBe(1)
      expect(DEFAULT_CAPTURE_PRIORITY.thumbnail).toBe(2)
      expect(DEFAULT_CAPTURE_PRIORITY.timeline).toBe(3)
      expect(DEFAULT_CAPTURE_PRIORITY.lastFrame).toBe(3)
      expect(DEFAULT_CAPTURE_PRIORITY.snapshot).toBe(3)
      expect(DEFAULT_CAPTURE_PRIORITY.embed).toBe(4)
      expect(DEFAULT_CAPTURE_PRIORITY.face).toBe(4)
      expect(DEFAULT_CAPTURE_PRIORITY.plate).toBe(4)
      expect(DEFAULT_CAPTURE_PRIORITY.other).toBe(4)
    })

    it('deriveFrameDispatchKind picks the highest-priority batch content', () => {
      expect(
        deriveFrameDispatchKind({
          hasFirstFrame: true,
          hasThumbnail: true,
          hasLastFrame: true,
          hasSnapshot: true,
        }),
      ).toBe('firstFrame')
      expect(
        deriveFrameDispatchKind({
          hasFirstFrame: false,
          hasThumbnail: true,
          hasLastFrame: true,
          hasSnapshot: true,
        }),
      ).toBe('thumbnail')
      expect(
        deriveFrameDispatchKind({
          hasFirstFrame: false,
          hasThumbnail: false,
          hasLastFrame: true,
          hasSnapshot: false,
        }),
      ).toBe('lastFrame')
      expect(
        deriveFrameDispatchKind({
          hasFirstFrame: false,
          hasThumbnail: false,
          hasLastFrame: false,
          hasSnapshot: true,
        }),
      ).toBe('snapshot')
      expect(
        deriveFrameDispatchKind({
          hasFirstFrame: false,
          hasThumbnail: false,
          hasLastFrame: false,
          hasSnapshot: false,
        }),
      ).toBe('timeline')
    })
  })
})

/**
 * ADMISSION CONTROL — the bound that was missing.
 *
 * `staleAfterMs` is evaluated at DEQUEUE time, and `pump` only dequeues while
 * `inFlight < budget`. A lane that stays saturated therefore never looks at its
 * queue at all: nothing is dropped, nothing is even inspected, and the queue is
 * the only unbounded structure in this file.
 *
 * That is not an abstract bound. The per-frame batch dispatch PINS a ~0.7 MB
 * copy of the detection frame BEFORE it queues (so ring recycling cannot
 * invalidate it), and the queued closure holds that copy. Its call site's own
 * comment claimed the pin was "bounded by the lane" — the lane bounds
 * IN-FLIGHT, never the queue. Measured on the live hub: `hub/pipeline-analytics`
 * at rss=3911MB with heapUsed=153MB and arrayBuffers=2281MB — 2.28 GB of
 * JS-reachable Buffers, ~3 200 pinned frames' worth, in a runner whose heap
 * limit is 1216 MB.
 *
 * So the queue needs a bound enforced where entries ARRIVE, not where they
 * leave.
 */
describe('CaptureScheduler — the queue is bounded at admission', () => {
  it('sheds stale entries on enqueue, without waiting for a free budget slot', async () => {
    const entries: LoggedEntry[] = []
    let clock = 0
    const scheduler = new CaptureScheduler({
      logger: stubLogger(entries),
      maxInFlightPerDevice: 1,
      now: () => clock,
    })
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 7, kind: 'thumbnail', exec: () => blocker.promise })

    const stale = scheduler.request({
      deviceId: 7,
      kind: 'thumbnail',
      staleAfterMs: 3_000,
      exec: () => Promise.resolve('never'),
    })
    expect(scheduler.queueDepth(7)).toBe(1)

    // The lane never frees a slot; only an enqueue happens.
    clock += 5_000
    void scheduler.request({
      deviceId: 7,
      kind: 'thumbnail',
      staleAfterMs: 3_000,
      exec: () => Promise.resolve('fresh'),
    })

    await expect(stale).resolves.toBeNull()
    expect(scheduler.queueDepth(7)).toBe(1)
    expect(scheduler.counters(7)?.droppedStale).toBe(1)
  })

  it('caps queue depth per device and sheds the LEAST important queued work', async () => {
    const entries: LoggedEntry[] = []
    const scheduler = new CaptureScheduler({
      logger: stubLogger(entries),
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice: 3,
      now: () => 0,
    })
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 7, kind: 'thumbnail', exec: () => blocker.promise })

    // `embed` is priority 4, `firstFrame` is 0 — the embeds must be the victims.
    const embeds = [0, 1, 2].map(() =>
      scheduler.request({ deviceId: 7, kind: 'embed', exec: () => Promise.resolve('embed') }),
    )
    expect(scheduler.queueDepth(7)).toBe(3)

    void scheduler.request({ deviceId: 7, kind: 'firstFrame', exec: () => Promise.resolve('ff') })

    expect(scheduler.queueDepth(7)).toBe(3)
    await expect(embeds[2]).resolves.toBeNull()
    expect(scheduler.counters(7)?.droppedOverflow).toBe(1)
  })

  it('says so when it sheds — a dropped capture is never silent', async () => {
    const entries: LoggedEntry[] = []
    const scheduler = new CaptureScheduler({
      logger: stubLogger(entries),
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice: 1,
      now: () => 0,
    })
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 7, kind: 'thumbnail', exec: () => blocker.promise })
    void scheduler.request({ deviceId: 7, kind: 'embed', exec: () => Promise.resolve('a') })
    void scheduler.request({ deviceId: 7, kind: 'embed', exec: () => Promise.resolve('b') })

    const warned = entries.find((e) => e.level === 'warn' && e.message.includes('capture queue'))
    expect(warned).toBeDefined()
    expect(warned?.extras).toMatchObject({ tags: { deviceId: 7 } })
  })

  /**
   * The warn is throttled to one line per device per minute, and a shed happens
   * ONE entry at a time — so the line reported `shed: 1` on every saturated
   * camera, forever. Live hub 2026-08-30: 272 lines in 24 h against 6 415
   * `droppedOverflow`, i.e. the only signal an operator had was ~24× too small.
   * The throttle is right; the count has to be the interval's.
   */
  it('reports the INTERVAL’s shed count, not the one call that broke the throttle', async () => {
    const entries: LoggedEntry[] = []
    let clock = 0
    const scheduler = new CaptureScheduler({
      logger: stubLogger(entries),
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice: 1,
      now: () => clock,
    })
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 104, kind: 'thumbnail', exec: () => blocker.promise })
    // Fills the one queue slot; nothing shed yet.
    void scheduler.request({ deviceId: 104, kind: 'embed', exec: () => Promise.resolve('held') })

    // First shed: a new condition, reported immediately, count 1.
    void scheduler.request({ deviceId: 104, kind: 'embed', exec: () => Promise.resolve('s1') })
    const first = entries.filter((e) => e.message.includes('capture queue full'))
    expect(first).toHaveLength(1)
    expect(first[0]?.extras).toMatchObject({ meta: { shed: 1 } })

    // 41 more sheds inside the throttle window: silent, but COUNTED.
    for (let i = 0; i < 41; i += 1) {
      clock += 1_000
      void scheduler.request({ deviceId: 104, kind: 'embed', exec: () => Promise.resolve('sN') })
    }
    expect(entries.filter((e) => e.message.includes('capture queue full'))).toHaveLength(1)
    expect(scheduler.counters(104)?.droppedOverflow).toBe(42)

    // The throttle reopens; the line carries every shed since the last one.
    clock += 30_000
    void scheduler.request({ deviceId: 104, kind: 'embed', exec: () => Promise.resolve('last') })
    const lines = entries.filter((e) => e.message.includes('capture queue full'))
    expect(lines).toHaveLength(2)
    expect(lines[1]?.extras).toMatchObject({
      tags: { deviceId: 104 },
      meta: { shed: 42, windowSec: 71 },
    })
  })

  /**
   * The one number that says WEDGED rather than merely busy. Establishing it by
   * hand cost three hours on 2026-08-30; on the line it is a glance.
   */
  it('reports how much of the shedding lane can never expire', async () => {
    const entries: LoggedEntry[] = []
    const scheduler = new CaptureScheduler({
      logger: stubLogger(entries),
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice: 2,
      now: () => 0,
    })
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 104, kind: 'thumbnail', exec: () => blocker.promise })
    // One entry with a deadline, one without — the second is the wedge.
    void scheduler.request({
      deviceId: 104,
      kind: 'embed',
      staleAfterMs: 3_000,
      exec: () => Promise.resolve('expirable'),
    })
    void scheduler.request({
      deviceId: 104,
      kind: 'confirm',
      exec: () => Promise.resolve('unexpirable'),
    })
    void scheduler.request({ deviceId: 104, kind: 'embed', exec: () => Promise.resolve('shed') })

    const warned = entries.find((e) => e.message.includes('capture queue full'))
    expect(warned?.extras).toMatchObject({
      tags: { deviceId: 104 },
      meta: { queueDepth: 2, unexpirable: 1 },
    })
  })
})

/**
 * The queue mechanic behind `keyFrame:overflow`.
 *
 * `insertByPriority` puts a lower-priority arrival at the TAIL and `shedToCap`
 * sheds the tail — so a lane whose head is high-priority work sheds every new
 * arrival ON ADMISSION. That is survivable while the head is LIVE work that
 * will drain. It is unrecoverable when the head cannot expire: nothing removes
 * it, and every keyFrame / thumbnail / face / plate for that camera is shed the
 * instant it is asked for. `confirm` was exactly that entry until its caller's
 * deadline was passed through (see `pipeline-analytics/index.ts` `fetchCrop`).
 */
describe('CaptureScheduler — an unexpirable head starves the whole lane', () => {
  function saturatedLane(headStaleAfterMs: number | undefined): {
    scheduler: CaptureScheduler
    setClock: (ms: number) => void
  } {
    let clock = 0
    const scheduler = new CaptureScheduler({
      logger: stubLogger([]),
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice: 3,
      now: () => clock,
    })
    // One exec occupies the only slot for the whole test: the lane never pumps,
    // so the queue is only ever touched at ADMISSION — the production shape.
    void scheduler.request({
      deviceId: 104,
      kind: 'thumbnail',
      exec: () => deferred<string>().promise,
    })
    for (let i = 0; i < 3; i += 1) {
      void scheduler.request({
        deviceId: 104,
        trackId: `c-${i}`,
        kind: 'confirm',
        ...(headStaleAfterMs !== undefined ? { staleAfterMs: headStaleAfterMs } : {}),
        exec: () => Promise.resolve('confirm'),
      })
    }
    return {
      scheduler,
      setClock: (ms) => {
        clock = ms
      },
    }
  }

  it('WITHOUT a deadline on the head, a later keyFrame is shed the moment it is asked for', async () => {
    const { scheduler, setClock } = saturatedLane(undefined)
    // Long past any plausible deadline — it makes no difference, because
    // `dropExpired` cannot touch an entry that has none.
    setClock(60_000)
    const keyFrame = scheduler.request({
      deviceId: 104,
      trackId: 't-key',
      kind: 'keyFrame',
      exec: () => Promise.resolve('key'),
    })
    await expect(keyFrame).resolves.toBeNull()
    expect(scheduler.counters(104)?.droppedOverflow).toBe(1)
    expect(scheduler.counters(104)?.droppedStale).toBe(0)
    expect(scheduler.queueDepth(104)).toBe(3)
  })

  it('WITH the caller’s deadline on the head, the same keyFrame is admitted', async () => {
    const { scheduler, setClock } = saturatedLane(300)
    setClock(60_000)
    const keyFrame = scheduler.request({
      deviceId: 104,
      trackId: 't-key',
      kind: 'keyFrame',
      exec: () => Promise.resolve('key'),
    })
    // The three abandoned confirms were reclaimed at admission; the keyFrame is
    // queued, not shed, and will run the moment the lane frees a slot.
    expect(scheduler.counters(104)?.droppedStale).toBe(3)
    expect(scheduler.counters(104)?.droppedOverflow).toBe(0)
    expect(scheduler.queueDepth(104)).toBe(1)
    await Promise.race([keyFrame, Promise.resolve('still-queued')]).then((v) =>
      expect(v).toBe('still-queued'),
    )
  })
})

/**
 * D276/B2 — dropped-without-exec requests carry their per-track identity to
 * the observer, so a close without a tile can say WHICH track starved and how
 * (`thumbnail:overflow` vs `keyframe:stale`), instead of an unexplained
 * `no-key-frame`. The windowed counters aggregate; the callback identifies.
 */
describe('CaptureScheduler — onDropped notice (D276/B2)', () => {
  function makeWithDrops(maxQueuedPerDevice: number): {
    scheduler: CaptureScheduler
    drops: CaptureDropNotice[]
    setClock: (ms: number) => void
  } {
    const drops: CaptureDropNotice[] = []
    let clock = 0
    const scheduler = new CaptureScheduler({
      logger: stubLogger([]),
      maxInFlightPerDevice: 1,
      maxQueuedPerDevice,
      now: () => clock,
      onDropped: (drop) => drops.push(drop),
    })
    return {
      scheduler,
      drops,
      setClock: (ms) => {
        clock = ms
      },
    }
  }

  it('a stale expiry reports {trackId, kind, cause: stale}', async () => {
    const { scheduler, drops, setClock } = makeWithDrops(24)
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 108, kind: 'thumbnail', exec: () => blocker.promise })
    const stale = scheduler.request({
      deviceId: 108,
      trackId: 't-stale',
      kind: 'thumbnail',
      staleAfterMs: 3_000,
      exec: () => Promise.resolve('never'),
    })
    setClock(5_000)
    void scheduler.request({ deviceId: 108, kind: 'thumbnail', exec: () => Promise.resolve('x') })
    await expect(stale).resolves.toBeNull()
    expect(drops).toEqual([
      { deviceId: 108, trackId: 't-stale', kind: 'thumbnail', cause: 'stale' },
    ])
  })

  it('an overflow shed reports {trackId, kind, cause: overflow}', async () => {
    const { scheduler, drops } = makeWithDrops(1)
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 108, kind: 'thumbnail', exec: () => blocker.promise })
    void scheduler.request({
      deviceId: 108,
      trackId: 't-q',
      kind: 'keyFrame',
      exec: () => Promise.resolve('queued'),
    })
    const shedVictim = scheduler.request({
      deviceId: 108,
      trackId: 't-shed',
      kind: 'embed',
      exec: () => Promise.resolve('shed'),
    })
    await expect(shedVictim).resolves.toBeNull()
    expect(drops).toEqual([{ deviceId: 108, trackId: 't-shed', kind: 'embed', cause: 'overflow' }])
  })

  it('a cancel (track closed) is NOT reported — the track wants nothing', async () => {
    const { scheduler, drops } = makeWithDrops(24)
    const blocker = deferred<string>()
    void scheduler.request({ deviceId: 108, kind: 'thumbnail', exec: () => blocker.promise })
    const queued = scheduler.request({
      deviceId: 108,
      trackId: 't-cancel',
      kind: 'keyFrame',
      exec: () => Promise.resolve('queued'),
    })
    scheduler.cancelForTrack('t-cancel')
    await expect(queued).resolves.toBeNull()
    expect(drops).toEqual([])
  })
})
