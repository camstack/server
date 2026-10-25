/**
 * The "tell me, don't install" poller.
 *
 * Before this existed the ONLY periodic path to `update.available` was
 * `runAutoUpdate`, armed by `scheduleAutoUpdate` — which returns early when the
 * auto-update channel is `off`. Live hubs run `off`, so the operator was never
 * told about anything. These tests pin the two properties that bug violated:
 * the poller is armed with NO reference to the auto-update channel, and its
 * interval is a setting rather than a constant.
 */
import type { IScopedLogger, NodeLiveness } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
  MIN_UPDATE_CHECK_INTERVAL_SECONDS,
  UpdateCheckScheduler,
  type UpdateCheckTargets,
} from '../update-check-scheduler.js'

type LogCall = { readonly message: string; readonly meta: unknown }

interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly warns: LogCall[]
  readonly errors: LogCall[]
  readonly infos: LogCall[]
}

function recordingLogger(): RecordingLogger {
  const warns: LogCall[] = []
  const errors: LogCall[] = []
  const infos: LogCall[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message: string, meta?: unknown) => {
      infos.push({ message, meta })
    },
    warn: (message: string, meta?: unknown) => {
      warns.push({ message, meta })
    },
    error: (message: string, meta?: unknown) => {
      errors.push({ message, meta })
    },
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return { logger, warns, errors, infos }
}

interface Harness {
  readonly targets: UpdateCheckTargets
  readonly checkHubAddons: ReturnType<typeof vi.fn>
  readonly checkAgentAddons: ReturnType<typeof vi.fn>
  readonly checkFrameworkPackages: ReturnType<typeof vi.fn>
  readonly checkNodeServerUpdate: ReturnType<typeof vi.fn>
  readonly checkWrapperUpdate: ReturnType<typeof vi.fn>
}

function harness(
  nodes: readonly NodeLiveness[] = [{ id: 'hub', isHub: true, isOnline: true }],
): Harness {
  const checkHubAddons = vi.fn(async () => undefined)
  const checkAgentAddons = vi.fn(async () => undefined)
  const checkFrameworkPackages = vi.fn(async () => undefined)
  const checkNodeServerUpdate = vi.fn(async () => undefined)
  const checkWrapperUpdate = vi.fn(async () => undefined)
  return {
    checkHubAddons,
    checkAgentAddons,
    checkFrameworkPackages,
    checkNodeServerUpdate,
    checkWrapperUpdate,
    targets: {
      listNodes: () => nodes,
      checkHubAddons,
      checkAgentAddons,
      checkFrameworkPackages,
      checkNodeServerUpdate,
      checkWrapperUpdate,
    },
  }
}

