/**
 * Settings-API migration (P3c) — the orchestrator must route its
 * addon-store access through the high-level BaseAddon settings API
 * instead of raw `readAddonStore`/`writeAddonStore`:
 *
 *  - `updateGlobalSettings` delegates to the base implementation
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

  it('updateGlobalSettings persists the patch under the same bare keys (equivalence)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ enabledNodes: ['hub'], loadShedEnabled: false })

    expect(store.global['enabledNodes']).toEqual(['hub'])
    expect(store.global['loadShedEnabled']).toBe(false)
    // No node-scoped key variants — nothing here is perNode.
    expect(Object.keys(store.global).some((k) => k.includes('@'))).toBe(false)
  })

  it('updateGlobalSettings emits the AddonUpdated lifecycle event (base settings API)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ loadShedEnabled: false })

    const updated = captured.filter((e) => e.category === EventCategory.AddonUpdated)
    expect(updated.length).toBeGreaterThan(0)
    expect(updated[0]!.data).toMatchObject({ level: 'global' })
  })
})
