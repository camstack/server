/**
 * D650 — every path that REPLACES a live attach's steps goes through the one
 * owner (`resolveAttachPipeline`), on the device the camera is already elected
 * onto: the executor-readiness re-attach, its deferred "stale empty" sweep,
 * and the package-zone re-attach. Each used to re-resolve on the node DEFAULT
 * format (tflite here) and drop the device's provisioning: a GPU-elected
 * camera lost its faces on the next readiness epoch.
 *
 * Real `PipelineSettingsStore`, real `PlacementLedger`, the real owner. Faked:
 * the readiness registry (to fire the transition), the event bus, attachOn.
 */
import type {
  IEventBus,
  IReadinessHandler,
  IReadinessRegistry,
  IScopedLogger,
  PipelineStepInputOutput,
  RunnerCameraConfig,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AttachPipelineOutcome, resolveAttachPipeline } from '../attach-pipeline.js'
import { NodeLifecycleHandler, type NodeLifecycleHandlerDeps } from '../node-lifecycle-handler.js'
import { reattachAfterPackageZoneChange } from '../package-zone-reattach.js'
import type { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { PlacementLedger } from '../placement-ledger.js'
import {
  CORAL_GPU_ELIGIBLE,
  GPU,
  NODE,
  makeRealStore,
  seedCoralGpuNode,
} from './attach-pipeline-fixtures.js'
import { makeSilentLogger } from './e2e-helpers.js'

const DEVICE_ID = 5

const eventBus: IEventBus = {
  emit: () => {},
  subscribe: () => () => {},
} as unknown as IEventBus

/** A camera ALREADY attached on the GPU, carrying the tflite-default tree. */
function staleCpuConfig(steps: readonly PipelineStepInputOutput[]): RunnerCameraConfig {
  return {
    deviceId: DEVICE_ID,
    deviceKey: GPU,
    steps,
    audio: null,
    motionCooldownMs: 1,
    motionFps: 1,
    detectionFps: 1,
    motionStreamId: 's',
    detectionStreamId: 's',
    motionSources: [],
    pipelineEnabled: true,
    zones: [],
    detectionMode: 'always-on',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    preRollInferenceEnabled: false,
    preRollInferenceFrames: 0,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
  }
}

function ownerOn(
  store: PipelineSettingsStore,
  eligible: Readonly<Record<string, number>> = CORAL_GPU_ELIGIBLE,
): (input: {
  readonly deviceId: number
  readonly nodeId: string
  readonly deviceKey: string | undefined
}) => Promise<AttachPipelineOutcome> {
  // What `PlacementService.resolveAttachPipelineOnDevice` does, minus the
  // eligibility read (the node's enabled devices are the fixture's).
  return (input) => resolveAttachPipeline({ ...input, eligible, caps: {} }, store)
}

/** A logger that keeps its `error` messages — the refusal lines under test. */
function makeErrorCapture(): { readonly logger: IScopedLogger; readonly errors: string[] } {
  const errors: string[] = []
  const logger: IScopedLogger = {
    ...makeSilentLogger(),
    error: (message: string) => void errors.push(message),
  }
  return { logger, errors }
}

/** A device the fixture catalog ships NO object-detection build for. */
const ANE = 'coreml:ane'
const CORAL_GPU_ANE_ELIGIBLE: Readonly<Record<string, number>> = { ...CORAL_GPU_ELIGIBLE, [ANE]: 1 }

function faceOf(
  config: RunnerCameraConfig | null | undefined,
): PipelineStepInputOutput | undefined {
  const root = (config?.steps ?? []).find((s) => s.addonId === 'object-detection')
  return (root?.children ?? []).find((c) => c.addonId === 'face-detection')
}

interface LifecycleHarness {
  readonly ledger: PlacementLedger
  readonly attached: Map<number, RunnerCameraConfig>
  readonly fireReady: (epoch: number) => void
  /** How many readiness passes have run to completion (their last act). */
  readonly passesDone: () => number
}

interface LifecycleOptions {
  readonly owner?: ReturnType<typeof ownerOn>
  readonly logger?: IScopedLogger
  readonly onRunnerReady?: (nodeId: string) => void
  readonly onAttach?: (deviceId: number) => void
}

function makeLifecycle(
  store: PipelineSettingsStore,
  opts: LifecycleOptions = {},
): LifecycleHarness {
  const ledger = new PlacementLedger({ eventBus, logger: makeSilentLogger() })
  const attached = new Map<number, RunnerCameraConfig>()
  let handler: IReadinessHandler | null = null
  let passes = 0
  const registry = {
    onReadyState: (_cap: string, _scope: unknown, h: IReadinessHandler) => {
      handler = h
      return () => {}
    },
  } as unknown as IReadinessRegistry
  const deps = {
    ledger,
    settingsStore: store,
    attachOn: async (_nodeId: string, config: RunnerCameraConfig) => {
      opts.onAttach?.(config.deviceId)
      attached.set(config.deviceId, config)
    },
    ...(opts.onRunnerReady === undefined ? {} : { onRunnerReady: opts.onRunnerReady }),
    resolveAttachPipeline: opts.owner ?? ownerOn(store),
    rebalance: async () => ({ migrated: 0 }),
    scheduleReconcile: () => {
      passes++
    },
    schedulePendingRetry: () => {},
    localNodeId: () => NODE,
    logger: opts.logger ?? makeSilentLogger(),
    eventBus,
    sharedRegistry: registry,
  } as unknown as NodeLifecycleHandlerDeps
  const lifecycle = new NodeLifecycleHandler(deps)
  lifecycle.subscribeToDetectionPipelineReadiness(NODE)
  return {
    ledger,
    attached,
    passesDone: () => passes,
    fireReady: (epoch) =>
      handler?.({
        capName: 'pipeline-executor',
        scope: { type: 'node', nodeId: NODE },
        state: 'ready',
        epoch,
        generation: 'g',
        sourceNodeId: NODE,
        ts: Date.now(),
        durationInPrevState: 0,
      }),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('readiness re-attach goes through the owner (D650)', () => {
  it('a GPU-elected camera on a tflite-default node keeps its faces across a readiness epoch', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const h = makeLifecycle(store)
    h.ledger.setConfig(
      DEVICE_ID,
      staleCpuConfig([{ addonId: 'object-detection', enabled: true, children: [] }]),
    )
    h.ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)

    h.fireReady(1)
    await vi.waitFor(() => expect(h.attached.has(DEVICE_ID)).toBe(true))

    const next = h.attached.get(DEVICE_ID)
    expect(next?.deviceKey).toBe(GPU)
    expect(faceOf(next)?.modelId).toBe('scrfd-10g')
    expect(next?.inferenceDevices?.map((d) => d.deviceKey)).toEqual(['edgetpu:usb', GPU])
    expect(faceOf(h.ledger.getConfig(DEVICE_ID))?.modelId).toBe('scrfd-10g')
  })

  it('the deferred stale-empty sweep re-attaches through the owner too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const h = makeLifecycle(store)
    h.ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)
    h.fireReady(1)
    // The camera lands with EMPTY steps AFTER the readiness pass iterated —
    // only the deferred sweep can pick it up.
    await vi.waitFor(() => expect(h.passesDone()).toBe(1))
    expect(h.attached.size).toBe(0)
    h.ledger.setConfig(DEVICE_ID, staleCpuConfig([]))

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(h.attached.has(DEVICE_ID)).toBe(true))

    expect(faceOf(h.attached.get(DEVICE_ID))?.modelId).toBe('scrfd-10g')
  })
})

