/**
 * P3a — audio-analyzer `probedBestAudioBackend` per-node via the BASE
 * `perNode:true` marker (settings-API migration).
 *
 * The probed-best hint is a NODE fact (the platform probe runs on one host),
 * so it persists node-scoped as `probedBestAudioBackend@<nodeId>` through the
 * P2a BaseAddon surface — node-blind writes (`updateGlobalSettings`), no
 * bare-key fallback. `audioBackend` / `selectedAudioModel` stay
 * cluster-shared (bare keys).
 *
 * Fake-ctx style mirrors `audio-analyzer-platform-gate.spec.ts` (pipeline
 * factory stubbed so initialize never spawns Python / loads a model) plus the
 * mutable seeded store of `decoder-ffmpeg-per-node-settings.spec.ts`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// Stub the pipeline factory — initialize() would otherwise build a real
// audio pipeline. Real exports (types, AudioBackend) pass through.
vi.mock('../../../audio-pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../audio-pipeline.js')>()
  return {
    ...actual,
    createAudioPipeline: vi.fn(async () => ({
      initialize: vi.fn(async () => {}),
      classify: vi.fn(async () => ({ label: '', confidence: 0, macro: null })),
      dispose: vi.fn(async () => {}),
    })),
  }
})

import { AudioAnalyzerAddon } from '../index.js'
import type {
  AddonContext,
  ConfigFieldWithValue,
  ConfigUISchemaWithValues,
  EventFilter,
  IEventBus,
  IScopedLogger,
  SystemEvent,
} from '@camstack/types'

// ── Fakes ───────────────────────────────────────────────────────────────

interface TopologyEntry {
  readonly id: string
  readonly platform: string
}

interface FakeCtxOptions {
  readonly localNodeId: string
  readonly seed?: Record<string, unknown>
  readonly topology?: readonly TopologyEntry[]
}

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

function makeFakeContext(options: FakeCtxOptions): FakeCtxHandle {
  const store: Record<string, unknown> = { ...options.seed }
  const ctx = {
    id: 'audio-analyzer',
    logger: makeSilentLogger(),
    eventBus: makeLocalEventBus(),
    addonConfig: {},
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp/fake',
    kernel: { localNodeId: options.localNodeId },
    deps: { ensurePython: vi.fn(async () => '/usr/bin/python3') },
    api: {
      pipelineOrchestrator: {
        resolvePipeline: { query: vi.fn(async () => ({ engine: {}, steps: [], audio: null })) },
      },
      storage: { resolve: { query: async () => '/tmp/fake/models' } },
      nodes: { topology: { query: vi.fn(async () => options.topology ?? []) } },
    },
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

function fieldValue(schema: ConfigUISchemaWithValues | null, key: string): unknown {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field && field.key === key && 'value' in field) return field.value
    }
  }
  return undefined
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('AudioAnalyzerAddon — probedBestAudioBackend per-node', () => {
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

  it('reprobeAudioEngine persists under probedBestAudioBackend@<node>, never the bare key', async () => {
    setPlatform('linux')
    // Scoped seed keeps the onInitialize auto-reprobe quiet (config already populated).
    const { ctx, store } = makeFakeContext({
      localNodeId: 'hub',
      seed: { 'probedBestAudioBackend@hub': 'stale-probe' },
    })
    await addon!.initialize(ctx)
    const result = await addon!.reprobeAudioEngine()
    expect(result).toEqual({ backend: 'yamnet-onnx' })
    expect(store['probedBestAudioBackend@hub']).toBe('yamnet-onnx')
    expect(Object.prototype.hasOwnProperty.call(store, 'probedBestAudioBackend')).toBe(false)
  })

  it('a child-process localNodeId (hub/audio-analyzer) normalizes to the parent node', async () => {
    setPlatform('darwin')
    const { ctx, store } = makeFakeContext({
      localNodeId: 'hub/audio-analyzer',
      seed: { 'probedBestAudioBackend@hub': 'stale-probe' },
    })
    await addon!.initialize(ctx)
    const result = await addon!.reprobeAudioEngine()
    expect(result).toEqual({ backend: 'apple-soundanalysis' })
    expect(store['probedBestAudioBackend@hub']).toBe('apple-soundanalysis')
    expect(Object.prototype.hasOwnProperty.call(store, 'probedBestAudioBackend')).toBe(false)
  })

  it('getGlobalSettings shows each node its OWN probed value; absent scoped key ⇒ schema default, never a bare legacy value', async () => {
    setPlatform('linux')
    const { ctx } = makeFakeContext({
      localNodeId: 'hub',
      seed: {
        'probedBestAudioBackend@hub': 'yamnet-onnx',
        'probedBestAudioBackend@macmini': 'apple-soundanalysis',
        probedBestAudioBackend: 'stale-bare',
        audioBackend: 'yamnet-onnx',
      },
      topology: [
        { id: 'hub', platform: 'linux' },
        { id: 'macmini', platform: 'darwin' },
      ],
    })
    await addon!.initialize(ctx)

    const hub = await addon!.getGlobalSettings(undefined, undefined, 'hub')
    expect(fieldValue(hub, 'probedBestAudioBackend')).toBe('yamnet-onnx')

    const macmini = await addon!.getGlobalSettings(undefined, undefined, 'macmini')
    expect(fieldValue(macmini, 'probedBestAudioBackend')).toBe('apple-soundanalysis')

    // Node with NO scoped key: schema default (''), never the stale bare key.
    const agent99 = await addon!.getGlobalSettings(undefined, undefined, 'agent-99')
    expect(fieldValue(agent99, 'probedBestAudioBackend')).toBe('')

    // audioBackend stays cluster-shared — every node sees the same bare value.
    expect(fieldValue(hub, 'audioBackend')).toBe('yamnet-onnx')
    expect(fieldValue(macmini, 'audioBackend')).toBe('yamnet-onnx')
    expect(fieldValue(agent99, 'audioBackend')).toBe('yamnet-onnx')
  })

  it('node-blind getGlobalSettings resolves the LOCAL node scoped value', async () => {
    setPlatform('linux')
    const { ctx } = makeFakeContext({
      localNodeId: 'hub',
      seed: {
        'probedBestAudioBackend@hub': 'yamnet-onnx',
        'probedBestAudioBackend@macmini': 'apple-soundanalysis',
      },
    })
    await addon!.initialize(ctx)
    const view = await addon!.getGlobalSettings()
    expect(fieldValue(view, 'probedBestAudioBackend')).toBe('yamnet-onnx')
  })
})
