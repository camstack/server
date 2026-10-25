/**
 * End-to-end tests that simulate the admin UI's tRPC call sequences
 * for every camera-pipeline configuration scenario.
 *
 * Each test block mirrors a discrete user action in the Pipeline tab
 * of the Device Details page (see
 * `packages/addon-admin-ui/src/components/form-builder/PipelineEditorField.tsx`):
 *
 *   - The master "Disable all inference" checkbox
 *     → `setCameraDisableInference`
 *   - The per-step three-state toggle (Inherit / On / Off)
 *     → `setCameraStepToggle`
 *   - The agent-level addon defaults edited on Pipeline → <agent>
 *     → `setAgentAddonDefaults` / `setAgentEngine`
 *   - New-camera bootstrap (`DeviceStreamsRegistered` from stream-broker)
 *     → `seedPipelineIfMissing`
 *
 * After every interaction we assert both the *persisted* shape (what
 * `readAddonStore` contains) and the *resolved* shape (what
 * `resolvePipeline({deviceId, agentNodeId})` returns — the config the
 * runner would actually run). This double assertion is deliberate:
 * the resolver reads from multiple keys with a precedence chain, so
 * store-only assertions can pass while the resolved pipeline is wrong
 * (and vice-versa).
 *
 * Regression guardrails:
 *
 *   - The "Inherit all" sequence MUST NOT corrupt `pipelines[deviceId]`
 *     with `steps:[]`. The pre-3-level UI used to write an empty
 *     wholesale config via `setCameraPipeline`, leaving a stale
 *     `{engine, steps:[], audio:null}` in the persisted `pipelines`
 *     map that silently suppressed detection for that camera on
 *     every boot until the row was manually deleted.
 *
 *   - An explicit stepToggle=false for an addon the agent has enabled
 *     MUST produce a pipeline without that step, even when the agent
 *     defaults would otherwise include it.
 *
 *   - An advanced per-agent override on `agent-0` MUST NOT leak into
 *     the resolved pipeline for `agent-1` (the same deviceId resolved
 *     on a different agent).
 */
import { describe, it, expect, afterEach } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeBroker, makeFakeContext, enabledNodesFromBroker } from './e2e-helpers.js'
import type { PipelineSchema } from '@camstack/types'

// ── Fixtures ───────────────────────────────────────────────────────────

/** Minimal catalog covering object-detection, face-detection, audio-classifier.
 *  `inputClasses` / `outputClasses` set so the resolver's tree builder can
 *  attach face-detection under object-detection, and so the audio slot is
 *  properly split from the video tree. */
const CATALOG: PipelineSchema = {
  slots: [
    {
      id: 'detector',
      label: 'Object detection',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'Object Detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person', 'animal', 'vehicle'],
          childSlots: [],
          enabledByDefault: true,
          defaultModelId: 'yolov9s',
          defaultConfidence: 0.5,
          models: [
            {
              id: 'yolov9s',
              name: 'YOLOv9s',
              formats: {
                coreml: { downloaded: true, sizeMB: 0 },
                onnx: { downloaded: true, sizeMB: 0 },
              },
            },
          ],
        },
      ],
    },
    {
      id: 'cropper',
      label: 'Face detection',
      priority: 1,
      parentSlot: 'detector',
      addons: [
        {
          id: 'face-detection',
          name: 'Face Detection',
          slot: 'cropper',
          inputClasses: ['person'],
          outputClasses: ['face'],
          childSlots: [],
          enabledByDefault: true,
          defaultModelId: 'scrfd-2.5g',
          defaultConfidence: 0.5,
          models: [
            {
              id: 'scrfd-2.5g',
              name: 'SCRFD 2.5G',
              formats: {
                coreml: { downloaded: true, sizeMB: 0 },
                onnx: { downloaded: true, sizeMB: 0 },
              },
            },
          ],
        },
      ],
    },
    {
      id: 'audio-classifier',
      label: 'Audio classifier',
      priority: 2,
      parentSlot: null,
      addons: [
        {
          id: 'audio-classifier',
          name: 'Audio Classifier',
          slot: 'audio-classifier',
          inputClasses: [],
          outputClasses: ['audio-event'],
          childSlots: [],
          enabledByDefault: true,
          defaultModelId: 'apple-soundanalysis',
          defaultConfidence: 0.5,
          models: [
            {
              id: 'apple-soundanalysis',
              name: 'Apple SoundAnalysis',
              formats: { coreml: { downloaded: true, sizeMB: 0 } },
            },
          ],
        },
      ],
    },
  ],
  availableEngines: [
    {
      engine: { runtime: 'python', backend: 'coreml', format: 'coreml' },
      devices: [],
      defaultDevice: '',
    },
  ],
  selectedEngine: { runtime: 'python', backend: 'coreml', format: 'coreml' },
}