describe('readiness never places an unplaced placeholder (D650 round 2)', () => {
  it('skips a ledger config with no assignment and no elected device', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const h = makeLifecycle(store)
    // The standing path's placeholder: known to the ledger, never placed.
    const { deviceKey: _elected, ...placeholder } = staleCpuConfig([
      { addonId: 'object-detection', enabled: true, children: [] },
    ])
    h.ledger.setConfig(DEVICE_ID, placeholder)

    h.fireReady(1)
    await vi.waitFor(() => expect(h.passesDone()).toBe(1))

    expect(h.attached.has(DEVICE_ID)).toBe(false)
  })

  it('still re-attaches an unassigned config that HAS an elected device', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const h = makeLifecycle(store)
    h.ledger.setConfig(
      DEVICE_ID,
      staleCpuConfig([{ addonId: 'object-detection', enabled: true, children: [] }]),
    )

    h.fireReady(1)
    await vi.waitFor(() => expect(h.passesDone()).toBe(1))

    expect(h.attached.has(DEVICE_ID)).toBe(true)
  })
})

describe('a re-attach whose elected device cannot run the camera root is refused (D650 round 3)', () => {
  // The camera sits on a device the catalog ships no object-detection build
  // for. The live attach is kept as it is — never replaced by one that detects
  // nothing — and the refusal is said, per camera.
  function liveOnAne(): RunnerCameraConfig {
    return {
      ...staleCpuConfig([{ addonId: 'object-detection', enabled: true, children: [] }]),
      deviceKey: ANE,
    }
  }

  it('readiness re-attach: nothing attached, ledger config untouched, one error line', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const { logger, errors } = makeErrorCapture()
    const h = makeLifecycle(store, { owner: ownerOn(store, CORAL_GPU_ANE_ELIGIBLE), logger })
    const live = liveOnAne()
    h.ledger.setConfig(DEVICE_ID, live)
    h.ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)

    h.fireReady(1)
    await vi.waitFor(() => expect(h.passesDone()).toBe(1))

    expect(h.attached.size).toBe(0)
    expect(h.ledger.getConfig(DEVICE_ID)).toEqual(live)
    expect(errors.filter((e) => e.startsWith('re-attach refused'))).toHaveLength(1)
  })

  it('the deferred stale-empty sweep refuses the same way', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const { logger, errors } = makeErrorCapture()
    const h = makeLifecycle(store, { owner: ownerOn(store, CORAL_GPU_ANE_ELIGIBLE), logger })
    h.ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)
    h.fireReady(1)
    await vi.waitFor(() => expect(h.passesDone()).toBe(1))
    const live = { ...liveOnAne(), steps: [] }
    h.ledger.setConfig(DEVICE_ID, live)

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() =>
      expect(errors.filter((e) => e.startsWith('re-attach refused'))).toHaveLength(1),
    )

    expect(h.attached.size).toBe(0)
    expect(h.ledger.getConfig(DEVICE_ID)).toEqual(live)
  })

  it('package-zone re-attach: the live attach is kept and the refusal logged', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const ledger = new PlacementLedger({ eventBus, logger: makeSilentLogger() })
    const live = liveOnAne()
    ledger.setConfig(DEVICE_ID, live)
    ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)
    const { logger, errors } = makeErrorCapture()
    const attached: RunnerCameraConfig[] = []

    await reattachAfterPackageZoneChange(
      {
        ledger,
        resolveAttachPipeline: ownerOn(store, CORAL_GPU_ANE_ELIGIBLE),
        attachOn: async (_n, config) => {
          attached.push(config)
        },
        logger,
      },
      DEVICE_ID,
    )

    expect(attached).toEqual([])
    expect(ledger.getConfig(DEVICE_ID)).toEqual(live)
    expect(errors.filter((e) => e.startsWith('package zone-rule re-attach refused'))).toHaveLength(
      1,
    )
  })
})

