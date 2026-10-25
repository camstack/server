/**
 * `useDeviceList` — the shared "device fleet roster" hook (used by the
 * pipeline "Cameras" tables). Asserts the exact `listAll` input it passes
 * through, because the input IS the query key: a different `projection`
 * silently forks the cache instead of merging into it, and a mock that
 * ignores the arguments (the pattern most component specs use) would pass
 * unchanged if it regressed back to `{}`.
 *
 * It also asserts the call site declares NO query options. Since D274 the
 * caching window is registered once on the query client
 * (`applyFleetQueryDefaults`) rather than copied to each of the 26 call
 * sites — `staleTime` is per-OBSERVER, so 26 owners meant 26 chances to
 * forget, and six ui-library composites had already forgotten. That the
 * window then actually produces ONE fetch for N observers is measured
 * where it belongs, against a real client, in
 * `packages/ui-library/src/lib/__tests__/fleet-query-defaults.spec.tsx` —
 * not here, where it could only ever be a re-assertion of a passed prop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

interface ListAllInput {
  readonly addonId?: string
  readonly projection?: string
}
interface ListAllOptions {
  readonly staleTime?: number
  readonly gcTime?: number
}

const listAllSpy = vi.fn((_input?: ListAllInput, _options?: ListAllOptions) => ({
  data: undefined,
  isLoading: true,
}))

vi.mock('@camstack/ui-library', () => ({
  useDeviceManagerListAll: (input?: ListAllInput, options?: ListAllOptions) =>
    listAllSpy(input, options),
}))

import { useDeviceList } from '../useDevice'

describe('useDeviceList', () => {
  beforeEach(() => {
    listAllSpy.mockClear()
  })

  it('asks for the slim projection, not the default (config-carrying) one', () => {
    renderHook(() => useDeviceList())
    expect(listAllSpy).toHaveBeenCalledTimes(1)
    const [input] = listAllSpy.mock.calls[0]
    expect(input?.projection).toBe('slim')
  })

  it('declares no caching window of its own — the query client owns it', () => {
    renderHook(() => useDeviceList())
    const [, options] = listAllSpy.mock.calls[0]
    expect(options?.staleTime).toBeUndefined()
    expect(options?.gcTime).toBeUndefined()
  })

  it('still honours an explicit addonId filter alongside the slim projection', () => {
    renderHook(() => useDeviceList('provider-homeassistant'))
    const [input] = listAllSpy.mock.calls[0]
    expect(input?.addonId).toBe('provider-homeassistant')
    expect(input?.projection).toBe('slim')
  })
})
