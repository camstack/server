/**
 * A native-metrics tick must never outlive its context into an unhandled
 * rejection.
 *
 * Observed on the agent agent-a (2026-10-07 04:22Z, `docker stop`
 * during Unraid's Appdata Backup): the agent's graceful stop awaited this
 * addon's `shutdown()` — `onShutdown` cleared both timers, then `BaseAddon`
 * nulled `ctx` — while a process-snapshot tick was suspended on the
 * process-table read. The tick resumed, `listNodeProcesses` read `this.ctx`
 * and threw, the catch block read `this.ctx.logger` and threw AGAIN, and the
 * rejected timer callback killed the agent with exit code 1 instead of 0.
 *
 * `clearInterval` cannot recall a tick already in flight; these tests pin the
 * in-flight case, a tick that fires before `initialize()` / after `shutdown()`,
 * and that shutdown really clears both timers.
 */
import type { SystemEvent } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAMSTACK_CMD_RE } from '../process-classification.js'

const hoisted = vi.hoisted(() => {
  const state = {
    /**
     * The fixture process's command line. It must NOT match `CAMSTACK_CMD_RE`:
     * the tick samples `/proc/<pid>/task` for every camstack-shaped pid, and
     * that is a real `readdir` on the libuv thread pool — its completion is not
     * ordered against `settle()`'s single `setImmediate`, so on a loaded CI
     * runner the tick had not emitted yet when the first test asserted (run
     * 38359285595: the old value, `not-a-camstack-process`, matched the pattern
     * by containing the word). The first test pins the fixture to the pattern.
     */
    fixtureCommand: 'sleep 60',
    tableCalls: 0,
    /** When set, the next process-table read waits on this. */
    gate: null as Promise<void> | null,
  }
  return state
})

vi.mock('../proc-process-table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc-process-table.js')>()
  return {
    ...actual,
    readProcessTable: async () => {
      hoisted.tableCalls += 1
      if (hoisted.gate) await hoisted.gate
      return [
        {
          pid: 4242,
          ppid: 1,
          pgid: 4242,
          cpuPercent: 1,
          memoryRssBytes: 1024,
          uptimeSec: 10,
          command: hoisted.fixtureCommand,
        },
      ]
    },
  }
})

vi.mock('../native-metrics-provider.js', () => ({
  NativeMetricsProvider: class {
    setDiagnostics(): void {}
    startSampling(): void {}
    stopSampling(): void {}
    async getCached(): Promise<unknown> {
      return { cpu: 1 }
    }
    async collectSnapshot(): Promise<unknown> {
      return { cpu: 1 }
    }
  },
}))

vi.mock('../cgroup-memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cgroup-memory.js')>()
  return {
    ...actual,
    ContainerMemoryProbe: class {
      sample(): null {
        return null
      }
    },
  }
})

vi.mock('../cgroup-pids.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cgroup-pids.js')>()
  return {
    ...actual,
    ContainerPidsProbe: class {
      sample(): null {
        return null
      }
    },
  }
})

// Import AFTER the mocks so the addon binds the fakes.
import NativeMetricsAddon from '../native-metrics.addon.js'

type AddonCtx = Parameters<NativeMetricsAddon['initialize']>[0]

/** The default `loadSeriesCadenceSec`, in ms. */
const PROCESS_CADENCE_MS = 10_000
const RESOURCES_CADENCE_MS = 5_000

interface Harness {
  readonly addon: NativeMetricsAddon
  readonly ctx: AddonCtx
  readonly events: SystemEvent[]
  readonly warnings: string[]
}

function makeHarness(): Harness {
  const events: SystemEvent[] = []
  const warnings: string[] = []
  const noop = (): void => undefined
  const logger = {
    debug: noop,
    info: noop,
    warn: (message: string) => {
      warnings.push(message)
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: 'native-metrics',
    logger,
    kernel: {
      localNodeId: 'agent-a',
      cluster: { broker: { nodeID: 'agent-a', call: async () => [] } },
    },
    eventBus: {
      emit: (event: SystemEvent) => {
        events.push(event)
      },
      subscribe: () => () => undefined,
    },
    addDisposer: noop,
    api: { settingsStore: {} },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
      getSection: async () => ({}),
    },
  } as unknown as AddonCtx
  return { addon: new NativeMetricsAddon(), ctx, events, warnings }
}

