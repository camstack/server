/**
 * Regression tests for the agent-settings read-modify-write race.
 *
 * `writeAgentSettings` / `removeAgentSettings` are read-modify-write over
 * the WHOLE `agentSettings` blob (`get()` → merge one node's entry →
 * `set()`), with an async boundary between the read and the write. Two
 * concurrent writers — e.g. the admin-ui weight slider committing several
 * nodes while a `reachableHost` save lands — could interleave those
 * sections and silently drop one node's write: both read the same
 * snapshot, each merges its own node, and the second `set()` clobbers the
 * first. The store serializes every agent-settings read-modify-write
 * through a `KeyedAsyncLock`, so these tests pin that both writes survive.
 */
import { describe, expect, it } from 'vitest'
import { type AgentPipelineSettings, createDurableState, type DurableState } from '@camstack/types'
import type { ZodType } from 'zod'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { makeSilentLogger } from './e2e-helpers.js'

interface StoreHarness {
  readonly store: PipelineSettingsStore
  /** Raw persisted top-level blob (post-write inspection seam). */
  readonly readBlob: () => Record<string, unknown>
}

/**
 * In-memory addon-store fake with one microtask tick on each read/write —
 * the same async boundary the real settings-backed addon store has, which
 * is exactly what lets two read-modify-write sections interleave.
 */
function makeStoreHarness(): StoreHarness {
  let blob: Record<string, unknown> = {}
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => {
        await Promise.resolve()
        return blob
      },
      write: async (patch) => {
        await Promise.resolve()
        blob = { ...blob, ...patch }
      },
    })
  const store = new PipelineSettingsStore({
    state,
    api: () => null,
    acquireCapability: () => Promise.reject(new Error('acquireCapability not used here')),
    getAssignmentNode: () => 'hub',
    hasPackageZone: async () => false,
    logger: makeSilentLogger(),
  })
  return { store, readBlob: () => blob }
}

describe('PipelineSettingsStore — agent-settings write atomicity', () => {
  it('two concurrent writes to DIFFERENT nodes both survive', async () => {
    const { store } = makeStoreHarness()
    const a: AgentPipelineSettings = { maxCameras: 4 }
    const b: AgentPipelineSettings = { maxCameras: 8 }

    await Promise.all([
      store.writeAgentSettings('node-a', a),
      store.writeAgentSettings('node-b', b),
    ])

    const all = await store.readAgentSettingsMap()
    expect(Object.keys(all).toSorted()).toEqual(['node-a', 'node-b'])
    expect(all['node-a']?.maxCameras).toBe(4)
    expect(all['node-b']?.maxCameras).toBe(8)
  })

  it('an N-writer burst (weight-slider committing several nodes) loses no entry', async () => {
    const { store } = makeStoreHarness()
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5']

    await Promise.all(
      nodes.map((nodeId, i) =>
        store.writeAgentSettings(nodeId, { maxCameras: null, detectWeight: i + 1 }),
      ),
    )

    const all = await store.readAgentSettingsMap()
    expect(Object.keys(all).toSorted()).toEqual(nodes)
    for (const [i, nodeId] of nodes.entries()) {
      expect(all[nodeId]?.detectWeight).toBe(i + 1)
    }
  })

  it('a concurrent write and remove of DIFFERENT nodes both take effect', async () => {
    const { store } = makeStoreHarness()
    await store.writeAgentSettings('node-a', { maxCameras: null })

    const [removed] = await Promise.all([
      store.removeAgentSettings('node-a'),
      store.writeAgentSettings('node-b', { maxCameras: null }),
    ])

    expect(removed).toBe(true)
    const all = await store.readAgentSettingsMap()
    expect(Object.keys(all)).toEqual(['node-b'])
  })

  it('a write landing after dispose() is a no-op (shutdown semantics)', async () => {
    const { store } = makeStoreHarness()
    await store.writeAgentSettings('node-a', { maxCameras: null })

    store.dispose()
    await store.writeAgentSettings('node-b', { maxCameras: null })

    const all = await store.readAgentSettingsMap()
    expect(Object.keys(all)).toEqual(['node-a'])
  })
})

describe('PipelineSettingsStore — removeCapabilityBindings (#265)', () => {
  it('drops one node and keeps the others; a second call reports nothing removed', async () => {
    const { store } = makeStoreHarness()
    await store.setCapabilityBinding('node-a', 'detection-pipeline', 'addon-x')
    await store.setCapabilityBinding('node-b', 'detection-pipeline', 'addon-y')

    expect(await store.removeCapabilityBindings('node-a')).toBe(true)
    expect(await store.getCapabilityBindings('node-a')).toEqual({})
    expect(await store.getCapabilityBindings('node-b')).toEqual({
      'detection-pipeline': 'addon-y',
    })
    expect(await store.removeCapabilityBindings('node-a')).toBe(false)
  })
})
