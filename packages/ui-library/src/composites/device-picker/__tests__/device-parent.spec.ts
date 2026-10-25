import { describe, expect, it } from 'vitest'
import {
  parentDetailOf,
  resolveParentNames,
  withResolvedParentDetail,
  type ParentResolvable,
} from '../device-parent'

/** A picker row: a listing row plus the optional second-line hint. */
interface DetailRow extends ParentResolvable {
  readonly detail?: string
}

function fleetOf(...rows: readonly ParentResolvable[]): readonly ParentResolvable[] {
  return rows
}

describe('resolveParentNames', () => {
  it('names a child after its container', () => {
    const fleet = fleetOf(
      { id: 1, name: 'Sala', parentDeviceId: null },
      { id: 2, name: 'Temperatura', parentDeviceId: 1 },
    )
    expect(resolveParentNames(fleet).get(2)).toBe('Sala')
  })

  it('leaves a top-level device unannotated', () => {
    const fleet = fleetOf({ id: 3, name: 'Camera', parentDeviceId: null })
    expect(resolveParentNames(fleet).get(3)).toBeUndefined()
  })

  it('falls back to #id when the parent is missing from the listing', () => {
    const fleet = fleetOf({ id: 4, name: 'Orphan', parentDeviceId: 99 })
    expect(resolveParentNames(fleet).get(4)).toBe('#99')
  })

  it('skips a self-parent loop', () => {
    const looped = fleetOf({ id: 7, name: 'Loop', parentDeviceId: 7 })
    expect(resolveParentNames(looped).get(7)).toBeUndefined()
  })

  it('resolves one level only (child → hub, not hub → grandparent)', () => {
    const deep = fleetOf(
      { id: 1, name: 'Site', parentDeviceId: null },
      { id: 2, name: 'Hub', parentDeviceId: 1 },
      { id: 3, name: 'Sensor', parentDeviceId: 2 },
    )
    expect(resolveParentNames(deep).get(3)).toBe('Hub')
  })
})

describe('parentDetailOf', () => {
  it('prefixes with in', () => {
    expect(parentDetailOf('Sala')).toBe('in Sala')
  })

  it('returns undefined for empty / absent', () => {
    expect(parentDetailOf(undefined)).toBeUndefined()
    expect(parentDetailOf('')).toBeUndefined()
  })
})

describe('withResolvedParentDetail', () => {
  it('fills unset detail from the parent name', () => {
    const devices: readonly DetailRow[] = [
      { id: 1, name: 'Hub', parentDeviceId: null },
      { id: 2, name: 'Temperatura', parentDeviceId: 1 },
    ]
    const next = withResolvedParentDetail(devices)
    expect(next[1]?.detail).toBe('in Hub')
    expect(next[0]?.detail).toBeUndefined()
  })

  it('keeps an explicit detail', () => {
    const devices: readonly DetailRow[] = [
      { id: 1, name: 'Hub', parentDeviceId: null },
      {
        id: 2,
        name: 'Temperatura',
        parentDeviceId: 1,
        detail: 'custom',
      },
    ]
    expect(withResolvedParentDetail(devices)[1]?.detail).toBe('custom')
  })
})
