/**
 * D725 — a stored pin to a model DELETED from its step's catalog is reset to
 * the step default, in the store, by the orchestrator.
 *
 * The case that asked for it: the hub's Coral (`edgetpu:usb`) kept
 * `object-detection: ssdlite-mobiledet-coco-edgetpu` after D703 deleted that
 * model. Nothing reset it, the admin UI showed "is a removed model" on every
 * visit, and the "Use default" button only edited a draft that was never saved.
 *
 * What these specs pin:
 *   - the boot sweep clears a per-(node, device) pin and PERSISTS it, keeping
 *     the step's other fields (settings);
 *   - provisioning (the dispatch read) then carries no model for the step, so
 *     the node resolves its format default;
 *   - a registered custom model with the same id is NOT reset;
 *   - an unreadable custom-model registry resets NOTHING;
 *   - every write path re-runs the sweep (per (node, device), cluster rows) —
 *     a camera carries no model to sweep (D927);
 *   - each reset is a WARN naming the old id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeBroker, makeFakeContext } from './e2e-helpers.js'
import { sweepAgentSettingsPins } from '../removed-model-pin-reset.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

const REMOVED = 'ssdlite-mobiledet-coco-edgetpu'
const SURVIVOR = 'ssd-mobilenet-v2-coco-edgetpu'
const CORAL = 'edgetpu:usb'

interface CapturedLog {
  readonly level: string
  readonly message: string
  readonly extras?: LogExtras
}

function makeCapturingLogger(): { logger: IScopedLogger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = []
  const record =
    (level: string) =>
    (message: string, extras?: LogExtras): void => {
      logs.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, logs }
}

/** The hub's live store on 2026-10-06, reduced to what matters. */
function hubStore(coralModelId: string): AgentSettingsMapBlob {
  return {
    hub: {
      maxCameras: null,
      inferenceDevices: {
        cpu: {
          enabled: false,
          weight: 1,
          steps: {
            'animal-classifier': {
              settings: { enabledClasses: ['bird', 'cat'] },
            },
          },
        },
        [CORAL]: {
          enabled: false,
          weight: 1,
          maxSessions: 1,
          steps: {
            'object-detection': {
              modelId: coralModelId,
              settings: { minConfidence: 0.5 },
            },
          },
        },
        'openvino:gpu': { enabled: true, weight: 50 },
      },
    },
  }
}

function customDescriptor(stepId: string, id: string) {
  return {
    stepId,
    entry: {
      id,
      name: 'Operator import',
      description: '',
      formats: {},
      inputSize: { width: 320, height: 320 },
      labels: [],
    },
  }
}

const noCustom = (): boolean => false

describe('removed-model pin sweep (pure)', () => {
  it('drops a removed per-(node, device) pin and keeps the step settings', () => {
    const { next, cleared } = sweepAgentSettingsPins(hubStore(REMOVED), noCustom)
    expect(next['hub']?.inferenceDevices?.[CORAL]?.steps?.['object-detection']).toEqual({
      settings: { minConfidence: 0.5 },
    })
    expect(cleared).toEqual([
      {
        scope: 'node-device',
        nodeId: 'hub',
        deviceKey: CORAL,
        stepId: 'object-detection',
        modelId: REMOVED,
      },
    ])
  })

  it('a step left with nothing is dropped, and so is an empty steps map', () => {
    const blob: AgentSettingsMapBlob = {
      hub: {
        maxCameras: null,
        inferenceDevices: {
          [CORAL]: {
            enabled: true,
            steps: { 'object-detection': { modelId: REMOVED } },
          },
        },
      },
    }
    const { next } = sweepAgentSettingsPins(blob, noCustom)
    expect(next['hub']?.inferenceDevices?.[CORAL]).toEqual({ enabled: true })
  })

  it('leaves a catalog survivor, an unknown id and a removed id of ANOTHER step alone', () => {
    const blob: AgentSettingsMapBlob = {
      hub: {
        maxCameras: null,
        inferenceDevices: {
          a: {
            enabled: true,
            steps: { 'object-detection': { modelId: SURVIVOR } },
          },
          b: {
            enabled: true,
            steps: { 'object-detection': { modelId: 'my-own-detector' } },
          },
          // `yolov8n-plate` is removed from plate-detection, not object-detection.
          c: {
            enabled: true,
            steps: { 'object-detection': { modelId: 'yolov8n-plate' } },
          },
        },
      },
    }
    const { next, cleared } = sweepAgentSettingsPins(blob, noCustom)
    expect(cleared).toEqual([])
    expect(next).toBe(blob)
  })

  it('a registered custom model with the removed id is not reset', () => {
    const blob = hubStore(REMOVED)
    const { next, cleared } = sweepAgentSettingsPins(
      blob,
      (stepId, id) => stepId === 'object-detection' && id === REMOVED,
    )
    expect(cleared).toEqual([])
    expect(next).toBe(blob)
  })
})

