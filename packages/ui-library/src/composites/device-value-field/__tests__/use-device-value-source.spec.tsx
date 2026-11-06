import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Status = 'pending' | 'error' | 'success'
const state: { wireable: Status; snapshot: Status } = { wireable: 'success', snapshot: 'success' }

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerListAll: () => ({ status: 'success', data: [] }),
  useDeviceManagerListDeviceIdsByCaps: () => ({ status: 'success', data: [] }),
  useDeviceManagerGetWireableFields: () => ({
    status: state.wireable,
    data:
      state.wireable === 'success'
        ? { caps: [{ cap: 'tank', fields: [{ path: 'level', kind: 'number' }] }] }
        : undefined,
  }),
  useDeviceStateGetSnapshot: () => ({
    status: state.snapshot,
    data: state.snapshot === 'success' ? { tank: { level: 40, unit: '%' } } : undefined,
  }),
}))

const { useDeviceValueSource } = await import('../use-device-value-source')

const seen: (string | null)[] = []
function run() {
  seen.length = 0
  return renderHook(() =>
    useDeviceValueSource({
      deviceId: 7,
      fit: (field) => {
        seen.push(field.unit)
        return field.unit === null ? null : ''
      },
      capTitle: (cap) => cap,
      fieldLabel: (_cap, path) => path,
    }),
  ).result.current
}

describe('useDeviceValueSource while the snapshot has not answered', () => {
  beforeEach(() => {
    state.wireable = 'success'
    state.snapshot = 'success'
  })

  it('reads the unit from the answered snapshot and lists the fitting value', () => {
    const source = run()
    expect(source.valuesState).toBe('ready')
    expect(source.groups.flatMap((g) => g.rows.map((r) => r.path))).toEqual(['level'])
  })

  it('is loading, never "no value", while the snapshot is pending', () => {
    state.snapshot = 'pending'
    const source = run()
    expect(source.valuesState).toBe('loading')
    expect(source.groups).toEqual([])
    expect(seen).toEqual([])
  })

  it('is failed, never "no value", when the snapshot failed', () => {
    state.snapshot = 'error'
    const source = run()
    expect(source.valuesState).toBe('failed')
    expect(source.groups).toEqual([])
  })
})
