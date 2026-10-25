/**
 * D652 round 3 — the worker's exit cannot be stopped, and nothing native is
 * freed once it has begun, by ANY path.
 *
 * Round 2 pinned the exit path with a source scan of two function bodies. A
 * reviewer defeated it with one level of indirection: `degradeToSoftware()`
 * closes `hwFilter`. Every native dispose now goes through ONE door, the
 * `NativeDisposer`, which refuses once the exit began — and these tests drive
 * the real worker class (constructible without node-av since the class moved
 * out of the process entry) against a spy on that door.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OutboundSendTracker,
  WORKER_EXIT_FLUSH_BOUND_MS,
  type WorkerExitEvent,
  createWorkerExit,
  FaultReporter,
  wireWorkerExit,
} from '../bounded-exit.js'
import { DecodeWorkerChild } from '../decode-worker-child.js'
import { NativeDisposer } from '../native-disposer.js'

interface Closable {
  close: ReturnType<typeof vi.fn>
}
interface Disposable {
  [Symbol.dispose]: ReturnType<typeof vi.fn>
}

/**
 * The worker's private native handles, reached across ONE documented test
 * boundary: they are only ever set by node-av, which a test cannot load.
 */
interface WorkerInternals {
  hwFilter: Closable | null
  hwFilterDecision: 'undecided' | 'hardware' | 'software'
  nativeCropHwFilter: Closable | null
  nativeLeaseDownloadFilter: Closable | null
  decoder: Disposable | null
  demuxer: Disposable | null
  degradeToSoftware(): void
  closeInput(): void
  send(reply: unknown): void
}

function internalsOf(worker: DecodeWorkerChild): WorkerInternals {
  return worker as unknown as WorkerInternals
}

function armNativeHandles(w: WorkerInternals) {
  const handles = {
    hwFilter: { close: vi.fn() },
    nativeCropHwFilter: { close: vi.fn() },
    nativeLeaseDownloadFilter: { close: vi.fn() },
    decoder: { [Symbol.dispose]: vi.fn() },
    demuxer: { [Symbol.dispose]: vi.fn() },
  }
  w.hwFilter = handles.hwFilter
  w.hwFilterDecision = 'hardware'
  w.nativeCropHwFilter = handles.nativeCropHwFilter
  w.nativeLeaseDownloadFilter = handles.nativeLeaseDownloadFilter
  w.decoder = handles.decoder
  w.demuxer = handles.demuxer
  return handles
}

function makeWorker() {
  const disposer = new NativeDisposer()
  const run = vi.spyOn(disposer, 'run')
  const worker = new DecodeWorkerChild({ disposer })
  const w = internalsOf(worker)
  const sent = vi.spyOn(w, 'send').mockImplementation(() => undefined)
  vi.spyOn(worker, 'emitStderr').mockImplementation(() => undefined)
  return { worker, w, disposer, run, sent }
}

describe('the native disposer is the one door, and it closes at exit (item 3)', () => {
  it('control: BEFORE the exit, degradeToSoftware closes hwFilter through the door', () => {
    const { w, run } = makeWorker()
    const h = armNativeHandles(w)
    w.degradeToSoftware()
    expect(run).toHaveBeenCalledWith('hwFilter', expect.any(Function))
    expect(h.hwFilter.close).toHaveBeenCalledTimes(1)
  })

  it('AFTER the exit began, degradeToSoftware reaches the door and is refused — hwFilter is not closed', () => {
    const { worker, w, run, disposer } = makeWorker()
    worker.quiesceForExit()
    const h = armNativeHandles(w)
    w.degradeToSoftware()
    expect(run).toHaveBeenCalledWith('hwFilter', expect.any(Function))
    expect(h.hwFilter.close).not.toHaveBeenCalled()
    expect(disposer.refusedCount).toBe(1)
  })

  it('AFTER the exit began, a re-dial cleanup frees NOTHING native', () => {
    const { worker, w } = makeWorker()
    worker.quiesceForExit()
    const h = armNativeHandles(w)
    w.closeInput()
    expect(h.hwFilter.close).not.toHaveBeenCalled()
    expect(h.nativeCropHwFilter.close).not.toHaveBeenCalled()
    expect(h.nativeLeaseDownloadFilter.close).not.toHaveBeenCalled()
    expect(h.decoder[Symbol.dispose]).not.toHaveBeenCalled()
    expect(h.demuxer[Symbol.dispose]).not.toHaveBeenCalled()
  })

  it('AFTER the exit began, a toBuffer is refused at the handler — it never reaches native work', () => {
    const { worker, w, sent, run } = makeWorker()
    worker.quiesceForExit()
    armNativeHandles(w)
    run.mockClear()
    worker.handleMessage({ kind: 'toBuffer', frameId: 7 })
    worker.handleMessage({
      kind: 'nativeCrop',
      requestId: 3,
      frameId: 7,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    })
    expect(run).not.toHaveBeenCalled()
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        frameId: 7,
        message: expect.stringContaining('exiting'),
      }),
    )
    expect(sent).toHaveBeenCalledWith({
      kind: 'nativeCropMiss',
      requestId: 3,
      reason: 'worker exiting',
    })
  })
})

describe('the exit is ALWAYS scheduled, even when a step throws (item 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const event of ['SIGTERM', 'disconnect'] as const) {
    it(`quiesce throws on ${event}: the worker still exits, with code 1, within the bound`, async () => {
      const listeners = new Map<WorkerExitEvent, (arg: unknown) => void>()
      const exit = vi.fn()
      const exitWorker = createWorkerExit({
        sends: new OutboundSendTracker(),
        steps: {
          quiesce: () => {
            throw new Error('quiesce blew up')
          },
          flushFinalLines: () => undefined,
        },
        exit,
      })
      wireWorkerExit({
        on: (e, l) => listeners.set(e, l),
        exitWorker,
        faults: new FaultReporter(
          () => undefined,
          () => undefined,
        ),
        onStdioLost: () => undefined,
        parentConnected: () => true,
      })
      listeners.get(event)?.(undefined)
      // The uncaught handler's own exit request must not be what saves it.
      listeners.get('uncaughtException')?.(new Error('quiesce blew up'))
      await vi.advanceTimersByTimeAsync(WORKER_EXIT_FLUSH_BOUND_MS)
      expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    })
  }

  // The two cases above run with NOTHING in flight, so `whenIdle` resolves at
  // once and the bound is never exercised on the throwing path. A line queued
  // by the worker before quiesce blew up must not hold the process open.
  it('quiesce throws with a line still in flight: the exit fires at the bound, not before, not never', async () => {
    const sends = new OutboundSendTracker()
    sends.begin() // a send whose callback never comes
    const exit = vi.fn()
    createWorkerExit({
      sends,
      steps: {
        quiesce: () => {
          throw new Error('quiesce blew up')
        },
        flushFinalLines: () => undefined,
      },
      exit,
    })(0)
    await vi.advanceTimersByTimeAsync(WORKER_EXIT_FLUSH_BOUND_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('a throwing flush still exits, and a clean exit keeps its code', async () => {
    const exit = vi.fn()
    createWorkerExit({
      sends: new OutboundSendTracker(),
      steps: {
        quiesce: () => undefined,
        flushFinalLines: () => {
          throw new Error('flush blew up')
        },
      },
      exit,
    })(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)

    const clean = vi.fn()
    createWorkerExit({
      sends: new OutboundSendTracker(),
      steps: { quiesce: () => undefined, flushFinalLines: () => undefined },
      exit: clean,
    })(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(clean).toHaveBeenCalledExactlyOnceWith(0)
  })
})
