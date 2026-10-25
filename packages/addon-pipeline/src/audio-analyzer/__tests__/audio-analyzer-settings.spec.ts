/**
 * AudioAnalyzerAddon — `resolveDeviceSettings(deviceId)` contract.
 *
 * Per-device audio settings (`enabledAudioClasses`, `minConfidence`) live
 * on the audio-classifier pipeline step. The audio analyzer pulls them
 * from `pipelineOrchestrator.resolvePipeline({deviceId}).audio.settings`
 * at runtime — there is no per-device store on this addon.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AudioAnalyzerAddon } from '../addons/analyzer/index.js'
import type {
  AddonContext,
  IEventBus,
  SystemEvent,
  EventFilter,
  IScopedLogger,
  IAudioAnalyzer,
} from '@camstack/types'
import { normalizeAddonInitResult } from '@camstack/types'

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

interface ResolvedAudio {
  readonly modelId: string
  readonly enabled: boolean
  readonly settings?: Record<string, unknown>
}

function makeFakeContext(resolvedAudio: ResolvedAudio | null): { ctx: AddonContext } {
  const resolvePipeline = vi.fn(async ({ deviceId: _ }: { deviceId: number }) => ({
    engine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
    steps: [],
    audio: resolvedAudio,
  }))
  const ctx = {
    id: 'audio-analyzer',
    logger: makeSilentLogger(),
    eventBus: makeLocalEventBus(),
    addonConfig: {},
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp/fake',
    kernel: {},
    api: {
      pipelineOrchestrator: {
        resolvePipeline: { query: resolvePipeline },
      },
      storage: {
        resolve: { query: async () => '/tmp/fake/models' },
      },
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

describe('AudioAnalyzerAddon — resolveDeviceSettings contract', () => {
  let addon: AudioAnalyzerAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('registers an IAudioAnalyzer provider with resolveDeviceSettings on initialize', async () => {
    const { ctx } = makeFakeContext(null)
    addon = new AudioAnalyzerAddon()
    const regs = await addon.initialize(ctx)
    const analyzer = normalizeAddonInitResult(regs)?.providers?.find(
      (r) => r.capability.name === 'audio-analyzer',
    )?.provider as IAudioAnalyzer
    expect(analyzer).toBeDefined()
    expect(typeof analyzer.resolveDeviceSettings).toBe('function')
  })

  it('returns minConfidence + allowedClasses from the orchestrator-resolved audio step settings', async () => {
    const { ctx } = makeFakeContext({
      modelId: 'yamnet-onnx',
      enabled: true,
      settings: { minConfidence: 0.6, enabledAudioClasses: ['speech', 'music'] },
    })
    addon = new AudioAnalyzerAddon()
    const regs = await addon.initialize(ctx)
    const analyzer = normalizeAddonInitResult(regs)?.providers?.find(
      (r) => r.capability.name === 'audio-analyzer',
    )?.provider as IAudioAnalyzer
    const resolved = await analyzer.resolveDeviceSettings({ deviceId: 1 })
    expect(resolved).toEqual({
      minConfidence: 0.6,
      allowedClasses: ['speech', 'music'],
    })
  })

  it('falls back to defaults when the orchestrator returns no audio settings', async () => {
    const { ctx } = makeFakeContext({
      modelId: 'yamnet-onnx',
      enabled: true,
    })
    addon = new AudioAnalyzerAddon()
    const regs = await addon.initialize(ctx)
    const analyzer = normalizeAddonInitResult(regs)?.providers?.find(
      (r) => r.capability.name === 'audio-analyzer',
    )?.provider as IAudioAnalyzer
    const resolved = await analyzer.resolveDeviceSettings({ deviceId: 42 })
    expect(resolved).not.toBeNull()
    expect(resolved!.minConfidence).toBe(0.3)
    expect(resolved!.allowedClasses).toEqual([])
  })
})