describe('PipelineOrchestrator — removed-model pin reset (D725)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot(opts: {
    readonly agentSettings?: AgentSettingsMapBlob
    readonly global?: Record<string, unknown>
    readonly listCustomModels?: () => unknown
    readonly devices?: readonly string[]
  }) {
    const { logger, logs } = makeCapturingLogger()
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      logger,
      initialGlobalSettings: {
        ...(opts.agentSettings ? { agentSettings: opts.agentSettings } : {}),
        ...opts.global,
      },
      providers: {
        ...(opts.listCustomModels
          ? { 'custom-model-registry': { listModels: opts.listCustomModels } }
          : {}),
        'platform-probe': {
          getCapabilities: () => ({
            nodeId: 'hub',
            reachable: true,
            devices: (opts.devices ?? []).map((key) => ({
              key,
              backend: key.split(':')[0],
              device: key.split(':')[1] ?? key,
              format: key.startsWith('edgetpu') ? 'tflite' : 'openvino',
              runtime: 'python' as const,
              score: 10,
              available: true,
            })),
          }),
        },
      },
    })
    // The three-way read the cluster rows need (the default fake lacks it).
    const settings = ctx.settings
    if (settings === undefined) throw new Error('fake context has no settings')
    settings.readAddonStoreResult = async () => ({
      kind: 'value',
      value: await settings.readAddonStore(),
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    return { addon, logs }
  }

  /** Wait for the boot sweep, so a write-path spec proves the WRITE reset the pin. */
  async function bootSweepDone(logs: readonly CapturedLog[]): Promise<void> {
    await vi.waitFor(() => {
      expect(
        logs.some(
          (l) =>
            l.message === 'removed-model pin reset: swept' &&
            l.extras?.meta?.['trigger'] === 'boot',
        ),
      ).toBe(true)
    })
  }

  function storedCoralStep(a: PipelineOrchestratorAddon) {
    return a
      .getAgentSettings({ agentNodeId: 'hub' })
      .then((s) => s?.inferenceDevices?.[CORAL]?.steps?.['object-detection'])
  }

  it('the boot sweep clears the Coral pin, persists it, and logs the old id', async () => {
    const { addon: a, logs } = await boot({ agentSettings: hubStore(REMOVED) })
    await vi.waitFor(async () => {
      expect(await storedCoralStep(a)).toEqual({
        settings: { minConfidence: 0.5 },
      })
    })
    // The store is written before the sweep logs its pins — wait for the sweep.
    await bootSweepDone(logs)
    const line = logs.find((l) => l.message.startsWith('model pin reset'))
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ nodeId: 'hub' })
    expect(line?.extras?.meta).toMatchObject({
      scope: 'node-device',
      trigger: 'boot',
      step: 'object-detection',
      removedModelId: REMOVED,
      nodeId: 'hub',
      deviceKey: CORAL,
    })
    // The unrelated node-wide settings copy is untouched.
    const settings = await a.getAgentSettings({ agentNodeId: 'hub' })
    expect(settings?.inferenceDevices?.['cpu']?.steps?.['animal-classifier']).toEqual({
      settings: { enabledClasses: ['bird', 'cat'] },
    })
  })

  it('provisioning then carries no model for the step — the node runs its default', async () => {
    const { addon: a, logs } = await boot({ agentSettings: hubStore(REMOVED) })
    await bootSweepDone(logs)
    const store = (
      a as unknown as {
        settingsStore: {
          buildNodeInferenceDeviceSteps: (
            n: string,
            k: string,
          ) => Promise<Record<string, { modelId?: string }>>
        }
      }
    ).settingsStore
    const steps = await store.buildNodeInferenceDeviceSteps('hub', CORAL)
    expect(steps['object-detection']?.modelId).toBeUndefined()
  })

  it('a registered custom model with the same id is left pinned', async () => {
    const { addon: a, logs } = await boot({
      agentSettings: hubStore(REMOVED),
      listCustomModels: () => [customDescriptor('object-detection', REMOVED)],
    })
    expect(await a.resetRemovedModelPins('boot')).toEqual([])
    expect((await storedCoralStep(a))?.modelId).toBe(REMOVED)
    expect(logs.some((l) => l.message.startsWith('model pin reset'))).toBe(false)
  })

  it('an unreadable custom-model registry resets nothing', async () => {
    const { addon: a, logs } = await boot({
      agentSettings: hubStore(REMOVED),
      listCustomModels: () => {
        throw new Error('model-studio unreachable')
      },
    })
    expect(await a.resetRemovedModelPins('boot')).toEqual([])
    expect((await storedCoralStep(a))?.modelId).toBe(REMOVED)
    expect(
      logs.some(
        (l) => l.message.includes('custom model registry unreadable') && l.level === 'warn',
      ),
    ).toBe(true)
  })

  it('setAgentInferenceDevices with a stale removed pin persists without it', async () => {
    const { addon: a, logs } = await boot({ devices: [CORAL] })
    await bootSweepDone(logs)
    await a.setAgentInferenceDevices({
      agentNodeId: 'hub',
      inferenceDevices: {
        [CORAL]: {
          enabled: true,
          weight: 1,
          steps: { 'object-detection': { modelId: REMOVED } },
        },
      },
    })
    const settings = await a.getAgentSettings({ agentNodeId: 'hub' })
    expect(settings?.inferenceDevices?.[CORAL]).toEqual({
      enabled: true,
      weight: 1,
    })
  })

  it.each([
    'mobileclip-s0',
    'mobileclip-s1',
    'mobileclip-s2',
  ])('a cluster row naming the retired %s is cleared — the step reads absent (default) (D871)', async (retired) => {
    const { addon: a, logs } = await boot({
      global: { 'clusterModel:clip-embedding': retired },
    })
    await bootSweepDone(logs)
    expect(await a.getClusterModelChoice({ stepId: 'clip-embedding' })).toEqual({
      kind: 'absent',
      defaultModelId: 'siglip2-b16-224',
    })
  })
})