describe('package-zone re-attach goes through the owner (D650)', () => {
  it('keeps the GPU election, its faces and its provisioning', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const ledger = new PlacementLedger({ eventBus, logger: makeSilentLogger() })
    ledger.setConfig(
      DEVICE_ID,
      staleCpuConfig([{ addonId: 'object-detection', enabled: true, children: [] }]),
    )
    ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)
    const attached: RunnerCameraConfig[] = []

    await reattachAfterPackageZoneChange(
      {
        ledger,
        resolveAttachPipeline: ownerOn(store),
        attachOn: async (_n, config) => {
          attached.push(config)
        },
        logger: makeSilentLogger(),
      },
      DEVICE_ID,
    )

    expect(attached).toHaveLength(1)
    expect(attached[0]?.deviceKey).toBe(GPU)
    expect(faceOf(attached[0])?.modelId).toBe('scrfd-10g')
  })
})

describe('a runner coming up closes the motion-slice gate BEFORE re-attach (D696, review F1)', () => {
  it('a new readiness epoch calls onRunnerReady synchronously, before any attach; a replay does not', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const order: string[] = []
    const h = makeLifecycle(store, {
      onRunnerReady: (nodeId) => order.push(`forget:${nodeId}`),
      onAttach: (deviceId) => order.push(`attach:${deviceId}`),
    })
    h.ledger.setConfig(
      DEVICE_ID,
      staleCpuConfig([{ addonId: 'object-detection', enabled: true, children: [] }]),
    )
    h.ledger.recordAssignment(DEVICE_ID, NODE, 'capacity', false)

    h.fireReady(1)
    // Synchronous: the gate is closed before the handler's first await.
    expect(order).toEqual([`forget:${NODE}`])
    await vi.waitFor(() => expect(h.attached.has(DEVICE_ID)).toBe(true))
    expect(order).toEqual([`forget:${NODE}`, `attach:${DEVICE_ID}`])

    h.fireReady(1)
    await vi.waitFor(() => expect(h.passesDone()).toBeGreaterThanOrEqual(1))
    expect(order.filter((o) => o.startsWith('forget'))).toHaveLength(1)
  })
})
