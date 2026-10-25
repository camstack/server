/**
 * D666 — the worker's exit routing when its parent, or its stdio, is lost.
 *
 * REAL timers throughout, on purpose. The D652 tests drove this exit with fake
 * timers, and a fake clock always reaches its timers — so they could not see
 * a worker whose event loop never did: an EPIPE on a dead stderr raised an
 * uncaught exception, reporting it wrote to stderr again, and the loop spun
 * in the check phase forever with the 250 ms exit timer never firing.
 * "Same turn" below means before ANY timer or I/O callback could run.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FAULT_REPORT_LIMIT,
  FAULT_REPORT_WINDOW_MS,
  FaultReporter,
  OutboundSendTracker,
  type WorkerExitEvent,
  type WorkerExitFn,
  createWorkerExit,
  wireWorkerExit,
} from '../bounded-exit.js'
import { type ParentPidSource, watchParentPid } from '../decode-worker-process.js'

interface WireOptions {
  readonly parentConnected: boolean
  readonly reportThrows?: boolean
}

interface Wired {
  readonly fire: (event: WorkerExitEvent, arg?: unknown) => void
  readonly exitWorker: ReturnType<typeof vi.fn<WorkerExitFn>>
  readonly report: ReturnType<typeof vi.fn>
  readonly onStdioLost: ReturnType<typeof vi.fn>
  readonly setConnected: (connected: boolean) => void
}

function wire(opts: WireOptions): Wired {
  const listeners = new Map<WorkerExitEvent, Array<(arg: unknown) => void>>()
  const exitWorker = vi.fn<WorkerExitFn>()
  const report = vi.fn(() => {
    if (opts.reportThrows) throw new Error('write EPIPE')
  })
  const onStdioLost = vi.fn()
  let connected = opts.parentConnected
  wireWorkerExit({
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    exitWorker,
    faults: new FaultReporter(report, () => undefined),
    onStdioLost,
    parentConnected: () => connected,
  })
  return {
    fire: (event, arg) => {
      for (const listener of listeners.get(event) ?? []) listener(arg)
    },
    exitWorker,
    report,
    onStdioLost,
    setConnected: (value) => {
      connected = value
    },
  }
}

/** A tracker with a send whose callback never comes — `whenIdle` would wait out its bound. */
function stuckSends(): OutboundSendTracker {
  const sends = new OutboundSendTracker()
  sends.begin()
  return sends
}

describe('stdio lost is never an uncaught exception (F1)', () => {
  it('parent gone as well: exits 0, now; the loss is handled once for two failing streams', () => {
    const w = wire({ parentConnected: false })
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    w.fire('stdioLost', epipe)
    w.fire('stdioLost', epipe)
    expect(w.onStdioLost).toHaveBeenCalledExactlyOnceWith(epipe)
    expect(w.exitWorker).toHaveBeenNthCalledWith(1, 0, 'now')
    expect(w.report).not.toHaveBeenCalled()
  })

  it('channel still up: says so once and KEEPS RUNNING — it exits on the later disconnect', () => {
    const w = wire({ parentConnected: true })
    w.fire('stdioLost', new Error('write EPIPE'))
    w.fire('stdioLost', new Error('write EPIPE'))
    expect(w.onStdioLost).toHaveBeenCalledTimes(1)
    expect(w.exitWorker).not.toHaveBeenCalled()
    w.setConnected(false)
    w.fire('disconnect')
    expect(w.exitWorker).toHaveBeenCalledExactlyOnceWith(0, 'now')
  })
})

