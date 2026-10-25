/**
 * The node-metrics series are declared when `device-history` is READY, never
 * blind at boot.
 *
 * Observed on `.50` (1.2.606, 18:38:15Z): native-metrics initialised before
 * its sibling builtin and its boot declare failed with "Service
 * 'device-history.device-history.declareSeries' is not found". D3 forbids a
 * timer or a retry backoff to wait for a provider; the registry says when one
 * arrives (`onCapabilityStateChange`), and its snapshot says whether it already
 * has (`useCapability(...).isReady`).
 */
import type { ReadinessScope } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../proc-process-table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc-process-table.js')>()
  return { ...actual, readProcessTable: async () => [] }
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
type StateHandler = (state: 'ready' | 'down') => void

interface Harness {
  readonly addon: NativeMetricsAddon
  readonly ctx: AddonCtx
  readonly warnings: string[]
  readonly declared: string[]
  readonly watched: { capName: string; scope: ReadinessScope }[]
  /** The registry says `device-history` registered: the service answers from now on. */
  ready(): void
}

function makeHubHarness(opts: { readonly readyAtBoot: boolean }): Harness {
  const warnings: string[] = []
  const declared: string[] = []
  const watched: { capName: string; scope: ReadinessScope }[] = []
  const handlers: StateHandler[] = []
  let registered = opts.readyAtBoot
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
  const deviceHistory = {
    declareSeries: {
      mutate: async (input: { name: string }) => {
        if (!registered) {
          throw new Error("Service 'device-history.device-history.declareSeries' is not found.")
        }
        declared.push(input.name)
        return { key: `addon:metrics-native/${input.name}` }
      },
    },
    record: { mutate: async () => ({ accepted: 0, refused: [] }) },
    queryNode: { query: async () => ({ resolution: 'raw', series: [], truncated: false }) },
  }
  const ctx = {
    id: 'metrics-native',
    logger,
    kernel: {
      localNodeId: 'hub',
      cluster: { broker: { nodeID: 'hub', call: async () => [] } },
    },
    eventBus: { emit: noop, subscribe: () => () => undefined },
    addDisposer: noop,
    api: { settingsStore: {}, deviceHistory },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
      getSection: async () => ({}),
    },
    useCapability: (capName: string) => ({
      get isReady(): boolean {
        return capName === 'device-history' && registered
      },
    }),
    onCapabilityStateChange: (capName: string, scope: ReadinessScope, handler: StateHandler) => {
      watched.push({ capName, scope })
      if (capName === 'device-history') handlers.push(handler)
      return noop
    },
  } as unknown as AddonCtx
  return {
    addon: new NativeMetricsAddon(),
    ctx,
    warnings,
    declared,
    watched,
    ready: () => {
      registered = true
      for (const h of handlers) h('ready')
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// The node series device-history carries (D896): per runner, per node, the container.
const SERIES = [
  'runner-cpu-main-percent',
  'runner-cpu-gc-percent',
  'runner-cpu-lifetime-percent',
  'runner-rss-mib',
  'runner-processes',
  'node-cpu-percent',
  'node-memory-percent',
  'node-cpu-temperature',
  'node-gpu-percent',
  'node-gpu-temperature',
  'container-current-mib',
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('native-metrics — history series declared on device-history READY', () => {
  it('a hub booting BEFORE device-history declares nothing, warns nothing, then declares on ready', async () => {
    const h = makeHubHarness({ readyAtBoot: false })
    await h.addon.initialize(h.ctx)
    await settle()
    expect(h.warnings.filter((w) => w.includes('history declare failed'))).toEqual([])
    expect(h.declared).toEqual([])
    expect(h.watched).toContainEqual({
      capName: 'device-history',
      scope: { type: 'node', nodeId: 'hub' },
    })

    h.ready()
    await settle()
    expect(h.declared).toEqual(SERIES)
    await h.addon.shutdown()
  })

  it('a hub booting AFTER device-history declares at once (the registry already answered)', async () => {
    const h = makeHubHarness({ readyAtBoot: true })
    await h.addon.initialize(h.ctx)
    await settle()
    expect(h.declared).toEqual(SERIES)
    expect(h.warnings.filter((w) => w.includes('history declare failed'))).toEqual([])
    await h.addon.shutdown()
  })
})
