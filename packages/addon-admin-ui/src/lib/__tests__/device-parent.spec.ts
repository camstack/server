/**
 * A device's CONTAINER, resolved from a fleet listing.
 *
 * The fleet has 1096 devices and nine of them are called "Temperatura". A list
 * that shows only the name is a list the operator cannot pick from — the
 * container is the only thing that distinguishes them, and it is already on
 * every row the pickers fetch (`parentDeviceId` is on the slim projection), so
 * nothing here costs a query.
 */
import { describe, expect, it } from 'vitest'
import { resolveParentNames, type ParentResolvable } from '../device-parent'

const fleet: readonly ParentResolvable[] = [
  { id: 1, name: 'Sala', parentDeviceId: null },
  { id: 2, name: 'Temperatura', parentDeviceId: 1 },
  { id: 3, name: 'Temperatura', parentDeviceId: null },
  { id: 4, name: 'Temperatura', parentDeviceId: 99 },
]

describe('resolveParentNames', () => {
  it('names the container of a child', () => {
    expect(resolveParentNames(fleet).get(2)).toBe('Sala')
  })

  it('a top-level device has no container — undefined, not an empty string', () => {
    expect(resolveParentNames(fleet).get(3)).toBeUndefined()
  })

  // The listing can be filtered or partial, and a parent outside it is UNKNOWN.
  // Rendering nothing says "top-level", which is a different and wrong claim.
  it('a parent missing from the listing is unknown, never silently top-level', () => {
    expect(resolveParentNames(fleet).get(4)).toBe('#99')
  })

  it('survives a row that is its own parent instead of looping', () => {
    const looped: readonly ParentResolvable[] = [{ id: 7, name: 'Odd', parentDeviceId: 7 }]
    expect(resolveParentNames(looped).get(7)).toBeUndefined()
  })

  it('is one level — the container, not the whole ancestry', () => {
    const deep: readonly ParentResolvable[] = [
      { id: 1, name: 'Casa', parentDeviceId: null },
      { id: 2, name: 'Hub', parentDeviceId: 1 },
      { id: 3, name: 'Sensore', parentDeviceId: 2 },
    ]
    expect(resolveParentNames(deep).get(3)).toBe('Hub')
  })
})
