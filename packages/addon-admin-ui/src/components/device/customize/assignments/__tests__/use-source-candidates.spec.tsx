import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listAll = vi.hoisted(() => ({
  current: { status: 'pending' } as { status: string; data?: unknown; error?: { message: string } },
}))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerListAll: () => listAll.current,
    useIntegrationsList: () => ({
      data: [{ id: 'int_ha', addonId: 'provider-homeassistant', name: 'Home Assistant' }],
    }),
  }
})
const capIndex = vi.hoisted(() => ({
  current: { kind: 'pending' } as {
    kind: string
    value?: ReadonlyMap<number, readonly string[]>
    reason?: string
  },
}))
vi.mock('../use-cap-index', () => ({ useCapIndex: () => capIndex.current }))
const { useSourceCandidates } = await import('../use-source-candidates')

const OPTIONS = {
  hostId: 103,
  excludeCameras: true,
  assigned: new Set<string>(),
  preferredCap: 'motion',
  enabled: true,
}
const PIR_ROW = {
  id: 3299,
  name: 'PIR porch',
  addonId: 'provider-homeassistant',
  stableId: 'ha:pir',
  type: 'sensor',
  location: 'Porch',
  isCamera: false,
  integrationId: 'int_ha',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  config: {},
}

beforeEach(() => {
  listAll.current = { status: 'pending' }
  capIndex.current = { kind: 'pending' }
})

describe('useSourceCandidates — D315', () => {
  it('pending while either read has not answered — never an empty list', () => {
    expect(renderHook(() => useSourceCandidates(OPTIONS)).result.current).toEqual({
      kind: 'pending',
    })
    listAll.current = { status: 'success', data: [PIR_ROW] }
    expect(renderHook(() => useSourceCandidates(OPTIONS)).result.current).toEqual({
      kind: 'pending',
    })
  })
  it('a failed fleet read is unknown with its reason', () => {
    listAll.current = { status: 'error', error: { message: 'hub busy' } }
    capIndex.current = { kind: 'known', value: new Map([[3299, ['motion']]]) }
    expect(renderHook(() => useSourceCandidates(OPTIONS)).result.current).toEqual({
      kind: 'unknown',
      reason: 'hub busy',
    })
  })
  it('both answered: candidates named with their integration', () => {
    listAll.current = { status: 'success', data: [PIR_ROW] }
    capIndex.current = { kind: 'known', value: new Map([[3299, ['motion']]]) }
    const out = renderHook(() => useSourceCandidates(OPTIONS)).result.current
    expect(out.kind === 'known' ? out.value.map((c) => c.detail) : null).toEqual([
      'Home Assistant · Porch',
    ])
  })
  it('a failed cap-index read is unknown with its reason — never a picker waiting forever', () => {
    listAll.current = { status: 'success', data: [PIR_ROW] }
    capIndex.current = { kind: 'unknown', reason: 'index down' }
    expect(renderHook(() => useSourceCandidates(OPTIONS)).result.current).toEqual({
      kind: 'unknown',
      reason: 'index down',
    })
  })
  it('a failure is said even while the other read is still pending', () => {
    capIndex.current = { kind: 'unknown', reason: 'index down' }
    expect(renderHook(() => useSourceCandidates(OPTIONS)).result.current).toEqual({
      kind: 'unknown',
      reason: 'index down',
    })
  })
})