function processSnapshots(events: readonly SystemEvent[]): SystemEvent[] {
  return events.filter((e) => e.category === 'metrics.node-processes-snapshot')
}

function resourceSnapshots(events: readonly SystemEvent[]): SystemEvent[] {
  return events.filter((e) => e.category === 'metrics.node-resources-snapshot')
}

let unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

/** Let suspended ticks run to completion and any rejection surface. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  hoisted.tableCalls = 0
  hoisted.gate = null
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  vi.useRealTimers()
})

describe('native-metrics — a tick never outlives its context', () => {
  it('emits on both cadences while initialized (the harness reaches the real ticks)', async () => {
    // No camstack-shaped pid means no real /proc read inside the tick: it is
    // microtasks end to end, so `settle()` is a complete wait, not a race.
    expect(CAMSTACK_CMD_RE.test(hoisted.fixtureCommand)).toBe(false)
    const { addon, ctx, events } = makeHarness()
    await addon.initialize(ctx)

    await vi.advanceTimersByTimeAsync(PROCESS_CADENCE_MS)
    await settle()

    expect(processSnapshots(events)).toHaveLength(1)
    expect(resourceSnapshots(events).length).toBeGreaterThanOrEqual(1)
    await addon.shutdown()
  })

  it('a process tick suspended across shutdown() resumes without a rejection and emits nothing', async () => {
    const { addon, ctx, events } = makeHarness()
    await addon.initialize(ctx)

    let release: () => void = () => undefined
    hoisted.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Fire the process tick; it parks on the process-table read.
    await vi.advanceTimersByTimeAsync(PROCESS_CADENCE_MS)
    expect(hoisted.tableCalls).toBe(1)

    // The graceful stop lands while the tick is suspended.
    await addon.shutdown()
    const before = processSnapshots(events).length

    release()
    await settle()

    expect(unhandled).toEqual([])
    expect(processSnapshots(events)).toHaveLength(before)
  })

  it('shutdown() clears BOTH timers: no tick of either kind fires afterwards', async () => {
    const { addon, ctx, events } = makeHarness()
    await addon.initialize(ctx)
    await addon.shutdown()

    const callsAtShutdown = hoisted.tableCalls
    const eventsAtShutdown = events.length
    await vi.advanceTimersByTimeAsync(PROCESS_CADENCE_MS * 6 + RESOURCES_CADENCE_MS)
    await settle()

    expect(hoisted.tableCalls).toBe(callsAtShutdown)
    expect(events.length).toBe(eventsAtShutdown)
    expect(vi.getTimerCount()).toBe(0)
    expect(unhandled).toEqual([])
  })

  it('a timer callback invoked after shutdown() is a no-op: no throw, no rejection', async () => {
    const callbacks: Array<() => unknown> = []
    const realSetInterval = globalThis.setInterval
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => unknown,
      ms?: number,
    ) => {
      callbacks.push(handler)
      return realSetInterval(handler, ms)
    }) as typeof setInterval)

    const { addon, ctx, events } = makeHarness()
    await addon.initialize(ctx)
    spy.mockRestore()
    expect(callbacks.length).toBeGreaterThanOrEqual(2)

    await addon.shutdown()
    const eventsAtShutdown = events.length

    for (const cb of callbacks) {
      expect(() => cb()).not.toThrow()
    }
    await settle()

    expect(unhandled).toEqual([])
    expect(events.length).toBe(eventsAtShutdown)
  })

  it('a settings write before initialize() arms no timer', async () => {
    const { addon } = makeHarness()

    await addon.updateGlobalSettings({ loadSeriesCadenceSec: 5 })
    await vi.advanceTimersByTimeAsync(PROCESS_CADENCE_MS)
    await settle()

    expect(vi.getTimerCount()).toBe(0)
    expect(hoisted.tableCalls).toBe(0)
    expect(unhandled).toEqual([])
  })
})
