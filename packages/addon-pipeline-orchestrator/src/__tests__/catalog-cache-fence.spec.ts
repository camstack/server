/**
 * D650 round 3 — the node catalog cache the re-place paths read.
 *
 *  - An invalidation FENCES a refresh already in flight: a read that began
 *    before `invalidateCatalog()` must never re-install the catalog the
 *    invalidation just removed (per node and for a full clear).
 *  - A catalog served past its TTL is warned once per node, with its age.
 *  - A failed read is a WARN once per failing stretch, not a debug line.
 */
import {
  type AddonContext,
  createDurableState,
  type DurableState,
  type PipelineSchema,
} from '@camstack/types'
import type { ZodType } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { CORAL_GPU_CATALOG, NODE } from './attach-pipeline-fixtures.js'
import { makeSilentLogger } from './e2e-helpers.js'

interface Harness {
  readonly store: PipelineSettingsStore
  /** Resolve the oldest pending `getSchema`. */
  readonly answer: (schema: PipelineSchema) => void
  /** Reject the oldest pending `getSchema`. */
  readonly fail: () => void
  readonly warns: () => readonly string[]
}

function makeHarness(): Harness {
  let blob: Record<string, unknown> = {}
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => blob,
      write: async (patch) => {
        blob = { ...blob, ...patch }
      },
    })
  const pending: Array<{ resolve: (s: PipelineSchema) => void; reject: (e: Error) => void }> = []
  const api = {
    pipelineExecutor: {
      getSchema: {
        query: () =>
          new Promise<PipelineSchema>((resolve, reject) => {
            pending.push({ resolve, reject })
          }),
      },
    },
  }
  const warns: string[] = []
  const store = new PipelineSettingsStore({
    state,
    api: () => api as never,
    acquireCapability: (async (): Promise<unknown> =>
      undefined) as AddonContext['acquireCapability'],
    getAssignmentNode: () => NODE,
    hasPackageZone: async () => false,
    logger: { ...makeSilentLogger(), warn: (message: string) => void warns.push(message) },
  })
  return {
    store,
    answer: (schema) => pending.shift()?.resolve(schema),
    fail: () => pending.shift()?.reject(new Error('executor down')),
    warns: () => warns,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('node catalog cache (D650 round 3)', () => {
  it('a refresh started before a NODE invalidation never re-installs its answer', async () => {
    const h = makeHarness()
    expect(h.store.peekCatalogForAgent(NODE)).toBeNull() // starts the refresh
    h.store.invalidateCatalog(NODE)
    h.answer(CORAL_GPU_CATALOG)
    await settle()
    // Fenced: the pre-invalidation answer was not cached.
    expect(h.store.peekCatalogForAgent(NODE)).toBeNull()
  })

  it('a refresh started before a FULL invalidation never re-installs its answer', async () => {
    const h = makeHarness()
    h.store.peekCatalogForAgent(NODE)
    h.store.invalidateCatalog()
    h.answer(CORAL_GPU_CATALOG)
    await settle()
    expect(h.store.peekCatalogForAgent(NODE)).toBeNull()
  })

  it('a caller whose read was fenced out re-awaits a fresh read, never the stale answer', async () => {
    // Round 4. The fence kept a pre-invalidation answer out of the CACHE but
    // still handed it to the caller awaiting it, so a first placement could
    // resolve against the catalog the invalidation had just removed.
    const h = makeHarness()
    let settled: PipelineSchema | null | undefined
    const read = h.store.getCatalogForNode(NODE).then((v) => {
      settled = v
      return v
    })
    await settle()
    h.store.invalidateCatalog(NODE)
    h.answer(CORAL_GPU_CATALOG) // the answer that predates the invalidation
    await settle()
    expect(settled).toBeUndefined()

    const fresh: PipelineSchema = {
      ...CORAL_GPU_CATALOG,
      selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
    }
    h.answer(fresh)
    expect(await read).toEqual(fresh)
    expect(h.store.peekCatalogForAgent(NODE)).toEqual(fresh)
  })

  it('an unfenced refresh lands', async () => {
    const h = makeHarness()
    h.store.peekCatalogForAgent(NODE)
    h.answer(CORAL_GPU_CATALOG)
    await settle()
    expect(h.store.peekCatalogForAgent(NODE)).toEqual(CORAL_GPU_CATALOG)
  })

  it('a catalog a minute past its TTL is served SILENTLY; one 6 min past warns ONCE; a failed refresh warns once', async () => {
    // Pre-ship review M5: the re-place sweep runs every 60 s against a 30 s
    // TTL, so every round serves past the TTL by construction — a warn there
    // said nothing. Only an age past CATALOG_STALE_WARN_MS (5 min) is news.
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness()
    h.store.peekCatalogForAgent(NODE)
    h.answer(CORAL_GPU_CATALOG)
    await settle()
    vi.setSystemTime(Date.now() + 60_000)
    expect(h.store.peekCatalogForAgent(NODE)).toEqual(CORAL_GPU_CATALOG) // stale, served
    h.fail()
    await settle()
    const staleLine = (w: string): boolean =>
      w.startsWith('serving a node catalog long past its TTL')
    expect(h.warns().filter(staleLine)).toEqual([])

    vi.setSystemTime(Date.now() + 5 * 60_000)
    expect(h.store.peekCatalogForAgent(NODE)).toEqual(CORAL_GPU_CATALOG)
    h.fail()
    await settle()
    expect(h.store.peekCatalogForAgent(NODE)).toEqual(CORAL_GPU_CATALOG)
    h.fail()
    await settle()
    expect(h.warns().filter(staleLine)).toHaveLength(1)
    expect(h.warns().filter((w) => w.startsWith('node catalog read failed'))).toHaveLength(1)
  })
})
