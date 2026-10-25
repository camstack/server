/**
 * D475: on a camera whose motion comes from a SENSOR (firmware `onboard`, or
 * a device reporting its own `device-activity`), the analyzer's transitions
 * must never reach the phase machine — even when `motionSources` lists BOTH.
 * The operator's rule, verbatim: "la pipeline non deve mai sovrascrivere ciò
 * che i sensori fanno" (the pipeline must never overwrite what the sensors
 * do). `reportMotion` drives the phase machine — so an analyzer edge that
 * reaches it on a sensor-owned camera would silently re-describe what the
 * sensor decided. (The phase no longer writes the `motion` slice, D696; the
 * orchestrator applies the same rule to the slice it writes.)
 *
 * A camera with `motionSources: ['analyzer']` only (no sensor) must be
 * UNCHANGED by this — the analyzer keeps driving the phase machine exactly
 * as it did before D475.
 *
 * Harness copied from `device-activity-motion.spec.ts` — same white-box
 * internals cast, same fire() helper.
 */
import type { IEventBus, RunnerCameraConfig } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon, { cameraOwnsMotionViaSensor } from '../index.js'

type BusHandler = (event: { data: Record<string, unknown> }) => void

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return makeRunnerCameraConfig({
    deviceId: 102,
    motionSources: ['onboard', 'analyzer'],
    ...patch,
  })
}

interface ReportedMotion {
  readonly deviceId: number
  readonly detected: boolean
  readonly source: string
  readonly regions: unknown
}

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

describe('cameraOwnsMotionViaSensor', () => {
  it('is false for analyzer-only cameras — unaffected by D475', () => {
    expect(cameraOwnsMotionViaSensor(['analyzer'])).toBe(false)
  })
  it('is true when onboard is present, even alongside analyzer', () => {
    expect(cameraOwnsMotionViaSensor(['onboard', 'analyzer'])).toBe(true)
  })
  it('is true when device-activity is present, even alongside analyzer', () => {
    expect(cameraOwnsMotionViaSensor(['device-activity', 'analyzer'])).toBe(true)
  })
  it('is true for a sensor source alone', () => {
    expect(cameraOwnsMotionViaSensor(['onboard'])).toBe(true)
  })
  it('is false for an empty list', () => {
    expect(cameraOwnsMotionViaSensor([])).toBe(false)
  })
})

describe('the runner suppresses analyzer-driven reportMotion on a sensor-owned camera (D475)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('onboard reaches the phase machine, analyzer does not, on a camera with both sources', async () => {
    const h = await harness(makeConfig({ motionSources: ['onboard', 'analyzer'] }))
    h.fire('onboard', true)
    h.fire('analyzer', true)
    expect(h.reported.map((r) => r.source)).toEqual(['onboard'])
  })

  it('device-activity reaches the phase machine, analyzer does not, on that same pairing', async () => {
    const h = await harness(makeConfig({ motionSources: ['device-activity', 'analyzer'] }))
    h.fire('device-activity', true)
    h.fire('analyzer', true)
    expect(h.reported.map((r) => r.source)).toEqual(['device-activity'])
  })

  it('an analyzer-ONLY camera is unaffected — the analyzer still drives the phase machine', async () => {
    const h = await harness(makeConfig({ motionSources: ['analyzer'] }))
    h.fire('analyzer', true)
    expect(h.reported.map((r) => r.source)).toEqual(['analyzer'])
  })

  it('the suppression covers the falling edge too — a sensor camera never sees an analyzer OFF either', async () => {
    const h = await harness(makeConfig({ motionSources: ['onboard', 'analyzer'] }))
    h.fire('onboard', true)
    h.fire('analyzer', false)
    expect(h.reported.map((r) => r.source)).toEqual(['onboard'])
  })
})
