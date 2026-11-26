/**
 * The Customize draft (planning#675): `save(next)` only edits the draft, `commit`
 * writes it once with the stamp it read, a refusal keeps it, and two commits
 * chain the stamp the first returned.
 */
import type { Composition } from '@camstack/types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

interface Deferred {
  promise: Promise<unknown>
  resolve: () => void
}
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<unknown>((r) => {
    resolve = () => r(undefined)
  })
  return { promise, resolve }
}

const refetch = vi.hoisted((): { current: Deferred | null; calls: number } => ({
  current: null,
  calls: 0,
}))
const created = vi.hoisted((): { inputs: unknown[] } => ({ inputs: [] }))
/**
 * The server's block. `rendered` is what the last RENDER saw (a held `save`
 * closure sees only that); `server` is what a refetch now answers.
 */
interface BlockStore {
  rendered: { composition: unknown; updatedAt: number } | null
  server: { composition: unknown; updatedAt: number } | null
  updates: { expectedUpdatedAt: number }[]
}
const store = vi.hoisted((): BlockStore => ({ rendered: null, server: null, updates: [] }))
const read = (b: BlockStore['server']) => ({
  state: 'loaded',
  view:
    b === null
      ? null
      : {
          block: {
            id: 'blk',
            name: 'customize:provider-homeassistant/ha:feeder',
            code: '',
            enabled: true,
            createdAt: 1,
            updatedAt: b.updatedAt,
            createdBy: 'admin',
            status: 'running',
            lastChangedAt: 1,
            source: { kind: 'composition', composition: b.composition },
          },
          state: { kind: 'answered', state: null },
        },
})
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const idle = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false })
  return {
    ...actual,
    useCoreBlocksGetCustomization: () => ({
      status: 'success',
      data: read(store.rendered),
      error: null,
      refetch: () => {
        refetch.calls += 1
        // The query cache takes the answer; only a closure built BEFORE it keeps the old block.
        store.rendered = store.server
        return (
          refetch.current?.promise ??
          Promise.resolve({ status: 'success', data: read(store.server), error: null })
        )
      },
    }),
    useCoreBlocksCreateComposition: () => ({
      mutateAsync: vi.fn(async (input: unknown) => {
        created.inputs.push(input)
        return {}
      }),
      isPending: false,
    }),
    useCoreBlocksUpdateComposition: () => ({
      mutateAsync: vi.fn(
        async (input: { expectedUpdatedAt: number; block: { composition: unknown } }) => {
          store.updates.push({ expectedUpdatedAt: input.expectedUpdatedAt })
          if (store.server === null || input.expectedUpdatedAt !== store.server.updatedAt) {
            throw new Error('changed since you read it')
          }
          store.server = {
            composition: input.block.composition,
            updatedAt: store.server.updatedAt + 1,
          }
          return {}
        },
      ),
      isPending: false,
    }),
    useCoreBlocksDelete: idle,
  }
})
const { useDraftCustomization } = await import('../use-customization')

const TARGET = { addonId: 'provider-homeassistant', stableId: 'ha:feeder' }
const NEXT: Composition = {
  target: { kind: 'existing', device: TARGET },
  features: [{ kind: 'fields', cap: 'battery', fields: {} }],
}

beforeEach(() => {
  refetch.current = null
  refetch.calls = 0
  created.inputs = []
  store.rendered = null
  store.server = null
  store.updates = []
})

const OFF: Composition = { ...NEXT, features: [] }
const TWO: Composition = {
  ...NEXT,
  features: [
    { kind: 'fields', cap: 'battery', fields: {} },
    { kind: 'fields', cap: 'motion', fields: {} },
  ],
}

describe('useDraftCustomization', () => {
  it('an edit writes nothing; Discard restores the server state', async () => {
    store.rendered = { composition: OFF, updatedAt: 1000 }
    store.server = { composition: OFF, updatedAt: 1000 }
    const { result } = renderHook(() => useDraftCustomization(TARGET))
    await act(async () => {
      await result.current.save(NEXT)
    })
    expect(store.updates).toEqual([])
    expect(result.current.pendingCount).toBe(1)
    expect(result.current.state.kind === 'present' && result.current.state.composition).toEqual(
      NEXT,
    )
    act(() => result.current.discard())
    expect(result.current.pendingCount).toBe(0)
    expect(result.current.state.kind === 'present' && result.current.state.composition).toEqual(OFF)
  })

  it('two edits on one record are ONE write carrying the stamp that was read', async () => {
    store.rendered = { composition: OFF, updatedAt: 1000 }
    store.server = { composition: OFF, updatedAt: 1000 }
    const { result } = renderHook(() => useDraftCustomization(TARGET))
    await act(async () => {
      await result.current.save(NEXT)
    })
    await act(async () => {
      await result.current.save(TWO)
    })
    let reason: string | null = 'unset'
    await act(async () => {
      reason = await result.current.commit()
    })
    expect(reason).toBeNull()
    expect(store.updates).toEqual([{ expectedUpdatedAt: 1000 }])
    expect(store.server?.composition).toEqual(TWO)
    expect(result.current.pendingCount).toBe(0)
  })

  it('two consecutive Saves chain the stamp the first write returned', async () => {
    store.rendered = { composition: OFF, updatedAt: 1000 }
    store.server = { composition: OFF, updatedAt: 1000 }
    const { result } = renderHook(() => useDraftCustomization(TARGET))
    await act(async () => {
      await result.current.save(NEXT)
    })
    await act(async () => {
      await result.current.commit()
    })
    await act(async () => {
      await result.current.save(OFF)
    })
    await act(async () => {
      await result.current.commit()
    })
    expect(store.updates).toEqual([{ expectedUpdatedAt: 1000 }, { expectedUpdatedAt: 1001 }])
  })

  it('a stale refusal keeps the draft and names the reason', async () => {
    store.rendered = { composition: OFF, updatedAt: 1000 }
    store.server = { composition: OFF, updatedAt: 1000 }
    const { result } = renderHook(() => useDraftCustomization(TARGET))
    await act(async () => {
      await result.current.save(NEXT)
    })
    // Someone else wrote meanwhile: the stamp we read is now old.
    store.server = { composition: OFF, updatedAt: 1005 }
    let reason: string | null = null
    await act(async () => {
      reason = await result.current.commit()
    })
    expect(reason).toMatch(/changed since you read it/)
    expect(result.current.pendingCount).toBe(1)
    expect(result.current.state.kind === 'present' && result.current.state.composition).toEqual(
      NEXT,
    )
  })
})
