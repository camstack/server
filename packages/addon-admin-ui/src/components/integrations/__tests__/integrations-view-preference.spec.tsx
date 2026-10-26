// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INTEGRATIONS_VIEW_STORAGE_KEY,
  readIntegrationsView,
  useIntegrationsView,
  writeIntegrationsView,
} from '../integrations-view-preference'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('integrations view preference', () => {
  it('reads table until the operator picks a view', () => {
    expect(readIntegrationsView()).toBe('table')
  })

  it('round-trips grid and ignores a value that is not a view', () => {
    writeIntegrationsView('grid')
    expect(localStorage.getItem(INTEGRATIONS_VIEW_STORAGE_KEY)).toBe('grid')
    expect(readIntegrationsView()).toBe('grid')
    localStorage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, 'cards')
    expect(readIntegrationsView()).toBe('table')
  })

  it('stays on the table when storage cannot be read, and keeps an in-memory choice when it cannot be written', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readIntegrationsView()).toBe('table')
    vi.restoreAllMocks()

    const { result } = renderHook(() => useIntegrationsView())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    act(() => {
      result.current[1]('grid')
    })
    expect(result.current[0]).toBe('grid')
    expect(() => writeIntegrationsView('table')).not.toThrow()
  })
})
