/**
 * DerivedFeederController — on-demand feeder lifecycle + bounded restart.
 *
 * The controller owns WHEN a derived stream's transcode feeder runs (only while
 * the broker is demanded) and the give-up/backoff policy when it dies. These
 * tests drive it with an injected `spawn` (returning a real but unconnected
 * DerivedStreamFeeder so no ffmpeg is launched) and a synchronous fake
 * scheduler so restart timing is deterministic.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type ActiveDerivedFeeder,
  DerivedFeederController,
  type RestartTimer,
} from '../derived/derived-feeder-controller.js'
import { DerivedStreamFeeder } from '../derived/derived-stream-feeder.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface SpawnedFeeder {
  readonly active: ActiveDerivedFeeder
  readonly destroy: ReturnType<typeof vi.spyOn>
  readonly release: ReturnType<typeof vi.fn>
  /** Simulate the ffmpeg child exiting (fires the controller's teardown hook). */
  fireExit(): void
}

function makeSpawnedFeeder(onTeardown: () => void): SpawnedFeeder {
  // A real feeder, never connected, so `destroy()` touches no child process.
  const feeder = new DerivedStreamFeeder(
    { ffmpegPath: 'ffmpeg', args: [] },
    { onEncodedPacket: () => {}, onAudioInfo: () => {} },
  )
  const destroy = vi.spyOn(feeder, 'destroy').mockImplementation(() => {})
  const release = vi.fn(() => Promise.resolve())
  return {
    active: { feeder, release },
    destroy,
    release,
    fireExit: onTeardown,
  }
}

/** Flush pending microtasks (the controller's async `spawn`). */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('DerivedFeederController', () => {
  it('spawns a feeder on demand and is single-flight against repeat demand', async () => {
    const spawn = vi.fn((onTeardown: () => void) =>
      Promise.resolve(makeSpawnedFeeder(onTeardown).active),
    )
    const c = new DerivedFeederController({ logger: makeLogger(), spawn })

    c.onDemand(true)
    await flush()
    c.onDemand(true) // repeat while running → no second spawn
    await flush()

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('tears down the feeder + releases the source on idle', async () => {
    let spawned: SpawnedFeeder | undefined
    const spawn = vi.fn((onTeardown: () => void) => {
      spawned = makeSpawnedFeeder(onTeardown)
      return Promise.resolve(spawned.active)
    })
    const c = new DerivedFeederController({ logger: makeLogger(), spawn })

    c.onDemand(true)
    await flush()
    c.onDemand(false)
    await flush()

    expect(spawned?.destroy).toHaveBeenCalledTimes(1)
    expect(spawned?.release).toHaveBeenCalledTimes(1)
  })

  it('discards a feeder whose demand dropped while it was still spawning', async () => {
    let spawned: SpawnedFeeder | undefined
    const spawn = vi.fn((onTeardown: () => void) => {
      spawned = makeSpawnedFeeder(onTeardown)
      return Promise.resolve(spawned.active)
    })
    const c = new DerivedFeederController({ logger: makeLogger(), spawn })

    c.onDemand(true)
    c.onDemand(false) // demand gone before the spawn promise resolves
    await flush()

    expect(spawned?.destroy).toHaveBeenCalledTimes(1)
    expect(spawned?.release).toHaveBeenCalledTimes(1)
  })

  it('restarts a feeder that exits while still demanded (bounded backoff)', async () => {
    const spawned: SpawnedFeeder[] = []
    const spawn = vi.fn((onTeardown: () => void) => {
      const s = makeSpawnedFeeder(onTeardown)
      spawned.push(s)
      return Promise.resolve(s.active)
    })
    const scheduled: Array<() => void> = []
    const scheduleRestart = vi.fn((fn: () => void): RestartTimer => {
      scheduled.push(fn)
      return { cancel: vi.fn() }
    })
    const c = new DerivedFeederController({ logger: makeLogger(), spawn, scheduleRestart })

    c.onDemand(true)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)

    spawned[0]?.fireExit() // ffmpeg child died
    expect(scheduleRestart).toHaveBeenCalledTimes(1)

    const restart = scheduled.at(0)
    if (restart === undefined) throw new Error('expected scheduled restart')
    restart() // fire the backoff timer
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('destroy() stops the feeder and blocks further spawns', async () => {
    const spawned: SpawnedFeeder[] = []
    const spawn = vi.fn((onTeardown: () => void) => {
      const s = makeSpawnedFeeder(onTeardown)
      spawned.push(s)
      return Promise.resolve(s.active)
    })
    const c = new DerivedFeederController({ logger: makeLogger(), spawn })

    c.onDemand(true)
    await flush()
    c.destroy()
    expect(spawned[0]?.destroy).toHaveBeenCalledTimes(1)

    c.onDemand(true) // stopped → ignored
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