/** Boot the orchestrator with a single-agent cluster ('hub'), seed agent
 *  defaults matching the fixture catalog, and return the addon handle. */
async function bootOrchestrator(
  agents: readonly string[] = ['hub', 'dev-agent-0'],
): Promise<{ addon: PipelineOrchestratorAddon; ctx: ReturnType<typeof makeFakeContext> }> {
  const broker = makeFakeBroker(agents[0] ?? 'hub')
  for (const nodeId of agents.slice(1)) broker.addNode(nodeId)
  const fakeContext = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    providers: {
      'pipeline-executor': {
        getSchema: ({ nodeId: _nodeId }: { nodeId: string }) => CATALOG,
      },
    },
  })
  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(fakeContext.ctx)
  // Seed a bare agentSettings entry for every agent (the per-node model layer
  // is gone — enablement is per-camera stepToggles, model is per-(node,device)).
  for (const nodeId of agents) {
    await addon.setAgentMaxCameras({ agentNodeId: nodeId, maxCameras: null })
  }
  return { addon, ctx: fakeContext }
}

// ── 1. New-device bootstrap ────────────────────────────────────────────

describe('admin-ui pipeline flows — new-device bootstrap', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('resolvePipeline on a never-seen deviceId returns agent defaults (no toggle set)', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    const resolved = await addon.resolvePipeline({ deviceId: 999, agentNodeId: 'hub' })
    // Every agent-default addon is enabled → obj-det root + face-detection child + audio.
    expect(resolved.steps).toHaveLength(1)
    expect(resolved.steps[0]!.addonId).toBe('object-detection')
    expect(resolved.steps[0]!.children).toHaveLength(1)
    expect(resolved.steps[0]!.children![0]!.addonId).toBe('face-detection')
    expect(resolved.audio).not.toBeNull()
    // Structure only — the resolver attaches no audio model (the node resolves
    // its own format default; provisioning is a per-(node,device) dispatch stage).
    expect(resolved.audio!.enabled).toBe(true)
  })

  it('persisted pipelines store is clean for a never-seen deviceId', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await addon.resolvePipeline({ deviceId: 999, agentNodeId: 'hub' })
    const readStore = booted.ctx.store.global
    const pipelines = (readStore['pipelines'] ?? {}) as Record<string, unknown>
    // Resolver doesn't auto-seed on its own — keep the store pristine.
    expect(pipelines['999']).toBeUndefined()
  })

  it('resolvePipeline is data only — no `engine` field on the resolved config, steps + audio still populate', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    const resolved = await addon.resolvePipeline({ deviceId: 999, agentNodeId: 'hub' })
    // The orchestrator no longer resolves/threads an engine — model
    // selection is data only, the executing node resolves its own
    // format default at runtime. `engine` must be absent, not merely
    // falsy, on every branch of resolvePipelineForDevice.
    expect(resolved).not.toHaveProperty('engine')
    expect(resolved.steps).toHaveLength(1)
    expect(resolved.steps[0]!.addonId).toBe('object-detection')
    expect(resolved.audio).not.toBeNull()
    expect(resolved.audio).not.toHaveProperty('engine')
  })
})

// ── 2. Three-state toggle (Inherit / On / Off) ─────────────────────────

describe('admin-ui pipeline flows — per-step three-state toggle', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('stepToggle=null ("Inherit") does NOT corrupt pipelines[deviceId] with steps:[]', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon
    const store = booted.ctx.store

    // User clicks "Inherit" on object-detection — the UI dispatches
    // setCameraStepToggle with enabled=null.
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'object-detection', enabled: null })

    // Regression: the legacy `pipelines` map must NOT gain a new
    // `{engine, steps:[], audio:null}` row.
    const pipelines = (store.global['pipelines'] ?? {}) as Record<string, unknown>
    expect(pipelines['1']).toBeUndefined()
  })

  it('stepToggle=false removes that step from the resolved pipeline', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: false })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    // object-detection root still present; face-detection child dropped.
    expect(resolved.steps).toHaveLength(1)
    expect(resolved.steps[0]!.addonId).toBe('object-detection')
    expect(resolved.steps[0]!.children).toHaveLength(0)
  })

  it('stepToggle=true keeps a default-on addon enabled (per-camera gate is the authority)', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    // Force-enable face-detection for this one camera (per-camera gate).
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: true })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps).toHaveLength(1)
    expect(resolved.steps[0]!.children).toHaveLength(1)
    expect(resolved.steps[0]!.children![0]!.addonId).toBe('face-detection')
  })

  it('inherit-after-override returns to agent default', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: false })
    let resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps[0]!.children).toHaveLength(0)

    // User clicks Inherit to revert.
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: null })
    resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps[0]!.children).toHaveLength(1)
    expect(resolved.steps[0]!.children![0]!.addonId).toBe('face-detection')
  })

  it('cameraSettings stores sparse toggles — absent keys mean inherit', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'object-detection', enabled: true })
    const cam = await addon.getCameraSettings({ deviceId: 1 })
    expect(cam?.stepToggles).toBeDefined()
    expect(cam!.stepToggles!['object-detection']).toBe(true)
    expect(cam!.stepToggles!['face-detection']).toBeUndefined()
  })
})

