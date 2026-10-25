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
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const idle = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false })
  return {
    ...actual,
    useCoreBlocksGetCustomization: () => ({
      status: 'success',
      data: { state: 'loaded', view: null },
      error: null,
      refetch: () => {
        refetch.calls += 1
        return refetch.current?.promise ?? Promise.resolve(undefined)
      },
    }),
    useCoreBlocksCreateComposition: () => ({
      mutateAsync: vi.fn(async (input: unknown) => {
        created.inputs.push(input)
        return {}
      }),
      isPending: false,
    }),
    useCoreBlocksUpdateComposition: idle,
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
