/**
 * D666 — a runner that ends leaves no decode worker behind.
 *
 * On the Mac agent a TERM to the server let every runner run its graceful
 * shutdown and `process.exit(0)` — and every decode worker survived it,
 * reparented to PID 1: 17 of them, 3.7 GB RSS, 641 % CPU, each still pulling
 * its camera's RTSP. Nothing on the shutdown path had killed them, and every
 * kill path lives in the parent.
 *
 * A REAL process tree: a runner fixture forks a worker that never ends on its
 * own through the real runner wiring, then ends the two ways a runner does —
 * gracefully, and by an uncaught error that never reaches `onShutdown`. The
 * worker must be gone either way.
 */
import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChildCostRegistry } from '@camstack/types/node'
import type { ForkDecodeWorkerDeps } from '../fork-decode-worker.js'
import {
  type ExitHookProcess,
  type LiveDecodeWorker,
  LiveDecodeWorkers,
  RunnerDecodeWorkers,
} from '../live-decode-workers.js'
import type { ForkedChildLike } from '../session-decode-coordinator.js'

/**
 * A nested `tsx` fork (runner → stub) takes seconds to start on a loaded CI
 * runner: the wait for the stub is generous, and the test timeout covers it.
 * The 2 s "gone" bound is measured from the kill, not from the start.
 */
const STARTUP_BOUND_MS = 30_000
const PROCESS_TEST_TIMEOUT_MS = 40_000

const RUNNER = fileURLToPath(new URL('./fixtures/shutdown-runner-entry.ts', import.meta.url))

const survivors: number[] = []
const runners: ChildProcess[] = []

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

function stubPidOf(runner: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stub never came up')), STARTUP_BOUND_MS)
    runner.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      if (!('kind' in message) || message.kind !== 'stub-up') return
      if (!('pid' in message) || typeof message.pid !== 'number') return
      clearTimeout(timer)
      resolve(message.pid)
    })
  })
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

interface StartedRunner {
  readonly runner: ChildProcess
  readonly stubPid: number
}

type RunnerMode = 'graceful' | 'crash'

