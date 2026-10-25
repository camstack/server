/**
 * Settings-API migration (P3c) — the orchestrator must route its
 * addon-store access through the high-level BaseAddon settings API
 * instead of raw `readAddonStore`/`writeAddonStore`:
 *
 *  - `updateGlobalSettings` delegates to the base implementation
 *    (same persisted keys/shape, plus the sanctioned `AddonUpdated`
 *    lifecycle emission).
 *  - the `bindingsMigration_v1_done` one-shot flag moves onto the
 *    Zod-validated `this.state()` durable handle (same key, same
 *    fallback semantics — corrupt/absent ⇒ migration runs).
 *
 * Equivalence tests (seeded store → same value, write → same key +
 * shape, corrupt → same fallback) encode the CURRENT behavior and must
 * pass before AND after the accessor swap.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventCategory } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeContext, makeFakeBroker, enabledNodesFromBroker } from './e2e-helpers.js'

const MIGRATION_KEY = 'bindingsMigration_v1_done'

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

interface WarnCapture {
  readonly logger: IScopedLogger
  readonly warns: string[]
}

function makeWarnCapturingLogger(): WarnCapture {
  const warns: string[] = []
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: (message: string) => {
      warns.push(message)
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns }
}

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
        [MIGRATION_KEY]: true,
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
        [MIGRATION_KEY]: true,
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ loadShedEnabled: false })

    const updated = captured.filter((e) => e.category === EventCategory.AddonUpdated)
    expect(updated.length).toBeGreaterThan(0)
    expect(updated[0]!.data).toMatchObject({ level: 'global' })
  })

  it('bindings migration: seeded `true` flag short-circuits (equivalence)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        [MIGRATION_KEY]: true,
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Give the fire-and-forget migration task time to run if it were
    // (wrongly) going to — the flag must simply stay true.
    await new Promise((r) => setTimeout(r, 100))
    expect(store.global[MIGRATION_KEY]).toBe(true)
  })

  it('bindings migration: absent flag runs the migration and persists `true` under the SAME key (equivalence)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await waitFor(() => store.global[MIGRATION_KEY] === true)
    expect(store.global[MIGRATION_KEY]).toBe(true)
  })

  it('bindings migration: corrupt flag falls back (migration runs) and the durable handle logs the validation warning', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        [MIGRATION_KEY]: 'yes', // legacy garbage — NOT boolean true
      },
    })
    const { logger, warns } = makeWarnCapturingLogger()
    ;(ctx as { logger: IScopedLogger }).logger = logger
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Same fallback as today: a non-`true` value means "not done" — the
    // migration runs and stamps the flag.
    await waitFor(() => store.global[MIGRATION_KEY] === true)

    // The sanctioned `this.state()` handle logs the corrupt-blob warning.
    expect(warns.some((w) => w.includes('durable-state'))).toBe(true)
  })
})