describe('UpdateCheckScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms and sweeps while the auto-update channel stays off', async () => {
    // The live hub reports `{"channel":"off"}`. The poller must not consult it
    // at all — it is not even a constructor input.
    const h = harness()
    const scheduler = new UpdateCheckScheduler({
      logger: recordingLogger().logger,
      targets: h.targets,
      getIntervalSeconds: () => DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
      initialDelayMs: 1_000,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.checkHubAddons).toHaveBeenCalledTimes(1)
    expect(h.checkFrameworkPackages).toHaveBeenCalledTimes(1)
    expect(h.checkNodeServerUpdate).toHaveBeenCalledWith('hub', true)

    await vi.advanceTimersByTimeAsync(DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS * 1_000)
    expect(h.checkHubAddons).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('takes its interval from settings, and a settings change re-arms it', async () => {
    const h = harness()
    let intervalSeconds = 3_600
    const scheduler = new UpdateCheckScheduler({
      logger: recordingLogger().logger,
      targets: h.targets,
      getIntervalSeconds: () => intervalSeconds,
      initialDelayMs: 0,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.checkHubAddons).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.checkHubAddons).toHaveBeenCalledTimes(2)

    intervalSeconds = 900
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(h.checkHubAddons).toHaveBeenCalledTimes(3)
    expect(scheduler.currentIntervalSeconds()).toBe(900)
    scheduler.stop()
  })

  it('clamps an interval below the documented minimum', () => {
    const h = harness()
    const rec = recordingLogger()
    const scheduler = new UpdateCheckScheduler({
      logger: rec.logger,
      targets: h.targets,
      getIntervalSeconds: () => 5,
      initialDelayMs: 0,
    })
    scheduler.start()
    expect(scheduler.currentIntervalSeconds()).toBe(MIN_UPDATE_CHECK_INTERVAL_SECONDS)
    scheduler.stop()
  })

  it('skips an offline node, logs it with the node id, and still sweeps the online ones', async () => {
    const h = harness([
      { id: 'hub', isHub: true, isOnline: true },
      { id: 'agent-a', isHub: false, isOnline: true },
      { id: 'dead-node', isHub: false, isOnline: false },
    ])
    const rec = recordingLogger()
    const scheduler = new UpdateCheckScheduler({
      logger: rec.logger,
      targets: h.targets,
      getIntervalSeconds: () => DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
    })

    await scheduler.runSweep()

    expect(h.checkAgentAddons).toHaveBeenCalledTimes(1)
    expect(h.checkAgentAddons).toHaveBeenCalledWith('agent-a')
    expect(h.checkNodeServerUpdate).toHaveBeenCalledWith('agent-a', false)
    expect(h.checkNodeServerUpdate).not.toHaveBeenCalledWith('dead-node', false)
    // A branch that DROPS work says so, and says which node.
    const skip = rec.warns.find((w) => /offline/i.test(w.message))
    expect(skip).toBeDefined()
    expect(skip?.meta).toMatchObject({ tags: { nodeId: 'dead-node' } })
  })

  it('logs a failed check and lets every other check still run', async () => {
    const h = harness([
      { id: 'hub', isHub: true, isOnline: true },
      { id: 'agent-a', isHub: false, isOnline: true },
    ])
    h.checkHubAddons.mockRejectedValueOnce(new Error('registry unreachable'))
    const rec = recordingLogger()
    const scheduler = new UpdateCheckScheduler({
      logger: rec.logger,
      targets: h.targets,
      getIntervalSeconds: () => DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
    })

    await expect(scheduler.runSweep()).resolves.toBeUndefined()

    expect(h.checkFrameworkPackages).toHaveBeenCalledTimes(1)
    expect(h.checkAgentAddons).toHaveBeenCalledTimes(1)
    const failure = rec.warns.find((w) => /check failed/i.test(w.message))
    expect(failure).toBeDefined()
    expect(failure?.meta).toMatchObject({ meta: { error: 'registry unreachable' } })
  })

  it('sweeps the SHELL of every online node, hub included', async () => {
    // The fifth target. The 2026-08-02 hub's image was 13 days old from a dead
    // repository while `checkNodeServerUpdate` reported it perfectly current —
    // the two questions are different, so the sweep asks both.
    const h = harness([
      { id: 'hub', isHub: true, isOnline: true },
      { id: 'agent-a', isHub: false, isOnline: true },
      { id: 'dead-node', isHub: false, isOnline: false },
    ])
    const scheduler = new UpdateCheckScheduler({
      logger: recordingLogger().logger,
      targets: h.targets,
      getIntervalSeconds: () => DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
    })

    await scheduler.runSweep()

    expect(h.checkWrapperUpdate).toHaveBeenCalledWith('hub', true)
    expect(h.checkWrapperUpdate).toHaveBeenCalledWith('agent-a', false)
    // D58: never dispatch at a node the registry already called offline.
    expect(h.checkWrapperUpdate).not.toHaveBeenCalledWith('dead-node', false)
  })

  it('logs a failed wrapper check with the node id, and keeps sweeping the rest', async () => {
    const h = harness([
      { id: 'hub', isHub: true, isOnline: true },
      { id: 'agent-a', isHub: false, isOnline: true },
    ])
    h.checkWrapperUpdate.mockRejectedValueOnce(new Error('no wrapper identity'))
    const rec = recordingLogger()
    const scheduler = new UpdateCheckScheduler({
      logger: rec.logger,
      targets: h.targets,
      getIntervalSeconds: () => DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
    })

    await expect(scheduler.runSweep()).resolves.toBeUndefined()

    // A failed check is an ERROR, never "no update available".
    const failure = rec.warns.find((w) => /check failed.*wrapper/i.test(w.message))
    expect(failure).toBeDefined()
    expect(failure?.meta).toMatchObject({
      tags: { nodeId: 'hub' },
      meta: { error: 'no wrapper identity' },
    })
    expect(h.checkWrapperUpdate).toHaveBeenCalledWith('agent-a', false)
    expect(h.checkAgentAddons).toHaveBeenCalledTimes(1)
  })

  it('never runs two sweeps concurrently', async () => {
    const h = harness()
    // A holder, not a `let`: assigned inside the executor, it would be narrowed
    // to its initializer (`null`) at the call site below.
    const pending: { resolve: (() => void) | null } = { resolve: null }
    h.checkHubAddons.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          pending.resolve = () => resolve(undefined)
        }),
    )
    const scheduler = new UpdateCheckScheduler({
      logger: recordingLogger().logger,
      targets: h.targets,
      getIntervalSeconds: () => DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
    })

    const first = scheduler.runSweep()
    await scheduler.runSweep()
    expect(h.checkFrameworkPackages).not.toHaveBeenCalled()

    pending.resolve?.()
    await first
    expect(h.checkFrameworkPackages).toHaveBeenCalledTimes(1)
  })
})