async function startRunner(mode: RunnerMode): Promise<StartedRunner> {
  const runner = fork(RUNNER, [mode], {
    execArgv: ['--import', 'tsx'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  runners.push(runner)
  const stubPid = await stubPidOf(runner)
  survivors.push(stubPid)
  expect(isAlive(stubPid)).toBe(true)
  return { runner, stubPid }
}

afterEach(() => {
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  for (const runner of runners.splice(0)) runner.kill('SIGKILL')
})

describe('the runner kills its decode workers when it ends (D666)', () => {
  it(
    'a graceful runner exit leaves no worker alive — gone within 2 s',
    async () => {
      const { runner, stubPid } = await startRunner('graceful')
      runner.kill('SIGTERM')
      expect(await exitOf(runner)).toBe(0)
      // The server that read the runner's stdio is gone too (the Mac's Test B).
      runner.stdout?.destroy()
      runner.stderr?.destroy()
      expect(await goneWithin(stubPid, 2000)).toBe(true)
    },
    PROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'a runner that CRASHES (uncaught → exit 1, no onShutdown) leaves no worker alive',
    async () => {
      const { runner, stubPid } = await startRunner('crash')
      runner.send({ kind: 'crash' })
      expect(await exitOf(runner)).toBe(1)
      runner.stdout?.destroy()
      runner.stderr?.destroy()
      expect(await goneWithin(stubPid, 2000)).toBe(true)
    },
    PROCESS_TEST_TIMEOUT_MS,
  )
})

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() }
}

interface FakeWorker extends LiveDecodeWorker {
  readonly killNow: ReturnType<typeof vi.fn>
}

function fakeWorker(deviceId: number, pid: number): FakeWorker {
  return { deviceId, pid, killNow: vi.fn() }
}

describe('LiveDecodeWorkers', () => {
  it('kills every tracked worker once, one line per camera, and forgets exited ones', () => {
    const workers = new LiveDecodeWorkers()
    const a = fakeWorker(101, 101)
    const b = fakeWorker(102, 104)
    const exited = fakeWorker(104, 103)
    workers.add(a)
    workers.add(b)
    workers.add(exited)()
    const logger = makeLogger()

    expect(workers.killAll('shutdown', logger)).toBe(2)
    expect(a.killNow).toHaveBeenCalledTimes(1)
    expect(b.killNow).toHaveBeenCalledTimes(1)
    expect(exited.killNow).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('session-decode: worker killed at shutdown', {
      tags: { deviceId: 101 },
      meta: { pid: 101, signal: 'SIGKILL', reason: 'shutdown' },
    })
    // Killed workers are forgotten: a second pass (the exit hook) logs nothing twice.
    expect(workers.killAll('process-exit', logger)).toBe(0)
    expect(logger.info).toHaveBeenCalledTimes(2)
  })

  it('a kill that throws is named per camera and does not stop the others', () => {
    const workers = new LiveDecodeWorkers()
    const ok = fakeWorker(102, 102)
    workers.add({
      deviceId: 101,
      pid: 101,
      killNow: () => {
        throw new Error('EPERM')
      },
    })
    workers.add(ok)
    const logger = makeLogger()
    workers.killAll('shutdown', logger)
    expect(ok.killNow).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('kill failed'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('a logger that throws stops no kill, and no worker is lost (review N1)', () => {
    const workers = new LiveDecodeWorkers()
    const all = [fakeWorker(101, 101), fakeWorker(102, 102), fakeWorker(104, 103)]
    for (const worker of all) workers.add(worker)
    // The exit hook runs while the transport goes down: writes can throw.
    const throwing = {
      info: vi.fn(() => {
        throw new Error('EPIPE')
      }),
      warn: vi.fn(() => {
        throw new Error('EPIPE')
      }),
    }
    expect(() => workers.killAll('process-exit', throwing)).not.toThrow()
    for (const worker of all) expect(worker.killNow).toHaveBeenCalledTimes(1)
    // A line was attempted for every worker, not just the first.
    expect(throwing.info).toHaveBeenCalledTimes(3)
    expect(workers.size).toBe(0)
  })

  it('a worker whose kill threw stays tracked, so the next pass retries it', () => {
    const workers = new LiveDecodeWorkers()
    let attempts = 0
    workers.add({
      deviceId: 101,
      pid: 101,
      killNow: () => {
        attempts += 1
        if (attempts === 1) throw new Error('EPERM')
      },
    })
    const logger = makeLogger()
    expect(workers.killAll('shutdown', logger)).toBe(0)
    expect(workers.size).toBe(1)
    expect(workers.killAll('process-exit', logger)).toBe(1)
    expect(attempts).toBe(2)
    expect(workers.size).toBe(0)
  })

  it('after close, a worker is killed as it is added — a burst forked during shutdown', () => {
    const workers = new LiveDecodeWorkers()
    const logger = makeLogger()
    workers.close('shutdown', logger)
    const late = fakeWorker(101, 105)
    workers.add(late)
    expect(late.killNow).toHaveBeenCalledTimes(1)
    expect(workers.size).toBe(0)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('forked after shutdown began'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })
})

/** An `ExitHookProcess` whose listeners the test can fire. */
class FakeExitHook implements ExitHookProcess {
  readonly listeners = new Set<() => void>()
  once(_event: 'exit', listener: () => void): this {
    this.listeners.add(listener)
    return this
  }
  removeListener(_event: 'exit', listener: () => void): this {
    this.listeners.delete(listener)
    return this
  }
  exit(): void {
    for (const listener of [...this.listeners]) {
      this.listeners.delete(listener)
      listener()
    }
  }
}

interface TrackedFork {
  readonly deps: ForkDecodeWorkerDeps
  readonly worker: FakeWorker
}

function runnerWith(hook: FakeExitHook) {
  const tracked: TrackedFork[] = []
  const child: ForkedChildLike = {
    send: () => undefined,
    on: () => undefined,
    kill: () => undefined,
  }
  const logger = makeLogger()
  const workers = new RunnerDecodeWorkers({
    fork: (source, deps) => {
      const worker = fakeWorker(source.deviceId, 200 + tracked.length)
      deps.liveWorkers?.add(worker)
      tracked.push({ deps, worker })
      return child
    },
    costRegistry: new ChildCostRegistry(),
    logger,
    process: hook,
  })
  return { workers, tracked, logger }
}

const SOURCE = { restreamUrl: 'rtsp://x/1', deviceId: 101, codec: 'h264' }

describe('RunnerDecodeWorkers — the runner wiring', () => {
  it('a shutdown whose kill failed keeps the exit hook, which retries it', () => {
    const hook = new FakeExitHook()
    let attempts = 0
    const workers = new RunnerDecodeWorkers({
      fork: (source, deps) => {
        deps.liveWorkers?.add({
          deviceId: source.deviceId,
          pid: 300,
          killNow: () => {
            attempts += 1
            if (attempts === 1) throw new Error('EPERM')
          },
        })
        return { send: () => undefined, on: () => undefined, kill: () => undefined }
      },
      costRegistry: new ChildCostRegistry(),
      logger: makeLogger(),
      process: hook,
    })
    workers.fork(SOURCE)
    expect(workers.shutdown()).toBe(0)
    expect(hook.listeners.size).toBe(1)
    hook.exit()
    expect(attempts).toBe(2)
  })

  it('registers every fork with the set and the cost registry', () => {
    const hook = new FakeExitHook()
    const { workers, tracked } = runnerWith(hook)
    workers.fork(SOURCE)
    expect(tracked[0]?.deps.liveWorkers).toBeInstanceOf(LiveDecodeWorkers)
    expect(tracked[0]?.deps.costRegistry).toBeInstanceOf(ChildCostRegistry)
  })

  it('a process exit that never went through shutdown kills what is left', () => {
    const hook = new FakeExitHook()
    const { workers, tracked } = runnerWith(hook)
    workers.fork(SOURCE)
    expect(hook.listeners.size).toBe(1)
    hook.exit()
    expect(tracked[0]?.worker.killNow).toHaveBeenCalledTimes(1)
  })

  it('shutdown kills now, drops the exit hook, and kills a later fork at once', () => {
    const hook = new FakeExitHook()
    const { workers, tracked } = runnerWith(hook)
    workers.fork(SOURCE)
    expect(workers.shutdown()).toBe(1)
    expect(tracked[0]?.worker.killNow).toHaveBeenCalledTimes(1)
    expect(hook.listeners.size).toBe(0)
    workers.fork({ ...SOURCE, deviceId: 102 })
    expect(tracked[1]?.worker.killNow).toHaveBeenCalledTimes(1)
    expect(hook.listeners.size).toBe(0)
  })
})
