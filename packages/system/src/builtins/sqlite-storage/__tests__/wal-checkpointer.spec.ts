import { EventEmitter } from 'node:events'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WalCheckpointer, type WorkerFactory } from '../wal-checkpointer.js'

/**
 * What the settings thread says about the worker's reports (D452). The thread
 * itself is exercised over the real engine in
 * `wal-checkpointer-over-real-sqlite.spec.ts`; this pins the lines, because
 * the slow-checkpoint WARN is the measurement that replaces the profiler's
 * slow-`set` WARN and a line that is not pinned drifts.
 */

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

function makeLogger(): { logger: IScopedLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  const push =
    (level: LoggedLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      lines.push(extras === undefined ? { level, message } : { level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

/** A worker that never runs: an emitter the spec drives by hand. */
class FakeWorker extends EventEmitter {
  readonly posted: unknown[] = []
  postMessage(message: unknown): void {
    this.posted.push(message)
    // An orderly stop: the thread exits with 0.
    if (
      typeof message === 'object' &&
      message !== null &&
      'kind' in message &&
      message.kind === 'stop'
    ) {
      queueMicrotask(() => this.emit('exit', 0))
    }
  }
}

function harness(): {
  checkpointer: WalCheckpointer
  worker: FakeWorker
  lines: LoggedLine[]
} {
  const worker = new FakeWorker()
  const { logger, lines } = makeLogger()
  // The factory's contract is the structural `CheckpointWorkerHandle`; an
  // EventEmitter with `postMessage` satisfies it without a cast.
  const workerFactory: WorkerFactory = () => worker
  const checkpointer = new WalCheckpointer({
    dbPath: '/nowhere/camstack.db',
    logger,
    slowMs: 1_000,
    workerFactory,
  })
  return { checkpointer, worker, lines }
}

const report = (ms: number, frames = 1000, reason = 'scheduled') => ({
  kind: 'checkpointed',
  reason,
  appendedFrames: frames,
  nextDelayMs: 1_000,
  walFrames: frames,
  checkpointedFrames: frames,
  busy: false,
  ms,
})

describe('WalCheckpointer', () => {
  it('a checkpoint that held the worker past the slow bound is a WARN with its numbers', () => {
    const { checkpointer, worker, lines } = harness()
    checkpointer.start()
    worker.emit('message', report(4_200))
    const warn = lines.find((l) => l.level === 'warn')
    expect(warn?.message).toBe('WAL checkpoint held the worker')
    expect(warn?.extras?.meta).toMatchObject({
      ms: 4_200,
      checkpointedFrames: 1000,
      reason: 'scheduled',
    })
  })

  it('a fast checkpoint is counted, not logged', () => {
    const { checkpointer, worker, lines } = harness()
    checkpointer.start()
    worker.emit('message', report(120))
    worker.emit('message', report(80, 400))
    expect(lines.filter((l) => l.level === 'warn')).toEqual([])
    expect(checkpointer.stats).toMatchObject({ checkpoints: 2, frames: 1400, slow: 0, maxMs: 120 })
  })

  it('an unreadable message is a WARN, never a throw', () => {
    const { checkpointer, worker, lines } = harness()
    checkpointer.start()
    worker.emit('message', { kind: 'checkpointed', ms: 'soon' })
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('unreadable'))).toBe(true)
  })

  it('a pass that found a large backlog is a WARN once per window, the rest counted', () => {
    const { checkpointer, worker, lines } = harness()
    checkpointer.start()
    worker.emit('message', report(50, 6_000))
    worker.emit('message', report(50, 7_000))
    worker.emit('message', report(50, 4_000))
    const warns = lines.filter((l) => l.message === 'WAL checkpoint pass found a large backlog')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras?.meta).toMatchObject({ appendedFrames: 6_000, thresholdFrames: 5_000 })
    expect(checkpointer.stats).toMatchObject({ large: 2, maxAppended: 7_000 })
  })

  it('the first pass is not judged: it counts the WAL it found at boot', () => {
    const { checkpointer, worker, lines } = harness()
    checkpointer.start()
    worker.emit('message', report(50, 12_000, 'first'))
    expect(lines.filter((l) => l.level === 'warn')).toEqual([])
    expect(checkpointer.stats.large).toBe(0)
  })

  it('a worker that dies on its own is an ERROR naming the fallback bound; a stop is not', async () => {
    const dead = harness()
    dead.checkpointer.start()
    dead.worker.emit('exit', 1)
    expect(dead.lines.find((l) => l.level === 'error')?.message).toContain('autocheckpoint bound')
    expect(dead.checkpointer.isRunning()).toBe(false)

    const stopped = harness()
    stopped.checkpointer.start()
    await stopped.checkpointer.stop()
    expect(stopped.worker.posted).toEqual([{ kind: 'stop' }])
    expect(stopped.lines.filter((l) => l.level === 'error')).toEqual([])
  })
})
