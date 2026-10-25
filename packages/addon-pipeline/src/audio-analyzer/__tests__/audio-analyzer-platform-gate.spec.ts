/**
 * AudioAnalyzerAddon — `getGlobalSettings` per-platform engine gating.
 *
 * Apple SoundAnalysis is a macOS built-in; YAMNet (ONNX) is cross-platform.
 * The audio-analyzer is an `any-node` addon — a remote node's settings form is
 * forked to that node's own instance, so gating is driven by the LOCAL
 * `process.platform` (deterministic, no platform-probe "hardware" cap).
 *
 * Requirements under test:
 *   - YAMNet (onnx) + "Auto" are ALWAYS offered, on every platform.
 *   - Apple SoundAnalysis is offered ONLY on darwin.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// Stub the pipeline factory so getGlobalSettings can be exercised without a real
// model load — the yamnet (linux) path would otherwise spawn Python + load a
// model during initialize. Real exports (types, AudioBackend) pass through.
vi.mock('../audio-pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio-pipeline.js')>()
  return {
    ...actual,
    createAudioPipeline: vi.fn(async () => ({
      initialize: vi.fn(async () => {}),
      classify: vi.fn(async () => ({ label: '', confidence: 0, macro: null })),
      dispose: vi.fn(async () => {}),
    })),
  }
})

import { AudioAnalyzerAddon } from '../addons/analyzer/index.js'
import type {
  AddonContext,
  IEventBus,
  SystemEvent,
  EventFilter,
  IScopedLogger,
  ConfigUISchemaWithValues,
} from '@camstack/types'

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

function makeFakeContext(topology: { id: string; platform: string }[] = []): {
  ctx: AddonContext
} {
  const ctx = {
    id: 'audio-analyzer',
    logger: makeSilentLogger(),
    eventBus: makeLocalEventBus(),
    addonConfig: {},
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp/fake',
    kernel: { localNodeId: 'hub' },
    deps: { ensurePython: vi.fn(async () => '/usr/bin/python3') },
    api: {
      pipelineOrchestrator: {
        resolvePipeline: { query: vi.fn(async () => ({ engine: {}, steps: [], audio: null })) },
      },
      storage: { resolve: { query: async () => '/tmp/fake/models' } },
      nodes: { topology: { query: vi.fn(async () => topology) } },
    },
    settings: {
      async readAddonStore() {
        return {}
      },
      async writeAddonStore() {},
      async readDeviceStore() {
        return {}
      },
      async writeDeviceStore() {},
    },
  } as unknown as AddonContext
  return { ctx }
}

function backendOptionValues(schema: ConfigUISchemaWithValues): string[] {
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.type === 'select' && field.key === 'audioBackend') {
        return field.options.map((o) => o.value)
      }
    }
  }
  return []
}

describe('AudioAnalyzerAddon — getGlobalSettings platform gating', () => {
  const originalPlatform = process.platform
  let addon: AudioAnalyzerAddon | null = null

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  beforeEach(() => {
    addon = new AudioAnalyzerAddon()
  })

  afterEach(async () => {
    setPlatform(originalPlatform)
    if (addon) await addon.shutdown()
    addon = null
  })

  it('offers Apple SoundAnalysis on darwin, plus YAMNet (onnx) and Auto', async () => {
    setPlatform('darwin')
    const { ctx } = makeFakeContext()
    await addon!.initialize(ctx)
    const schema = await addon!.getGlobalSettings()
    const values = backendOptionValues(schema)
    expect(values).toContain('apple-soundanalysis')
    expect(values).toContain('yamnet-onnx')
    expect(values).toContain('auto')
  })

  it('hides Apple SoundAnalysis off darwin, but YAMNet (onnx) is ALWAYS offered', async () => {
    setPlatform('linux')
    const { ctx } = makeFakeContext()
    await addon!.initialize(ctx)
    const schema = await addon!.getGlobalSettings()
    const values = backendOptionValues(schema)
    expect(values).not.toContain('apple-soundanalysis')
    expect(values).toContain('yamnet-onnx')
    expect(values).toContain('auto')
  })

  // Hub-centric form: the hub (linux) serves a REMOTE darwin node's settings.
  // The gate must read the target node's platform from the cluster topology
  // (nodes.topology), NOT the hub's process.platform — so Apple IS offered.
  it('offers Apple for a remote darwin node even when the hub is linux (topology-driven)', async () => {
    setPlatform('linux')
    const { ctx } = makeFakeContext([
      { id: 'hub', platform: 'linux' },
      { id: 'macmini', platform: 'darwin' },
    ])
    await addon!.initialize(ctx)
    const schema = await addon!.getGlobalSettings(undefined, undefined, 'macmini')
    const values = backendOptionValues(schema)
    expect(values).toContain('apple-soundanalysis')
    expect(values).toContain('yamnet-onnx')
  })

  // Inverse: hub on darwin serving a remote linux node must NOT offer Apple.
  it('hides Apple for a remote linux node even when the hub is darwin (topology-driven)', async () => {
    setPlatform('darwin')
    const { ctx } = makeFakeContext([
      { id: 'hub', platform: 'darwin' },
      { id: 'agent-a', platform: 'linux' },
    ])
    await addon!.initialize(ctx)
    const schema = await addon!.getGlobalSettings(undefined, undefined, 'agent-a')
    const values = backendOptionValues(schema)
    expect(values).not.toContain('apple-soundanalysis')
    expect(values).toContain('yamnet-onnx')
  })
})