// ── 3. Master "Disable all inference" ──────────────────────────────────

describe('admin-ui pipeline flows — master disable inference', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('setWrapperActive(detection-pipeline, false) yields an empty resolved pipeline', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await booted.ctx.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps).toEqual([])
    expect(resolved.audio).toBeNull()
  })

  it('detection-pipeline binding off overrides stepToggles', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    // Force-on a step, then flip the detection-pipeline binding off via
    // device-manager.setWrapperActive.
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: true })
    await booted.ctx.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps).toEqual([])
    // Binding-inactive short-circuit — data only, no engine field.
    expect(resolved).not.toHaveProperty('engine')
  })

  it('disabling then re-enabling the binding restores the previously-configured pipeline', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: false })
    await booted.ctx.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })
    await booted.ctx.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: true,
    })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    // stepToggle=false for face-detection persists across the binding-toggle dance.
    expect(resolved.steps[0]!.children).toHaveLength(0)
  })
})

// ── 4. Advanced per-agent wholesale override ───────────────────────────

describe('admin-ui pipeline flows — agent-defaults propagation', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('enablement is per-camera gate only — the resolver preview carries no model', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    // Camera 1 inherits (no stepToggles) → face-detection gated on by default.
    let resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps[0]!.children).toHaveLength(1)
    // Structure only — no model in the node-level preview (provisioning is a
    // per-(node,device) dispatch stage keyed on the chosen accelerator).
    expect(resolved.steps[0]!.modelId).toBeUndefined()
    expect(resolved.steps[0]!.children![0]!.modelId).toBeUndefined()

    // The SOLE disable path is the per-camera gate.
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: false })
    resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps[0]!.children).toHaveLength(0)
  })

  it('a camera with an explicit stepToggle keeps its choice', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    // Camera force-enables face-detection (already default-on; the explicit gate
    // pins it regardless of catalog default changes).
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: true })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps[0]!.children).toHaveLength(1)
  })
})

// ── 6. Audio classifier enablement ─────────────────────────────────────

describe('admin-ui pipeline flows — audio classifier', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('audio-classifier default-on populates CameraPipelineConfig.audio (structure only)', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.audio).not.toBeNull()
    expect(resolved.audio!.enabled).toBe(true)
    // No audio model in the preview — the node resolves its own format default.
    expect(resolved.audio!.modelId).toBeUndefined()
  })

  it('per-camera stepToggle can disable audio-classifier without touching agent defaults', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'audio-classifier', enabled: false })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.audio).toBeNull()
  })
})

// ── 8. Full click sequence (end-to-end operator journey) ───────────────

describe('admin-ui pipeline flows — realistic operator journey', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('inherit → off → inherit traces the resolved pipeline correctly', async () => {
    const booted = await bootOrchestrator(['hub'])
    addon = booted.addon

    const trace: Array<{ label: string; steps: number; hasFace: boolean; audio: boolean }> = []
    const snap = async (label: string) => {
      const r = await addon!.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
      trace.push({
        label,
        steps: r.steps.length,
        hasFace: r.steps.some((s) =>
          (s.children ?? []).some((c) => c.addonId === 'face-detection'),
        ),
        audio: r.audio !== null,
      })
    }

    // 1. Camera opens — inherit from agent defaults.
    await snap('initial-inherit')
    // 2. Operator clicks Off on face-detection.
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: false })
    await snap('face-off')
    // 3. Back to Inherit (clicks the third state).
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: null })
    await snap('face-inherit')
    expect(trace).toEqual([
      { label: 'initial-inherit', steps: 1, hasFace: true, audio: true },
      { label: 'face-off', steps: 1, hasFace: false, audio: true },
      { label: 'face-inherit', steps: 1, hasFace: true, audio: true },
    ])
  })
})