describe('faults are reported, rate-limited, and reporting never loops (F2)', () => {
  it('three uncaught errors: each reported, exit 1 each time — the later ones NOW', () => {
    const w = wire({ parentConnected: true })
    w.fire('uncaughtException', new Error('a'))
    w.fire('uncaughtException', new Error('b'))
    w.fire('uncaughtException', new Error('c'))
    expect(w.report).toHaveBeenCalledTimes(3)
    expect(w.exitWorker.mock.calls).toEqual([
      [1, 'flush'],
      [1, 'now'],
      [1, 'now'],
    ])
  })

  it('a report that throws is swallowed, not rethrown as the next uncaught error', () => {
    const w = wire({ parentConnected: false, reportThrows: true })
    expect(() => w.fire('uncaughtException', new Error('boom'))).not.toThrow()
    expect(() => w.fire('unhandledRejection', new Error('boom'))).not.toThrow()
    expect(w.report).toHaveBeenCalledTimes(2)
    expect(w.exitWorker).toHaveBeenCalledWith(1, 'flush')
  })

  it('every unhandled rejection is reported and none ends the worker', () => {
    const w = wire({ parentConnected: true })
    w.fire('unhandledRejection', new Error('a'))
    w.fire('unhandledRejection', new Error('b'))
    expect(w.report).toHaveBeenCalledTimes(2)
    expect(w.report).toHaveBeenLastCalledWith('unhandledRejection', expect.any(Error))
    expect(w.exitWorker).not.toHaveBeenCalled()
  })

  it(`at most ${FAULT_REPORT_LIMIT} per window; the rest are one suppressed-count line, once`, () => {
    let now = 1_000
    const report = vi.fn()
    const suppressed = vi.fn()
    const faults = new FaultReporter(report, suppressed, () => now)
    for (let i = 0; i < FAULT_REPORT_LIMIT + 3; i += 1) faults.fault('unhandledRejection', i)
    expect(report).toHaveBeenCalledTimes(FAULT_REPORT_LIMIT)
    faults.flushSuppressed()
    faults.flushSuppressed()
    expect(suppressed).toHaveBeenCalledExactlyOnceWith(3)
    // A new window reports again.
    now += FAULT_REPORT_WINDOW_MS
    expect(faults.fault('unhandledRejection', 'late')).toBe(true)
    expect(report).toHaveBeenCalledTimes(FAULT_REPORT_LIMIT + 1)
  })
})

describe('parent loss exits in the SAME turn, with real timers (F3)', () => {
  it('disconnect and a changed ppid route to an exit NOW', () => {
    const w = wire({ parentConnected: false })
    w.fire('disconnect')
    w.fire('parentChanged', 1)
    expect(w.exitWorker.mock.calls).toEqual([
      [0, 'now'],
      [0, 'now'],
    ])
  })

  it("an exit 'now' calls exit synchronously even with a send that will never complete", () => {
    const exit = vi.fn()
    const order: string[] = []
    const exitWorker = createWorkerExit({
      sends: stuckSends(),
      steps: {
        quiesce: () => order.push('quiesce'),
        flushFinalLines: () => order.push('flush'),
      },
      exit: (code) => {
        order.push('exit')
        exit(code)
      },
    })
    exitWorker(0, 'now')
    // No await, no timer: a starved loop would never get further than this.
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(order).toEqual(['quiesce', 'flush', 'exit'])
  })

  it("a flush waiting on its bound is cut short by a later 'now' — and exits once", async () => {
    const exit = vi.fn()
    const exitWorker = createWorkerExit({
      sends: stuckSends(),
      steps: { quiesce: () => undefined, flushFinalLines: () => undefined },
      exit,
      boundMs: 60_000,
    })
    exitWorker(0, 'flush')
    expect(exit).not.toHaveBeenCalled()
    // The parent goes while the lines are still queued.
    exitWorker(0, 'now')
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    exitWorker(0, 'now')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('a second SIGTERM exits now; the first flushes', () => {
    const w = wire({ parentConnected: true })
    w.fire('SIGTERM')
    w.fire('SIGTERM')
    expect(w.exitWorker.mock.calls).toEqual([
      [0, 'flush'],
      [0, 'now'],
    ])
  })
})

/** A parent pid the test can change. */
class MutablePpid implements ParentPidSource {
  constructor(public ppid: number) {}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('the ppid watchdog (F4)', () => {
  it('fires once when the ppid changes — an orphan adopted by init, tini or a subreaper', async () => {
    const proc = new MutablePpid(4242)
    const onChanged = vi.fn()
    const stop = watchParentPid(proc, onChanged, 10)
    await sleep(40)
    expect(onChanged).not.toHaveBeenCalled()
    proc.ppid = 1
    await sleep(40)
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(1)
    stop()
  })
})
