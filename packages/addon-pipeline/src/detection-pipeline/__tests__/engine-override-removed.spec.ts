/**
 * D646 — a benchmark can no longer reach the provider's engine state.
 *
 * `runPipeline` / `runPipelineBatch` used to accept an `engine` override and
 * honour it by ASSIGNING `this.currentEngine`, `this.engineFactory` and
 * `this.executor` on the shared provider for the duration of the call — across
 * `await`s, on a node that also serves live cameras — and by spawning a second
 * Python pool behind a warm cache. Any live `runPipeline` that resolved to the
 * node default in that window ran on the override engine.
 *
 * The override is gone: the cap no longer carries the field, the provider no
 * longer has the swap, and a caller that smuggles the key in anyway (a stale
 * script, an old addon) changes nothing and builds nothing. A benchmark names
 * its accelerator by `deviceKey` from the roster, which is a LOCAL per-call
 * choice that never touches shared state.
 */
import type { IScopedLogger, PipelineRunInput, PipelineStepInput } from '@camstack/types'
import { pipelineExecutorCapability } from '@camstack/types'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineFactory } from '../engine/engine-factory.js'
import { DetectionPipelineProvider } from '../provider.js'
import { getDefaultModelForFormat } from '../registry/step-definitions.js'

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeProvider(): DetectionPipelineProvider {
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    stubLogger(),
  )
  // The node-default pool is not what these tests are about — keep it from
  // spawning Python. Whatever the call does next, it does WITHOUT a pool.
  provider['ensureEngineFactory'] = async () => undefined
  return provider
}

/**
 * An engine that is NOT the provider's own (its default before init() is
 * python/onnx on the CPU) but that every platform could build — the old swap
 * clamped a platform-impossible override to a no-op, which would make this
 * test pass for the wrong reason on a Mac.
 */
const FOREIGN_ENGINE = {
  runtime: 'python',
  backend: 'onnx',
  format: 'onnx',
  device: 'cuda',
} as const

function onnxSteps(): readonly PipelineStepInput[] {
  return [
    {
      addonId: 'object-detection',
      modelId: getDefaultModelForFormat('object-detection', 'onnx'),
      enabled: true,
    },
  ]
}

async function tinyJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the engine override is gone from the cap (D646)', () => {
  it('runPipeline no longer declares an `engine` field — a smuggled one is stripped', () => {
    const schema = pipelineExecutorCapability.methods.runPipeline.input
    expect(Object.keys(schema.shape)).not.toContain('engine')
    const parsed = schema.parse({
      steps: onnxSteps(),
      image: new Uint8Array([1]),
      engine: FOREIGN_ENGINE,
    })
    expect('engine' in parsed).toBe(false)
  })

  it('runPipelineBatch no longer declares an `engine` field — a smuggled one is stripped', () => {
    const schema = pipelineExecutorCapability.methods.runPipelineBatch.input
    expect(Object.keys(schema.shape)).not.toContain('engine')
    const parsed = schema.parse({
      steps: onnxSteps(),
      frames: [{ data: new Uint8Array(3), format: 'rgb', width: 1, height: 1, timestamp: 1 }],
      engine: FOREIGN_ENGINE,
    })
    expect('engine' in parsed).toBe(false)
  })

  it('listLoadedEngines has no `warm-override` pool kind left to report', () => {
    const output = pipelineExecutorCapability.methods.listLoadedEngines.output
    const row = (kind: string): unknown[] => [
      {
        engineKey: 'python/onnx/cuda',
        engine: FOREIGN_ENGINE,
        modelsLoaded: [],
        inUseByCameras: [],
        kind,
        poolPid: null,
        idleMs: null,
        idleTtlMs: null,
      },
    ]
    expect(output.safeParse(row('runtime')).success).toBe(true)
    expect(output.safeParse(row('device-pool')).success).toBe(true)
    expect(output.safeParse(row('warm-override')).success).toBe(false)
  })
})

describe('the provider has no engine swap left to reach (D646)', () => {
  it('carries no override machinery at all', () => {
    const provider = makeProvider()
    expect('applyEngineOverride' in provider).toBe(false)
    expect('overrideCache' in provider).toBe(false)
    expect('evictOverrideCache' in provider).toBe(false)
    expect('scheduleOverrideCacheEviction' in provider).toBe(false)
  })

  it('runPipeline with a smuggled `engine` builds no pool and never re-points the engine', async () => {
    const provider = makeProvider()
    const engineBefore = provider['currentEngine']
    const init = vi.spyOn(EngineFactory.prototype, 'initialize').mockResolvedValue(undefined)
    // Records which engine the provider claimed to be on at the moment a
    // factory was consulted for this call's models — the window in which the
    // old swap served live traffic from the override pool.
    const enginesSeen: unknown[] = []
    vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockImplementation(() => {
      enginesSeen.push(provider['currentEngine'])
      return false
    })

    // A variable, not a literal: this is exactly how an out-of-date caller's
    // payload reaches the provider — structurally a `PipelineRunInput` with
    // one extra key the type no longer names.
    // A call with no camera is a benchmark: it builds a pool of its own (D910),
    // and for the NODE's engine — never for the one the payload smuggled in.
    const benchEngines: unknown[] = []
    provider['createBenchmarkFactory'] = async (_key, engine) => {
      benchEngines.push(engine)
      throw new Error('stubbed: no worker is spawned in this spec')
    }
    const smuggled = { steps: onnxSteps(), image: await tinyJpeg(), engine: FOREIGN_ENGINE }
    const input: PipelineRunInput = smuggled
    await provider.runPipeline(input).catch(() => undefined)

    expect(init).not.toHaveBeenCalled()
    for (const built of benchEngines) expect(built).toBe(engineBefore)
    for (const seen of enginesSeen) expect(seen).toBe(engineBefore)
    expect(provider['currentEngine']).toBe(engineBefore)
    expect(provider['engineFactory']).toBeNull()
  })

  it('runPipelineBatch with a smuggled `engine` builds no pool and never re-points the engine', async () => {
    const provider = makeProvider()
    const engineBefore = provider['currentEngine']
    const init = vi.spyOn(EngineFactory.prototype, 'initialize').mockResolvedValue(undefined)
    const enginesSeen: unknown[] = []
    vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockImplementation(() => {
      enginesSeen.push(provider['currentEngine'])
      return false
    })

    const smuggled = {
      steps: onnxSteps(),
      frames: [
        {
          data: new Uint8Array(16 * 16 * 3),
          format: 'rgb' as const,
          width: 16,
          height: 16,
          timestamp: 1,
        },
      ],
      engine: FOREIGN_ENGINE,
    }
    const input: Parameters<DetectionPipelineProvider['runPipelineBatch']>[0] = smuggled
    await provider.runPipelineBatch(input).catch(() => undefined)

    expect(init).not.toHaveBeenCalled()
    for (const seen of enginesSeen) expect(seen).toBe(engineBefore)
    expect(provider['currentEngine']).toBe(engineBefore)
    expect(provider['engineFactory']).toBeNull()
  })
})
