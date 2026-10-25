/**
 * D651 fix round 3: the orchestrator OWNS `clusterModel:*`, so it answers
 * which model the operator chose, three ways, never folded:
 *  - a key written with a model id → `stored` (or `invalid-stored` if the
 *    value is not a string at all);
 *  - a store that answered without the key, or with the key cleared (`null`,
 *    `''`) → `absent`, the default BY absence;
 *  - a store that did not answer, or an owner whose boot has not settled →
 *    `unreadable`. Never the default.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AddonContext,
  type AddonStoreRead,
  clusterModelSettingKey,
  invalidClusterStepModelEntries,
  readClusterStepModels,
  type StoredKeyRead,
} from '@camstack/types'
import { decideClusterModelChoice } from '../cluster-model-choice.js'
import PipelineOrchestratorAddon from '../index.js'
import { enabledNodesFromBroker, makeFakeBroker, makeFakeContext } from './e2e-helpers.js'

/** The context each `boot` built, keyed by the addon it was built for. */
const contexts = new WeakMap<PipelineOrchestratorAddon, AddonContext>()
function lastCtx(a: PipelineOrchestratorAddon): AddonContext {
  const ctx = contexts.get(a)
  if (ctx === undefined) throw new Error('no context recorded for this addon')
  return ctx
}

const FACE = 'face-embedding'

describe('decideClusterModelChoice', () => {
  it('a written catalog id is the stored choice', () => {
    expect(decideClusterModelChoice(FACE, { kind: 'present', value: 'auraface-r100' })).toEqual({
      kind: 'stored',
      modelId: 'auraface-r100',
    })
  })

  it('a key nobody wrote is the default BY ABSENCE', () => {
    expect(decideClusterModelChoice(FACE, { kind: 'absent' })).toEqual({
      kind: 'absent',
      defaultModelId: 'auraface-r100',
    })
  })

  it('a key cleared by the form (null or "") is ABSENT — the same statement as never written', () => {
    for (const value of [null, '']) {
      expect(decideClusterModelChoice(FACE, { kind: 'present', value })).toEqual({
        kind: 'absent',
        defaultModelId: 'auraface-r100',
      })
    }
  })

  it('a written value that is not a string is unreadable, never the default', () => {
    for (const value of [42, { id: 'x' }, true]) {
      expect(decideClusterModelChoice(FACE, { kind: 'present', value })).toEqual({
        kind: 'unreadable',
        reason: 'invalid-stored',
      })
    }
  })

  /**
   * D651 fix round 4: the owner and the runtime read ONE stored key with ONE
   * interpretation (`interpretStoredClusterModel`). For every value the store
   * can hold, the model the owner names is the model the runner runs — or the
   * owner refuses and the runner's default is logged, never the reverse.
   */
  it.each([
    ['never written', undefined, 'absent'],
    ['null (form cleared)', null, 'absent'],
    ['empty string', '', 'absent'],
    ['a catalog id', 'auraface-r100', 'stored'],
    // Not in the dropdown, but the runner pins it verbatim (a custom encoder),
    // so the owner names it too: a pass on it fails by name (`no-capable-node`)
    // on a node that cannot serve it, never silently on another model.
    ['an id outside the dropdown', 'my-custom-encoder', 'stored'],
    ['a number', 42, 'invalid'],
    ['an object', { id: 'x' }, 'invalid'],
  ] as const)('agrees with the runtime reader: %s', (_label, raw, expected) => {
    const key = clusterModelSettingKey(FACE)
    const runtime = readClusterStepModels(raw === undefined ? {} : { [key]: raw })[FACE]
    const owner = decideClusterModelChoice(
      FACE,
      raw === undefined ? { kind: 'absent' } : { kind: 'present', value: raw },
    )
    if (expected === 'absent') {
      expect(owner).toEqual({ kind: 'absent', defaultModelId: 'auraface-r100' })
      expect(runtime).toBe('auraface-r100')
    } else if (expected === 'stored') {
      expect(owner).toEqual({ kind: 'stored', modelId: raw })
      expect(runtime).toBe(raw)
    } else {
      expect(owner).toEqual({ kind: 'unreadable', reason: 'invalid-stored' })
      // The live row is total: the runner runs the default and LOGS it
      // (`ClusterModelSource`); no pass rewrites an index on this value.
      expect(runtime).toBe('auraface-r100')
      expect(invalidClusterStepModelEntries({ [key]: raw })).toEqual([{ stepId: FACE, value: raw }])
    }
  })

  it('a store that did not answer is unreadable, with its error', () => {
    const read: StoredKeyRead = { kind: 'unreadable', reason: 'store-read-failed', error: 'down' }
    expect(decideClusterModelChoice(FACE, read)).toEqual({
      kind: 'unreadable',
      reason: 'store-read-failed',
      error: 'down',
    })
  })

  it('a settings view that cannot read three-way is unreadable', () => {
    expect(
      decideClusterModelChoice(FACE, { kind: 'unreadable', reason: 'three-way-read-unavailable' }),
    ).toEqual({ kind: 'unreadable', reason: 'three-way-read-unavailable' })
  })

  it('an owner whose boot has not settled answers owner-not-ready', () => {
    expect(decideClusterModelChoice(FACE, 'owner-not-ready')).toEqual({
      kind: 'unreadable',
      reason: 'owner-not-ready',
    })
  })

  it('a step that is not cluster-scoped is unreadable', () => {
    expect(decideClusterModelChoice('object-detection', { kind: 'absent' })).toEqual({
      kind: 'unreadable',
      reason: 'not-cluster-scoped',
    })
  })

  it('reads the key the settings form writes', () => {
    expect(clusterModelSettingKey(FACE)).toBe('clusterModel:face-embedding')
  })
})

