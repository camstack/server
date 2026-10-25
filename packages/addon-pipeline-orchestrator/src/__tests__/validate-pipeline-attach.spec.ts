/**
 * Task G5 (Gate B) — orchestrator attach-time surfacing.
 *
 * `attachOn` calls the executor's `validatePipeline`, NODE-PINNED to the
 * TARGET node (so it validates against that node's engine format), before
 * `pipelineRunner.attachCamera.mutate`. This is non-fatal by design: a
 * validation failure/null (cap unreachable, node not up yet, …) must NEVER
 * block the attach — the runtime already drops bad steps per-step (G2's
 * `resolveInputSteps` guard), so refusing the attach here would strand the
 * camera over a problem the runtime already tolerates.
 *
 * Driven through the public `startDetection` entrypoint (same seam as
 * `first-dispatch-node-reresolve.spec.ts`) rather than calling the private
 * `attachOn` directly — this exercises the real dispatch → balancer →
 * attachOn path end to end.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readNodePin } from '@camstack/types'
import type { CameraDetectionConfig, IScopedLogger, PipelineSchema } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'

function model(id: string, formats: readonly string[] = ['onnx']) {
  return {
    id,
    name: id,
    formats: Object.fromEntries(formats.map((f) => [f, { downloaded: false, sizeMB: 1 }])),
  }
}

function makeCatalog(): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
    slots: [
      {
        id: 'detector',
        label: 'Detector',
        priority: 0,
        parentSlot: null,
        addons: [
          {
            id: 'object-detection',
            name: 'object-detection',
            slot: 'detector',
            inputClasses: [],
            outputClasses: ['person'],
            childSlots: [],
            models: [model('yolov9s'), model('yolov9n')],
            defaultModelId: 'yolov9s',
            defaultConfidence: 0.5,
          },
        ],
      },
    ],
  }
}

function makeDetectionConfig(
  overrides: Partial<CameraDetectionConfig> = {},
): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

/** Captures every `validatePipeline` call's `(input, opts)` pair. */
interface ValidateCall {
  readonly input: { readonly steps: readonly unknown[] }
  readonly opts: unknown
}

function makeCapturingLogger(): { logger: IScopedLogger; warns: unknown[][]; infos: unknown[][] } {
  const warns: unknown[][] = []
  const infos: unknown[][] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (...args: unknown[]) => {
      infos.push(args)
    },
    warn: (...args: unknown[]) => {
      warns.push(args)
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns, infos }
}

describe('attachOn — Gate B pre-init validatePipeline surfacing (Task G5)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('calls validatePipeline NODE-PINNED to the target node before attachCamera, and attach still succeeds', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const calls: ValidateCall[] = []
    const catalog = makeCatalog()
    const { logger } = makeCapturingLogger()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
      logger,
      providers: {
        'pipeline-executor': {
          getSchema: () => catalog,
          validatePipeline: (input: { steps: readonly unknown[] }, opts: unknown) => {
            calls.push({ input, opts })
            return { ok: true, issues: [], substitutions: [], format: 'onnx' }
          },
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(701, makeDetectionConfig())

    expect(calls.length).toBeGreaterThan(0)
    // Every call is node-pinned to 'hub' — the TARGET node this camera
    // dispatched to (single-node fixture, so hub is the only option, but
    // the pin must be present regardless).
    for (const call of calls) {
      expect(readNodePin((call.opts as { context?: unknown } | undefined)?.context)).toBe('hub')
    }

    // Attach still happened despite validatePipeline being in the loop.
    expect(runnerHub.attachedCameras.has(701)).toBe(true)
  })

  it('does NOT block attachCamera when validatePipeline throws/rejects', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const catalog = makeCatalog()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
      providers: {
        'pipeline-executor': {
          getSchema: () => catalog,
          validatePipeline: () => {
            throw new Error('executor unreachable')
          },
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await expect(addon.startDetection(702, makeDetectionConfig())).resolves.not.toThrow()

    expect(runnerHub.attachedCameras.has(702)).toBe(true)
  })

  it('logs a warning when validatePipeline reports HARD issues, but still attaches', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const catalog = makeCatalog()
    const { logger, warns } = makeCapturingLogger()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
      logger,
      providers: {
        'pipeline-executor': {
          getSchema: () => catalog,
          validatePipeline: () => ({
            ok: false,
            issues: [{ addonId: 'object-detection', kind: 'unknown-addon', detail: 'boom' }],
            substitutions: [],
            format: 'onnx',
          }),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(703, makeDetectionConfig())

    expect(warns.length).toBeGreaterThan(0)
    expect(runnerHub.attachedCameras.has(703)).toBe(true)
  })

  it('logs at info (not warn) when only substitutions are present (ok:true)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const catalog = makeCatalog()
    const { logger, warns, infos } = makeCapturingLogger()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
      logger,
      providers: {
        'pipeline-executor': {
          getSchema: () => catalog,
          validatePipeline: () => ({
            ok: true,
            issues: [],
            substitutions: [
              { addonId: 'object-detection', chosen: 'a', running: 'b', format: 'onnx' },
            ],
            format: 'onnx',
          }),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(704, makeDetectionConfig())

    expect(infos.some((args) => String(args[0]).includes('substitutions'))).toBe(true)
    // Scoped to the path under test. The attach also reads `zones.listZones`,
    // which now reconciles the device-state `zones` mirror off that read
    // (`zones-provider.ts`) — and this harness seeds no device, so the mirror
    // write legitimately warns. That warn belongs to another subject.
    const validationWarns = warns.filter((args) => !String(args[0]).includes('zones mirror'))
    expect(validationWarns.length).toBe(0)
    expect(runnerHub.attachedCameras.has(704)).toBe(true)
  })
})
