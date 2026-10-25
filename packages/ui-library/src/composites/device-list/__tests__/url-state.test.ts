// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceListUrlState } from '../url-state'

beforeEach(() => {
  window.history.replaceState(null, '', '/devices')
  localStorage.clear()
})
afterEach(() => {
  window.history.replaceState(null, '', '/devices')
  localStorage.clear()
})

describe('useDeviceListUrlState', () => {
  it('uses defaults when URL is empty and LS is empty', () => {
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    expect(result.current.state.page).toBe(1)
    expect(result.current.state.addons).toEqual([])
    expect(result.current.state.types).toEqual([])
    expect(result.current.state.q).toBe('')
  })

  it('parses a comma-joined addon param into a multi-select array', () => {
    window.history.replaceState(null, '', '/devices?addon=reolink,onvif')
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    expect(result.current.state.addons).toEqual(['reolink', 'onvif'])
  })

  it('serialises multiple selected addons back to the URL', () => {
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    act(() => {
      result.current.setAddons(['reolink', 'onvif'])
    })
    // URLSearchParams encodes the comma as %2C.
    expect(new URLSearchParams(window.location.search).get('addon')).toBe('reolink,onvif')
  })

  /**
   * The cards view is gone; every device list is a table. These four tests used
   * to assert that `view` round-tripped through the URL and localStorage. What
   * has to hold now is the opposite — and specifically that OLD links and OLD
   * stored blobs still open, because operators have both.
   */
  it('opens a legacy ?view=cards link and drops the parameter on the next write', () => {
    window.history.replaceState(null, '', '/devices?view=cards')
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    expect(result.current.state.page).toBe(1)
    act(() => {
      result.current.setPage(2)
    })
    expect(window.location.search).not.toContain('view=')
  })

  it('ignores a legacy view in localStorage rather than choking on it', () => {
    localStorage.setItem(
      'camstack:devices:lastFilters',
      JSON.stringify({ view: 'cards', type: 'camera' }),
    )
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    // The blob is still READ — its real filters survive the upgrade.
    expect(result.current.state.types).toEqual(['camera'])
    expect(Object.hasOwn(result.current.state, 'view')).toBe(false)
  })

  it('never writes a view back to the URL', () => {
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    act(() => {
      result.current.setTypes(['camera'])
    })
    expect(window.location.search).toContain('type=camera')
    expect(window.location.search).not.toContain('view=')
  })

  it('namespaces params under scope=nested (devicePage, deviceType, ...)', () => {
    window.history.replaceState(
      null,
      '',
      '/integrations?expand=reolink&deviceType=camera&devicePage=2',
    )
    const { result } = renderHook(() =>
      useDeviceListUrlState({
        scope: 'nested',
        lsKey: 'integrations:nested',
      }),
    )
    expect(result.current.state.types).toEqual(['camera'])
    expect(result.current.state.page).toBe(2)
  })

  it('resets page to 1 when filter changes', () => {
    window.history.replaceState(null, '', '/devices?page=5')
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    expect(result.current.state.page).toBe(5)
    act(() => {
      result.current.setAddons(['reolink'])
    })
    expect(result.current.state.page).toBe(1)
  })

  it('clearFilters resets every filter — there is nothing it preserves', () => {
    const { result } = renderHook(() => useDeviceListUrlState({ scope: 'root', lsKey: 'devices' }))
    act(() => {
      result.current.setAddons(['reolink'])
      result.current.setTypes(['camera'])
      result.current.setQ('hello')
    })
    act(() => {
      result.current.clearFilters()
    })
    expect(result.current.state.addons).toEqual([])
    expect(result.current.state.types).toEqual([])
    expect(result.current.state.q).toBe('')
  })
})
