import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeQuery {
  readonly status: string
  readonly data?: readonly number[]
  readonly error: { readonly message: string } | null
}
const answers = vi.hoisted(() => ({ current: [] as readonly FakeQuery[] }))
const seenOptions = vi.hoisted(() => ({ current: [] as unknown[] }))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const t = {
    deviceManager: {
      listDeviceIdsByCaps: (input: unknown, options: unknown) => {
        seenOptions.current.push(options)
        return { input, options }
      },
    },
  }
  return {
    ...actual,
    trpc: {
      ...actual.trpc,
      useQueries: (build: (t: unknown) => unknown) => {
        build(t)
        return answers.current
      },
    },
  }
})
const { useCapIndex } = await import('../use-cap-index')

beforeEach(() => {
  answers.current = []
  seenOptions.current = []
})

describe('useCapIndex — answered only when every cap answered (D315)', () => {
  it('one failed cap is unknown with its reason', () => {
    answers.current = [
      { status: 'success', data: [1], error: null },
      { status: 'error', error: { message: 'index down' } },
    ]
    expect(renderHook(() => useCapIndex(['motion', 'contact'], true)).result.current).toEqual({
      kind: 'unknown',
      reason: 'index down',
    })
  })
  it('a cap with no query result yet is pending — never an empty index', () => {
    answers.current = [{ status: 'success', data: [1], error: null }]
    expect(renderHook(() => useCapIndex(['motion', 'contact'], true)).result.current).toEqual({
      kind: 'pending',
    })
  })
  it('every cap answered: device → caps', () => {
    answers.current = [
      { status: 'success', data: [1, 2], error: null },
      { status: 'success', data: [2], error: null },
    ]
    const out = renderHook(() => useCapIndex(['motion', 'contact'], true)).result.current
    expect(out.kind === 'known' ? [...out.value.entries()] : null).toEqual([
      [1, ['motion']],
      [2, ['motion', 'contact']],
    ])
  })
  it('enabled reaches every per-cap query (a closed picker lists nothing)', () => {
    answers.current = []
    renderHook(() => useCapIndex(['motion', 'contact'], false))
    expect(seenOptions.current.length).toBeGreaterThan(0)
    expect(seenOptions.current.every((o) => JSON.stringify(o) === '{"enabled":false}')).toBe(true)
  })
})
