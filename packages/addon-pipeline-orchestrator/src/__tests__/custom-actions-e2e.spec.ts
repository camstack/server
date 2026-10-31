/**
 * End-to-end test for Task 9.1 — the AddonInitResult envelope flowing from
 * a real BaseAddon subclass all the way through the CustomActionRegistry
 * dispatch path.
 *
 * The `api.addons.custom` dispatch is already covered by
 * `server/backend/src/api/core/__tests__/addons-custom-dispatch.spec.ts` using
 * a synthetic catalog. This spec closes the remaining gap: it proves a production
 * subclass (PipelineOrchestratorAddon) actually produces a valid envelope
 * that the registry can register and resolve end-to-end.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { CustomActionRegistry } from '@camstack/system/addon-utils'
import PipelineOrchestratorAddon, { pipelineOrchestratorActions } from '../index.js'
import { makeFakeBroker, makeFakeContext, enabledNodesFromBroker } from './e2e-helpers.js'

describe('PipelineOrchestratorAddon — custom actions envelope', () => {
  let addon: PipelineOrchestratorAddon

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('returns an AddonInitResult envelope carrying the dumpState catalog', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    const envelope = await addon.initialize(ctx)

    expect(envelope).toBeDefined()
    // Providers colocated with the orchestrator (same hub-side store):
    //   - pipeline-orchestrator (the addon itself)
    //   - camera-pipeline-config (D12 per-device settings contribution wrapper)
    //   - zones (geometry CRUD)
    //   - zone-rules (per-stage gating CRUD)
    //   - addon-widgets-source (dashboard widgets)
    //   - viewer-ui (serves the staged viewer web SPA)
    //   - display-palette (cluster colour table, D940)
    //   - node-removal-hook (a forgotten node's pipeline data, #265)
    expect(envelope?.providers).toHaveLength(8)
    expect(envelope?.providers?.map((p) => p.capability.name)).toEqual(
      expect.arrayContaining([
        'pipeline-orchestrator',
        'camera-pipeline-config',
        'zones',
        'zone-rules',
        'addon-widgets-source',
        'viewer-ui',
        'display-palette',
        'node-removal-hook',
      ]),
    )
    expect(envelope?.customActions).toBe(pipelineOrchestratorActions)
    expect(typeof envelope?.actionHandlers?.['dumpState']).toBe('function')
  })

  it('direct handler invocation returns a snapshot matching the schema', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-gpu')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    const envelope = await addon.initialize(ctx)
    const dumpState = envelope?.actionHandlers?.['dumpState']
    if (!dumpState) throw new Error('expected dumpState handler on envelope')

    const raw = await dumpState(undefined)
    const result = pipelineOrchestratorActions.dumpState.output.parse(raw)

    expect(result.localNodeId).toBe('hub')
    expect(result.knownRunnerNodes).toContain('hub')
    expect(result.assignedDeviceCount).toBe(0)
    expect(result.cameraConfigCount).toBe(0)
    expect(result.activeDetectionCount).toBe(0)
    expect(result.enabledNodes).toEqual(expect.arrayContaining(['hub', 'agent-gpu']))
  })

  it('registers with CustomActionRegistry and dispatches dumpState via the registry', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-gpu')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    const envelope = await addon.initialize(ctx)
    if (!envelope?.customActions || !envelope.actionHandlers) {
      throw new Error('orchestrator envelope missing customActions or actionHandlers')
    }

    const handlers = envelope.actionHandlers
    const registry = new CustomActionRegistry()
    registry.registerAddon('pipeline-orchestrator', envelope.customActions, (action, input) => {
      const fn = handlers[action]
      if (!fn) throw new Error(`no handler registered for '${action}'`)
      return fn(input)
    })

    const entry = registry.resolve('pipeline-orchestrator', 'dumpState')
    if (!entry) throw new Error('expected dumpState entry in registry')

    const parsedInput = entry.spec.input.parse(undefined)
    const raw = await entry.handler(parsedInput)
    const result = pipelineOrchestratorActions.dumpState.output.parse(raw)

    expect(result.localNodeId).toBe('hub')
    expect(result.enabledNodes).toEqual(expect.arrayContaining(['hub', 'agent-gpu']))
    expect(registry.listActions('pipeline-orchestrator')).toEqual([
      'dumpState',
      'rebalanceNow',
      'nodeStressStats',
    ])
    expect(registry.resolve('pipeline-orchestrator', 'nonexistent')).toBeNull()
  })
})
