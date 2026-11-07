/**
 * Settings-API migration (P3c) — the orchestrator must route its
 * addon-store access through the high-level BaseAddon settings API
 * instead of raw `readAddonStore`/`writeAddonStore`:
 *
 *  - a cluster write delegates to the base implementation
 *    (same persisted keys/shape, plus the sanctioned `AddonUpdated`
 *    lifecycle emission).
 *
 * Equivalence tests (seeded store → same value, write → same key +
 * shape, corrupt → same fallback) encode the CURRENT behavior and must
 * pass before AND after the accessor swap.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventCategory } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeContext, makeFakeBroker, enabledNodesFromBroker } from './e2e-helpers.js'

describe('PipelineOrchestrator — settings accessor migration', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('a cluster write persists the patch under the same bare keys (equivalence)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateScopedSettings('cluster', 'pipeline-orchestrator', {
      audioNode: 'hub',
      fpsMinThreshold: 7,
    })

    expect(store.global['audioNode']).toBe('hub')
    expect(store.global['fpsMinThreshold']).toBe(7)
    // No node-scoped variant of a bare setting — nothing here is perNode. The node rows the
    // orchestrator owns (`agentSettings@<node>`, `nodeBindings@<node>`) are not settings.
    const nodeRowFields = ['agentSettings@', 'nodeBindings@']
    const variants = Object.keys(store.global).filter(
      (k) => k.includes('@') && !nodeRowFields.some((f) => k.startsWith(f)),
    )
    expect(variants).toEqual([])
  })

  it('a cluster write emits the AddonUpdated lifecycle event (base settings API)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateScopedSettings('cluster', 'pipeline-orchestrator', { fpsMinThreshold: 7 })

    const updated = captured.filter((e) => e.category === EventCategory.AddonUpdated)
    expect(updated.length).toBeGreaterThan(0)
    expect(updated[0]!.data).toMatchObject({ level: 'global' })
  })

  it('setShareSource lands on the bare `shareSource` key an older build wrote, and is read back live', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        shareSource: 'benchmark',
        audioNode: 'marker-kept',
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setShareSource({ source: 'hardware' })

    expect(store.global['shareSource']).toBe('hardware')
    // The write merges: a neighbouring stored key survives.
    expect(store.global['audioNode']).toBe('marker-kept')
    expect((await addon.getEffectiveShares()).source).toBe('hardware')
  })
})
