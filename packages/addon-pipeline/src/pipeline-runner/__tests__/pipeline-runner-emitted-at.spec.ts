/**
 * `emitInferenceResult` stamps `emittedAt`.
 *
 * This is the decisive half of the STARVED-vs-WAITING instrument: without a
 * runner-side emit stamp, a 10 s analytics silence and a 10 s late delivery are
 * indistinguishable, and the whole 2026-09-09 investigation is guesswork. The
 * consumer side lives in
 * `addon-post-analysis/src/pipeline-analytics/frame-lag-observer.ts`.
 *
 * `capturedAt` is asserted alongside because the two must stay INDEPENDENT: a
 * frame with no capture stamp still has to carry an emit stamp, or a runner
 * whose decoder omits `capturedAt` would silently take the emit stamp down
 * with it and read as "unknown" forever.
 */
import { describe, it, expect, vi } from 'vitest'
import type { DecodedFrame, FrameResult, FrameHandle, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'

function makeFrame(capturedAt?: number): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 4,
    height: 4,
    format: 'rgb',
    timestamp: 0,
    ...(capturedAt !== undefined ? { capturedAt } : {}),
  }
}

function makeResult(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'test-frame',
    deviceId: 1,
    timestamp: 0,
    width: 4,
    height: 4,
    detections: [],
    debug: { totalInferenceMs: 1 },
  }
}

interface AddonInternals {
  onInitialize(): Promise<unknown>
  emitInferenceResult(
    deviceId: number,
    frame: DecodedFrame,
    result: FrameResult,
    handle: FrameHandle | undefined,
  ): void
}

interface Harness {
  readonly internals: AddonInternals
  readonly emitted: SystemEvent[]
  readonly shutdown: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const { default: PipelineRunnerAddon } = await import('../index.js')
  const emitted: SystemEvent[] = []
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
  const ctx = {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: {
      emit: (e: SystemEvent) => {
        emitted.push(e)
      },
      subscribe: () => () => {},
      getRecent: () => [],
    },
    api: {
      pipelineExecutor: {
        runFrame: { mutate: vi.fn() },
        runPipeline: { mutate: vi.fn().mockResolvedValue(makeResult()) },
      },
      streamBroker: {},
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
  const addon = new PipelineRunnerAddon()
  Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
  const internals = addon as unknown as AddonInternals
  await internals.onInitialize()
  return {
    internals,
    emitted,
    shutdown: async () => {
      await addon.shutdown().catch(() => {
        /* ignore */
      })
    },
  }
}

function lastInferencePayload(emitted: readonly SystemEvent[]): Record<string, unknown> {
  const events = emitted.filter((e) => e.category === EventCategory.PipelineInferenceResult)
  expect(events).toHaveLength(1)
  return events[0]!.data as Record<string, unknown>
}

describe('PipelineRunnerAddon — emitInferenceResult stamps emittedAt', () => {
  it('stamps the emit wall-clock so a consumer can measure bus lag', async () => {
    const h = await makeHarness()
    const now = 1_757_390_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      h.internals.emitInferenceResult(1, makeFrame(now - 120), makeResult(), undefined)
      const data = lastInferencePayload(h.emitted)
      expect(data.emittedAt).toBe(now)
      expect(data.capturedAt).toBe(now - 120)
    } finally {
      vi.restoreAllMocks()
      await h.shutdown()
    }
  })

  it('stamps emittedAt even when the frame carries no capturedAt', async () => {
    const h = await makeHarness()
    const now = 1_757_390_500_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      h.internals.emitInferenceResult(2, makeFrame(), makeResult(), undefined)
      const data = lastInferencePayload(h.emitted)
      expect(data.emittedAt).toBe(now)
      expect(data.capturedAt).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      await h.shutdown()
    }
  })
})