/**
 * The cap method at the addon: it answers only from a THREE-WAY read of its
 * own store, and not once shutdown has begun. There is no "before boot" case
 * to exercise: the provider is registered from what `onInitialize` returns, so
 * nothing can call the method earlier (fix round 4 removed that test).
 */
describe('PipelineOrchestrator.getClusterModelChoice', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot(
    stored: Record<string, unknown>,
    readResult?: () => Promise<AddonStoreRead>,
  ): Promise<PipelineOrchestratorAddon> {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker), ...stored },
    })
    const settings = ctx.settings
    if (settings === undefined) throw new Error('fake context has no settings')
    if (readResult !== undefined) settings.readAddonStoreResult = readResult
    else {
      settings.readAddonStoreResult = async () => ({
        kind: 'value',
        value: await settings.readAddonStore(),
      })
    }
    const a = new PipelineOrchestratorAddon()
    contexts.set(a, ctx)
    addon = a
    return a
  }

  it('after boot: a stored choice is stored, an unwritten key is absent', async () => {
    const a = await boot({ [clusterModelSettingKey(FACE)]: 'auraface-r100' })
    await a.initialize(lastCtx(a))
    expect(await a.getClusterModelChoice({ stepId: FACE })).toEqual({
      kind: 'stored',
      modelId: 'auraface-r100',
    })
    expect(await a.getClusterModelChoice({ stepId: 'clip-embedding' })).toEqual({
      kind: 'absent',
      defaultModelId: 'siglip2-b16-224',
    })
  })

  it('a store that did not answer is unreadable — never absent, never the default', async () => {
    const a = await boot({}, async () => ({ kind: 'failed', error: 'store down' }))
    await a.initialize(lastCtx(a))
    expect(await a.getClusterModelChoice({ stepId: FACE })).toEqual({
      kind: 'unreadable',
      reason: 'store-read-failed',
      error: 'store down',
    })
  })

  it('stops answering from the first line of shutdown', async () => {
    const a = await boot({ [clusterModelSettingKey(FACE)]: 'auraface-r100' })
    await a.initialize(lastCtx(a))
    await a.shutdown()
    addon = null
    expect(await a.getClusterModelChoice({ stepId: FACE })).toEqual({
      kind: 'unreadable',
      reason: 'owner-not-ready',
    })
  })
})
