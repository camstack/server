import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunnerLocalMetricsSchema } from '@camstack/types'
import PipelineRunnerAddon from '../index.js'
import { emptyFrameLazyCounters } from '../frame-lazy-metrics.js'

interface AddonInternals {
  onInitialize(): Promise<unknown>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

function makeFakeCtx() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
  return {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: { emit: vi.fn(), subscribe: () => () => {}, getRecent: () => [] },
    api: {
      pipelineExecutor: {
        runFrame: { mutate: vi.fn() },
        runPipeline: { mutate: vi.fn() },
      },
      streamBroker: {
        listAllProfileSlots: { query: vi.fn().mockResolvedValue([]) },
        getStreamWithCodec: { mutate: vi.fn() },
        releaseStreamWithCodec: { mutate: vi.fn() },
      },
    },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
  }
}

describe('getLocalMetrics frame-lazy telemetry', () => {
  let addon: PipelineRunnerAddon

  afterEach(async () => {
    await addon?.shutdown().catch(() => undefined)
  })

  it('exposes bounded frameLazy counters on getLocalMetrics', async () => {
    addon = new PipelineRunnerAddon()
    Object.defineProperty(addon, 'ctx', { value: makeFakeCtx(), configurable: true })
    await asInternals(addon).onInitialize()

    const metrics = await addon.getLocalMetrics()
    expect(metrics.frameLazy).toBeDefined()
    expect(Object.keys(metrics.frameLazy!.node).sort()).toEqual(
      Object.keys(emptyFrameLazyCounters()).sort(),
    )
    expect(metrics.frameLazy!.cameras).toEqual([])
    expect(metrics.frameLazy!.node.residentRefs).toBeGreaterThanOrEqual(0)
    expect(metrics.frameLazy!.node.retainedWritesAvoided).toBeGreaterThanOrEqual(0)
    const parsed = RunnerLocalMetricsSchema.parse(metrics)
    expect(parsed.nodeId).toBe('hub')
    expect(parsed.activeCameras).toBe(0)
  })
})
