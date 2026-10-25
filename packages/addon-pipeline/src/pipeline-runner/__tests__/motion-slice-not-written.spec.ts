/**
 * D696: the runner's phase machine no longer writes a camera's `motion`
 * runtime slice; the orchestrator is its only writer, with the EFFECTIVE
 * motion. The phase keeps its own `DetectionPhaseTransition`. The runner
 * advertises the change on `getLocalLoad().motionSliceWriter`, which is what
 * lets the orchestrator start writing without two writers.
 *
 * D1 (task M3 inventory): every on-motion detection session attaches
 * `always-on`, whose synthetic ON wrote `detected: true`, and its detach wrote
 * nothing, so the slice was left `true` after the session. With no write, a
 * session can no longer leave the slice stuck.
 *
 * White-box like `sensor-owned-suppresses-analyzer.spec.ts`: the real runner
 * built by `onInitialize`, driven through its own registration and motion API.
 */
import type { IEventBus } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'
import type { CameraRegistration } from '../runner.js'

interface RunnerSurface {
  registerCamera(deviceId: number, registration: CameraRegistration): void
  unregisterCamera(deviceId: number): void
  reportMotion(deviceId: number, detected: boolean, source?: 'onboard'): void
}

interface AddonInternals {
  onInitialize(): Promise<unknown>
  onShutdown(): Promise<void>
  runner: RunnerSurface | null
}

interface Emitted {
  readonly category: string
  readonly data: Readonly<Record<string, unknown>>
}

const CAMERA = 102

async function boot() {
  const emitted: Emitted[] = []
  const setCapSlice = vi.fn(async () => undefined)
  const fetchDevice = vi.fn(async () => ({ deviceState: { setCapSlice } }))
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
    emit: vi.fn((event: Emitted) => {
      emitted.push(event)
    }),
    subscribe: vi.fn(() => () => undefined),
    getRecent: () => [],
  }
  const ctx = {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: eventBus as unknown as IEventBus,
    api: {},
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    fetchDevice,
  }
  const addon = new PipelineRunnerAddon()
  Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
  const internals = addon as unknown as AddonInternals
  await internals.onInitialize()
  const runner = internals.runner
  if (runner === null) throw new Error('the runner did not start')
  const phases = (): readonly Readonly<Record<string, unknown>>[] =>
    emitted.filter((e) => e.category === EventCategory.DetectionPhaseTransition).map((e) => e.data)
  return { addon, internals, runner, setCapSlice, fetchDevice, phases }
}

describe('the runner never writes a camera motion slice (D696)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a session attach (always-on) and its detach write nothing — the slice cannot be left stuck true (D1)', async () => {
    const h = await boot()
    h.runner.registerCamera(CAMERA, { detectionMode: 'always-on', fps: 5, motionCooldownMs: 5_000 })
    await vi.advanceTimersByTimeAsync(50)
    h.runner.unregisterCamera(CAMERA)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.fetchDevice).not.toHaveBeenCalled()
    expect(h.setCapSlice).not.toHaveBeenCalled()
    // The phase still says what it did, on its own event — opened by the
    // attach and CLOSED by the detach; with no session trigger on the attach
    // it names no motion source, never a guessed one (2026-10-06:
    // the close did not exist, so every consumer of the event latched
    // `active`, and the open claimed `analyzer` on onboard-only cameras).
    expect(h.phases()).toEqual([
      expect.objectContaining({ deviceId: CAMERA, to: 'active', cause: 'attach' }),
      expect.objectContaining({ deviceId: CAMERA, to: 'watching', cause: 'detach' }),
    ])
    for (const p of h.phases()) expect(p).not.toHaveProperty('source')
    await h.internals.onShutdown()
  })

  it('the session attach event names the motion that opened it — an attached sensor by id and name', async () => {
    const h = await boot()
    h.runner.registerCamera(CAMERA, {
      detectionMode: 'always-on',
      fps: 5,
      sessionTrigger: {
        source: 'onboard',
        triggeredBy: { kind: 'sensor', deviceId: 3299 },
        sensorName: 'PIR front door',
      },
    })
    h.runner.unregisterCamera(CAMERA)
    const [open, close] = h.phases()
    expect(open).toMatchObject({
      to: 'active',
      cause: 'attach',
      source: 'onboard',
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
      sensorName: 'PIR front door',
    })
    expect(open).not.toHaveProperty('cooldownMs')
    expect(close).toMatchObject({ to: 'watching', cause: 'detach' })
    expect(close).not.toHaveProperty('source')
    await h.internals.onShutdown()
  })

  it('a standing on-motion camera: active then watching after the cooldown, and no slice write', async () => {
    const h = await boot()
    h.runner.registerCamera(CAMERA, { detectionMode: 'on-motion', fps: 5, motionCooldownMs: 5_000 })
    h.runner.reportMotion(CAMERA, true, 'onboard')
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.phases().map((p) => p['to'])).toEqual(['active', 'watching'])
    expect(h.fetchDevice).not.toHaveBeenCalled()
    expect(h.setCapSlice).not.toHaveBeenCalled()
    await h.internals.onShutdown()
  })

  it('advertises on getLocalLoad that the orchestrator writes the slice', async () => {
    const h = await boot()
    const load = await h.addon.getLocalLoad()
    expect(load.motionSliceWriter).toBe('orchestrator')
    await h.internals.onShutdown()
  })
})
