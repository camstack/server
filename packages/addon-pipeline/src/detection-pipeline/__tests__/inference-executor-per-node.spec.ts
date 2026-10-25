/**
 * The "Inference executor" overrides are PER NODE.
 *
 * They provision the Python inference pools of ONE host — a Mac mini's CoreML
 * pools and the hub's OpenVINO pools share nothing — but the store they live in
 * is hub-central and shared by every node (the `settings-store` cap is a hub
 * singleton). Without the `perNode: true` marker a single operator save wrote a
 * BARE key that every node then resolved, so raising the Mac's subprocess count
 * also doubled the hub's per-pool model RAM.
 *
 * These tests pin both halves of the marker's contract:
 *   - the WRITE/READ scoping (`<key>@<nodeId>`, no bare-key fallback), which is
 *     what makes a macmini-only raise possible at all;
 *   - `resolveConfig`, i.e. the value the PROVIDER actually provisions pools
 *     with — the settings form being right is worthless if boot reads the
 *     other node's number.
 *
 * Fake-ctx style mirrors `audio-analyzer/.../audio-per-node-settings.spec.ts`.
 * `onInitialize` is stubbed in a test subclass: the real one downloads Python
 * and spawns pools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import DetectionPipelineAddon from '../index.js'
import type { RuntimeEnv } from '../runtimes.js'
import type {
  AddonContext,
  ConfigFieldWithValue,
  ConfigUISchemaWithValues,
  EventFilter,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@camstack/types'

/** Every field key of the Inference-executor section, in schema order. */
const EXECUTOR_FIELD_KEYS = [
  'batchMode',
  'windowMs',
  'maxBatchSize',
  'concurrency',
  'numWorkers',
] as const

interface FakeCtxHandle {
  readonly ctx: AddonContext
  readonly store: Record<string, unknown>
}

function makeSilentLogger(): IScopedLogger {
  const noop = (): void => {
    /* no-op */
  }
  const logger: IScopedLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeLocalEventBus(): IEventBus {
  const captured: SystemEvent[] = []
  return {
    emit(event: SystemEvent) {
      captured.push(event)
    },
    subscribe(_filter: EventFilter | string, _handler: (event: SystemEvent) => void) {
      return () => {
        /* no-op */
      }
    },
    getRecent() {
      return captured as readonly SystemEvent[]
    },
  }
}

function makeFakeContext(localNodeId: string, seed?: Record<string, unknown>): FakeCtxHandle {
  const store: Record<string, unknown> = { ...seed }
  const ctx = {
    id: 'detection-pipeline',
    logger: makeSilentLogger(),
    eventBus: makeLocalEventBus(),
    addonConfig: {},
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp/fake',
    kernel: { localNodeId },
    deps: { ensurePython: vi.fn(async () => '/usr/bin/python3') },
    api: {},
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => {},
    },
  } as unknown as AddonContext
  return { ctx, store }
}

/**
 * The real `onInitialize` downloads embedded Python and spawns inference pools;
 * the real `probeHardwareEnv` does a `platformProbe` RPC. Both are protected
 * seams — overriding them keeps the settings surface under test and nothing
 * else. `probeHardwareEnv` answers darwin/arm64 so the suggested slider
 * defaults come from the CoreML registry row, matching the node under test.
 */
class TestDetectionPipelineAddon extends DetectionPipelineAddon {
  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    return []
  }

  protected override async probeHardwareEnv(): Promise<RuntimeEnv> {
    return { platform: 'darwin', arch: 'arm64', hardware: null }
  }
}

function fieldValue(schema: ConfigUISchemaWithValues | null, key: string): unknown {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field && field.key === key && 'value' in field) return field.value
    }
  }
  return undefined
}

describe('detection-pipeline — Inference executor is per-node', () => {
  let addon: TestDetectionPipelineAddon | null = null

  beforeEach(() => {
    addon = new TestDetectionPipelineAddon()
  })

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('every Inference-executor field declares perNode: true', async () => {
    const { ctx } = makeFakeContext('hub')
    await addon!.initialize(ctx)
    const schema = await addon!.getGlobalSettings(undefined, undefined, 'hub')
    const section = schema?.sections.find((s) => s.id === 'inference-executor')
    expect(section).toBeDefined()
    const keys = (section?.fields ?? [])
      .filter((f): f is ConfigFieldWithValue & { key: string } => 'key' in f)
      .map((f) => f.key)
    expect(keys).toEqual([...EXECUTOR_FIELD_KEYS])
    for (const field of section?.fields ?? []) {
      expect({
        key: 'key' in field ? field.key : '?',
        perNode: 'perNode' in field ? field.perNode : undefined,
      }).toEqual({
        key: 'key' in field ? field.key : '?',
        perNode: true,
      })
    }
  })

  it('a node with a scoped override sees it; another node sees Auto, never the neighbour value or a stale bare key', async () => {
    const { ctx } = makeFakeContext('hub', {
      'numWorkers@macmini': 2,
      'concurrency@macmini': 3,
      // A stray bare key from before the marker must be invisible to EVERY node.
      numWorkers: 8,
    })
    await addon!.initialize(ctx)

    const mac = await addon!.getGlobalSettings(undefined, undefined, 'macmini')
    expect(fieldValue(mac, 'numWorkers')).toBe(2)
    expect(fieldValue(mac, 'concurrency')).toBe(3)

    // The hub has no scoped key ⇒ the CoreML registry suggestion (1), which is
    // "Auto". Emphatically not the macmini's 2 and not the stale bare 8.
    const hub = await addon!.getGlobalSettings(undefined, undefined, 'hub')
    expect(fieldValue(hub, 'numWorkers')).toBe(1)
  })

  it('updateGlobalSettings persists under the TARGET node key and never the bare one', async () => {
    const { ctx, store } = makeFakeContext('hub')
    await addon!.initialize(ctx)
    await addon!.updateGlobalSettings({ numWorkers: 2 }, 'macmini')
    expect(store['numWorkers@macmini']).toBe(2)
    expect(Object.prototype.hasOwnProperty.call(store, 'numWorkers')).toBe(false)
  })

  it('resolveConfig — the value the pools provision from is THIS node scoped key', async () => {
    const seed = { 'numWorkers@macmini': 2 }

    const mac = new TestDetectionPipelineAddon()
    await mac.initialize(makeFakeContext('macmini', seed).ctx)
    expect(mac.config.numWorkers).toBe(2)
    await mac.shutdown()

    // Forked child ids carry `<node>/<addon>` — they must normalize to the node.
    const macChild = new TestDetectionPipelineAddon()
    await macChild.initialize(makeFakeContext('macmini/detection-pipeline', seed).ctx)
    expect(macChild.config.numWorkers).toBe(2)
    await macChild.shutdown()

    // The hub keeps auto (0) — this is the regression the marker exists for.
    const hub = new TestDetectionPipelineAddon()
    await hub.initialize(makeFakeContext('hub', seed).ctx)
    expect(hub.config.numWorkers).toBe(0)
    await hub.shutdown()
  })
})
