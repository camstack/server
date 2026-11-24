/**
 * A save is in flight until its refetch LANDS (task 5 review M2): in between
 * the state is the old one, and a second plan against it could read a real
 * change as a no-op and drop it silently (D391).
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
            placement: 'hub',
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
const { useCustomization } = await import('../use-customization')

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

describe('useCustomization — one save at a time, until its refetch lands', () => {
  it('saving stays true through the refetch; a second save meanwhile is refused by name, not planned', async () => {
    refetch.current = deferred()
    const { result } = renderHook(() => useCustomization(TARGET))
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = result.current.save(NEXT)
      await Promise.resolve()
    })
    expect(result.current.saving).toBe(true)
    let second: unknown
    await act(async () => {
      second = await result.current.save(NEXT)
    })
    expect(second).toEqual({ kind: 'refused', reason: expect.stringMatching(/still being saved/) })
    expect(created.inputs).toHaveLength(1)
    await act(async () => {
      refetch.current?.resolve()
      await first
    })
    expect(result.current.saving).toBe(false)
    expect(refetch.calls).toBe(1)
  })
})

describe('useCustomization — a second save plans against the block the first one produced', () => {
  it('two consecutive saves from the SAME held closure: the second sends the new updatedAt', async () => {
    const OFF: Composition = { ...NEXT, features: [] }
    store.rendered = { composition: OFF, updatedAt: 1000 }
    store.server = { composition: OFF, updatedAt: 1000 }
    const { result } = renderHook(() => useCustomization(TARGET))
    // The closure a click handler holds before React re-renders with the refetch.
    const held = result.current.save
    let first: unknown
    let second: unknown
    await act(async () => {
      first = await held(NEXT)
    })
    await act(async () => {
      second = await held(OFF)
    })
    expect(first).toEqual({ kind: 'saved' })
    expect(second).toEqual({ kind: 'saved' })
    expect(store.updates).toEqual([{ expectedUpdatedAt: 1000 }, { expectedUpdatedAt: 1001 }])
  })
})
