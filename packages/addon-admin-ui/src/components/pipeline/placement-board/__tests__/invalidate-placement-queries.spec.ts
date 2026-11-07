import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { invalidatePlacementQueries } from '../board-model'

describe('invalidatePlacementQueries', () => {
  it('invalidates the scoped settings the board reads, and no addon-level blob query', () => {
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    invalidatePlacementQueries(queryClient)
    const keys = invalidateQueries.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey))
    expect(keys).toContain(JSON.stringify([['addonSettings', 'getScopedSettings']]))
    expect(keys.some((key) => key.includes('getGlobalSettings'))).toBe(false)
  })
})
