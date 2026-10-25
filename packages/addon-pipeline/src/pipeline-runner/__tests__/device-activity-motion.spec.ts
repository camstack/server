/**
 * The `device-activity` motion source, at the runner (D392).
 *
 * The runner's job for this source is small and specific, and all three parts
 * of it are load-bearing:
 *
 *  1. it reaches `reportMotion` like any other source, so the phase machine
 *     drives detection from it;
 *  2. it attaches NOTHING — no regions. The analyzer sends regions, onboard
 *     does not, and a device that is itself the moving object has no region
 *     worth sending;
 *  3. it must NOT open the frame-diff side-channel. That gate is
 *     `source === 'onboard'`, and a robot vacuum holding a gray decode open
 *     for a forty-minute cleaning run is exactly what this source exists to
 *     avoid.
 */
import type { IEventBus, RunnerCameraConfig } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'

type BusHandler = (event: { data: Record<string, unknown> }) => void

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return makeRunnerCameraConfig({ deviceId: 102, motionSources: ['device-activity'], ...patch })
}

interface ReportedMotion {
  readonly deviceId: number
  readonly detected: boolean
  readonly source: string
  readonly regions: unknown
}

/**
 * Private internals driven white-box. One documented type-boundary cast, the
 * same pattern `onboard-motion-analyzer.spec.ts` uses.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  attached: Map<number, { config: RunnerCameraConfig }>
  runner: { reportMotion: (...args: readonly unknown[]) => void } | null
  onboardAnalyzerSubs: Map<number, () => void>
}

async function harness(config: RunnerCameraConfig) {
  const handlers = new Map<string, BusHandler>()
  const reported: ReportedMotion[] = []
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
  const eventBus = {
    emit: vi.fn(),
    subscribe: vi.fn((filter: { category: string }, handler: BusHandler) => {
      handlers.set(filter.category, handler)
      return () => undefined
    }),
    getRecent: () => [],
  }
  const ctx = {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: eventBus as unknown as IEventBus,
    api: {
      pipelineExecutor: { runPipeline: { mutate: vi.fn().mockResolvedValue(null) } },
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

  const addon = new PipelineRunnerAddon()
  Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
  const internals = addon as unknown as AddonInternals
  await internals.onInitialize()

  internals.attached.set(config.deviceId, { config })
  internals.runner = {
    reportMotion: (...args: readonly unknown[]) => {
      reported.push({
        deviceId: Number(args[0]),
        detected: args[1] === true,
        source: String(args[2]),
        regions: args[3],
      })
    },
  }

  const fire = (source: string, detected: boolean): void => {
    const handler = handlers.get(EventCategory.MotionOnMotionChanged)
    if (!handler) throw new Error('the runner did not subscribe to motion events')
    handler({ data: { deviceId: config.deviceId, detected, source, timestamp: Date.now() } })
  }

  return { addon, internals, reported, fire }
}

describe('the runner and a device-activity motion event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reaches the phase machine through reportMotion, carrying the source', async () => {
    const h = await harness(makeConfig())
    h.fire('device-activity', true)
    expect(h.reported).toEqual([
      { deviceId: 102, detected: true, source: 'device-activity', regions: undefined },
    ])
  })

  it('attaches no regions — the only fact is that the device is working', async () => {
    const h = await harness(makeConfig())
    h.fire('device-activity', true)
    expect(h.reported[0]?.regions).toBeUndefined()
  })

  it('carries the falling edge too — a level has one, unlike onboard motion', async () => {
    const h = await harness(makeConfig())
    h.fire('device-activity', true)
    h.fire('device-activity', false)
    expect(h.reported.map((r) => r.detected)).toEqual([true, false])
  })

  it('does NOT open the frame-diff analyzer side-channel', async () => {
    const h = await harness(makeConfig())
    h.fire('device-activity', true)
    await Promise.resolve()
    expect(h.internals.onboardAnalyzerSubs.size).toBe(0)
  })

  it('is ignored on a camera whose sources do not list it', async () => {
    const h = await harness(makeConfig({ motionSources: ['analyzer'] }))
    h.fire('device-activity', true)
    expect(h.reported).toHaveLength(0)
  })

  it('does not disturb the onboard path on the same camera', async () => {
    const h = await harness(makeConfig({ motionSources: ['onboard', 'device-activity'] }))
    h.fire('onboard', true)
    h.fire('device-activity', true)
    expect(h.reported.map((r) => r.source)).toEqual(['onboard', 'device-activity'])
  })
})
