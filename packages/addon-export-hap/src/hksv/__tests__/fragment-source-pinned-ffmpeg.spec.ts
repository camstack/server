/**
 * The HKSV prebuffer runs the node's PINNED ffmpeg (D540) — it spawned a bare
 * `'ffmpeg'` by design before. Without the pinned build its start REFUSES,
 * named per camera, and a respawn that fails for that reason is re-armed on
 * the bounded backoff instead of leaving the prebuffer dark.
 */
import type { IScopedLogger } from '@camstack/types'
import type { FfmpegSpawnFn } from '@camstack/types/node'
import { describe, expect, it, vi } from 'vitest'
import {
  HksvFragmentSource,
  RESPAWN_LOG_EVERY_FAILURES,
  RESPAWN_LOG_FIRST_FAILURES,
} from '../fragment-source.js'
import type { RecordingSource } from '../recording-source.js'

const SOURCE: RecordingSource = {
  brokerId: '112/main',
  profile: 'main',
  transcode: false,
  url: 'rtsp://127.0.0.1:8554/tok',
  mutedUrl: 'rtsp://127.0.0.1:8554/tok/muted',
  width: 1920,
  height: 1080,
}

function makeLogger(): IScopedLogger & {
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): IScopedLogger => logger,
    withTags: (): IScopedLogger => logger,
  }
  return logger
}

/** Captures armed timers so a spec fires them by hand. */
function manualTimers(): { fn: typeof setTimeout; fire: () => void; armed: () => number } {
  const pending: (() => void)[] = []
  let armed = 0
  const fn = ((cb: () => void) => {
    armed += 1
    pending.push(cb)
    return setTimeout(() => {}, 0)
  }) as unknown as typeof setTimeout
  return {
    fn,
    fire: () => pending.shift()?.(),
    armed: () => armed,
  }
}

function makeSource(overrides: {
  resolveFfmpeg: () => Promise<string>
  spawnFn: FfmpegSpawnFn
  logger: IScopedLogger
  setTimeoutFn?: typeof setTimeout
}): HksvFragmentSource {
  return new HksvFragmentSource({
    deviceId: 112,
    source: SOURCE,
    fragmentMs: 4_000,
    audioActive: false,
    ...overrides,
  })
}

describe('HKSV fragment source — the pinned ffmpeg (D540)', () => {
  it('REFUSES the start, per camera, and spawns nothing without the pinned build', async () => {
    const logger = makeLogger()
    const spawnFn = vi.fn() as unknown as FfmpegSpawnFn
    const source = makeSource({
      resolveFfmpeg: async () => {
        throw new Error('download failed')
      },
      spawnFn,
      logger,
    })
    await expect(source.start()).rejects.toThrow('download failed')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ tags: { deviceId: 112 } }),
    )
    await source.stop('spec')
  })

  it('NEVER gives up: a respawn that keeps failing is re-armed at the ceiling, and logged at a bounded rate', async () => {
    const logger = makeLogger()
    const timers = manualTimers()
    const source = makeSource({
      resolveFfmpeg: async () => {
        throw new Error('download failed')
      },
      spawnFn: vi.fn() as unknown as FfmpegSpawnFn,
      logger,
      setTimeoutFn: timers.fn,
    })
    // The live child died: the source arms its first respawn.
    const onChildExit = Reflect.get(source, 'onChildExit')
    if (typeof onChildExit !== 'function') throw new Error('onChildExit moved')
    onChildExit.call(source, new Error('child died'))
    expect(timers.armed()).toBe(1)
    // 25 failed respawns — far past any count a bound would have stopped at.
    const FAILURES = 25
    for (let i = 1; i <= FAILURES; i++) {
      timers.fire()
      await vi.waitFor(() => expect(timers.armed()).toBe(i + 1))
    }
    // Still armed: one more respawn is always pending.
    expect(timers.armed()).toBe(FAILURES + 1)
    // Visible but not a flood: each failure while the backoff climbs, then one
    // ERROR per RESPAWN_LOG_EVERY_FAILURES — never one line per attempt.
    const respawnWarns = logger.warn.mock.calls.filter(([m]) =>
      String(m).includes('respawn failed'),
    )
    const stillErrors = logger.error.mock.calls.filter(([m]) =>
      String(m).includes('still cannot respawn'),
    )
    expect(respawnWarns).toHaveLength(RESPAWN_LOG_FIRST_FAILURES)
    expect(stillErrors).toHaveLength(Math.floor(FAILURES / RESPAWN_LOG_EVERY_FAILURES))
    expect(stillErrors[0]?.[1]).toMatchObject({ tags: { deviceId: 112 } })
    await source.stop('spec')
  })
})
