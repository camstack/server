// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The hook reads the `admin.units` account-preference row and writes it back
 * as a compare-and-set on the revision it read. The tRPC client is a fake with
 * `preferences.get/put`; the system context supplies it.
 */

interface Row {
  readonly namespace: string
  readonly value: unknown
  readonly revision: number
}

let rows: readonly Row[]
let getFails: boolean
const get = vi.fn()
const put = vi.fn()

vi.mock('../../contexts/system-context', () => ({
  useSystem: () => ({
    trpcClient: { preferences: { get: { query: get }, put: { mutate: put } } },
  }),
}))

import { useAccountUnitPreferences } from '../use-account-unit-preferences'

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  rows = []
  getFails = false
  get.mockReset()
  put.mockReset()
  get.mockImplementation(async () => {
    if (getFails) throw new Error('offline')
    return { rows }
  })
})

describe('useAccountUnitPreferences', () => {
  it('is pending with the default value until the row answers', async () => {
    const { result } = renderHook(() => useAccountUnitPreferences(), {
      wrapper,
    })
    expect(result.current.status).toBe('pending')
    expect(result.current.writable).toBe(false)
    expect(result.current.value).toEqual({
      system: 'metric',
      temperature: 'celsius',
    })
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.writable).toBe(true)
  })

  it('reports a failed read as an error, not as the default', async () => {
    getFails = true
    const { result } = renderHook(() => useAccountUnitPreferences(), {
      wrapper,
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.writable).toBe(false)
  })

  it('reads the stored row', async () => {
    rows = [
      {
        namespace: 'admin.units',
        value: { system: 'imperial', temperature: 'fahrenheit' },
        revision: 3,
      },
    ]
    const { result } = renderHook(() => useAccountUnitPreferences(), {
      wrapper,
    })
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.value).toEqual({
      system: 'imperial',
      temperature: 'fahrenheit',
    })
  })

  it('writes against the revision it read and merges the change into the stored row', async () => {
    rows = [
      {
        namespace: 'admin.units',
        value: { system: 'imperial', temperature: 'celsius' },
        revision: 4,
      },
    ]
    put.mockImplementation(async (input: { value: unknown }) => ({
      status: 'saved',
      row: { namespace: 'admin.units', value: input.value, revision: 5 },
    }))
    const { result } = renderHook(() => useAccountUnitPreferences(), {
      wrapper,
    })
    await waitFor(() => expect(result.current.status).toBe('ok'))
    await act(async () => {
      await result.current.update({ temperature: 'fahrenheit' })
    })
    expect(put).toHaveBeenCalledWith({
      namespace: 'admin.units',
      value: { system: 'imperial', temperature: 'fahrenheit' },
      baseRevision: 4,
    })
    await waitFor(() => expect(result.current.value.temperature).toBe('fahrenheit'))
  })

  it('re-applies the change once to the row as it now stands after a conflict', async () => {
    put
      .mockResolvedValueOnce({
        status: 'conflict',
        current: {
          namespace: 'admin.units',
          value: { system: 'imperial', temperature: 'celsius' },
          revision: 7,
        },
      })
      .mockImplementationOnce(async (input: { value: unknown }) => ({
        status: 'saved',
        row: { namespace: 'admin.units', value: input.value, revision: 8 },
      }))
    const { result } = renderHook(() => useAccountUnitPreferences(), {
      wrapper,
    })
    await waitFor(() => expect(result.current.status).toBe('ok'))
    await act(async () => {
      await result.current.update({ temperature: 'fahrenheit' })
    })
    expect(put).toHaveBeenCalledTimes(2)
    expect(put).toHaveBeenLastCalledWith({
      namespace: 'admin.units',
      value: { system: 'imperial', temperature: 'fahrenheit' },
      baseRevision: 7,
    })
  })

  it('never overwrites a row it cannot read', async () => {
    rows = [
      {
        namespace: 'admin.units',
        value: { temperature: 'kelvin' },
        revision: 2,
      },
    ]
    const { result } = renderHook(() => useAccountUnitPreferences(), {
      wrapper,
    })
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.writable).toBe(false)
    await expect(result.current.update({ system: 'imperial' })).rejects.toThrow(/not readable/)
    expect(put).not.toHaveBeenCalled()
  })
})
