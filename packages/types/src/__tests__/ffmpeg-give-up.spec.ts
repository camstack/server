/**
 * Hearing that a child is gone for GOOD.
 *
 * `onExit` fires on every exit, including the ones about to be respawned, so an
 * owner that tore down on it would tear down on the first hiccup. And the
 * `start()` promise cannot answer either: its `reject` is spent the moment the
 * child first goes live, so a give-up after that reached nobody.
 *
 * That gap had a cost. A camera-grid tile whose 4K source ended mid-run took the
 * whole composition down on its FIRST exit, the consumer re-dialled, and the
 * grid sat in a restart loop serving nothing — which the operator saw as the
 * `auto` rung being stuck.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { FfmpegProcess } from '../ffmpeg/process.js'
import type { IScopedLogger } from '../interfaces/logging.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly stdin = null
  readonly stdio = []
  kill = vi.fn()
}

function harness(maxRestarts: number) {
  const spawned: FakeChild[] = []
  const gaveUp: Error[] = []
  const exits: string[] = []
  const process = new FfmpegProcess({
    binaryPath: 'ffmpeg',
    buildArgs: () => ['-i', 'x'],
    decodeHwAccel: null,
    logger: silentLogger(),
    deviceId: 1,
    role: 'test',
    maxRestarts,
    restartDelayMs: 0,
    firstDataTimeoutMs: 0,
    spawnFn: (() => {
      const child = new FakeChild()
      spawned.push(child)
      return child as never
    }) as never,
    onChild: () => {},
    onExit: (exit) => exits.push(exit.classification),
    onGiveUp: (error) => gaveUp.push(error),
  })
  return { process, spawned, gaveUp, exits }
}

describe('onGiveUp', () => {
  it('names the role, so an owner can say WHICH child is gone', async () => {
    const { process, spawned, gaveUp } = harness(0)
    const started = process.start()
    spawned[0]?.stdout.emit('readable')
    await started
    spawned[0]?.emit('exit', 0, null)
    await new Promise((r) => setTimeout(r, 5))
    expect(gaveUp[0]?.message).toContain('test')
  })

  it('stays silent while the wrapper is still restarting', async () => {
    const { process, spawned, gaveUp, exits } = harness(2)
    const started = process.start()
    spawned[0]?.stdout.emit('readable')
    await started
    spawned[0]?.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 5))
    expect(exits).toContain('crashed')
    expect(gaveUp).toHaveLength(0)
  })

  it('fires when a run-to-completion child dies AFTER going live', async () => {
    // The silent path: with restarts disabled, a child that had gone live and
    // then exited used to notify nobody at all.
    const { process, spawned, gaveUp } = harness(0)
    const started = process.start()
    spawned[0]?.stdout.emit('readable')
    await started
    spawned[0]?.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 5))
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]?.message).toMatch(/restarts are disabled/)
  })
})
