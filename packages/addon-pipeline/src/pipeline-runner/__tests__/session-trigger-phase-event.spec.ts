/**
 * The session trigger travels the WHOLE runner path: `attachCamera` (the cap
 * method the orchestrator calls) → `registerCamera` → the emitted
 * `DetectionPhaseTransition`. A session opened by an attached sensor must say
 * so on the event, by id and name — never the `analyzer` the attach used to
 * claim (D672 rule 11 as amended 2026-10-06).
 */
import { EventCategory } from '@camstack/types'
import type { RunnerCameraConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return makeRunnerCameraConfig({ deviceId: 1, ...patch })
}

/**
 * Typed accessor for private internals we need to drive in tests.
 * Using an accessor interface (not `as any`) keeps the "no as-casts" rule —
 * we cast once here at the boundary with a clear doc comment.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  // Single type-boundary cast — private access for white-box testing.
  return addon as unknown as AddonInternals
}

function makeFakeCtx(_subscribeMotionFramesImpl?: () => Promise<(() => void) | null>) {
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
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: () => [],
    },
    api: {
      pipelineExecutor: {
        runPipeline: { mutate: vi.fn().mockResolvedValue(null) },
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
    fetchDevice: vi.fn(),
  }
  return { ctx, logger }
}

interface EmittedEvent {
  readonly category: string
  readonly data: Readonly<Record<string, unknown>>
}

function isEmittedEvent(value: unknown): value is EmittedEvent {
  return typeof value === 'object' && value !== null && 'category' in value && 'data' in value
}

describe('attachCamera → DetectionPhaseTransition carries the session trigger', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    vi.useFakeTimers()
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  it('a session opened by an attached sensor names it on the attach event', async () => {
    const { ctx } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    vi.spyOn(
      addon as unknown as { subscribeDetectionFrames(c: RunnerCameraConfig): Promise<null> },
      'subscribeDetectionFrames',
    ).mockResolvedValue(null)

    await addon.attachCamera(
      makeConfig({
        deviceId: 103,
        detectionMode: 'always-on',
        motionSources: [],
        sessionTrigger: {
          source: 'onboard',
          triggeredBy: { kind: 'sensor', deviceId: 3299 },
          sensorName: 'PIR porch',
        },
      }),
    )

    const phases = ctx.eventBus.emit.mock.calls
      .map((c: readonly unknown[]) => c[0])
      .filter(isEmittedEvent)
      .filter((e) => e.category === EventCategory.DetectionPhaseTransition)
    expect(phases).toHaveLength(1)
    expect(phases[0]!.data).toMatchObject({
      deviceId: 103,
      to: 'active',
      cause: 'attach',
      source: 'onboard',
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
      sensorName: 'PIR porch',
    })
  })
})
