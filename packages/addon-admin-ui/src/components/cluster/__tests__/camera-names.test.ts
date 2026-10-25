/**
 * Naming a camera card.
 *
 * The fallback is the part that matters: a card whose device left the fleet,
 * or never had a name, must still identify itself. An empty heading over a
 * chart is worse than the id it replaced.
 */
import { describe, expect, it } from 'vitest'
import { cameraNamesById } from '../load/camera-names'

describe('cameraNamesById', () => {
  it('indexes the fleet by id', () => {
    const names = cameraNamesById([
      { id: 101, name: 'Camera hall' },
      { id: 1441, name: 'Parking pat' },
    ])
    expect(names.get(101)).toBe('Camera hall')
    expect(names.get(1441)).toBe('Parking pat')
  })

  it('trims, so a padded name does not render with its padding', () => {
    expect(cameraNamesById([{ id: 1, name: '  Porta retro  ' }]).get(1)).toBe('Porta retro')
  })

  it('treats a blank or missing name as ABSENT, not as a title', () => {
    const names = cameraNamesById([
      { id: 1, name: '   ' },
      { id: 2, name: '' },
      { id: 3, name: null },
      { id: 4 },
    ])
    // Every one of these must fall through to `Camera <id>` at the call site.
    expect(names.has(1)).toBe(false)
    expect(names.has(2)).toBe(false)
    expect(names.has(3)).toBe(false)
    expect(names.has(4)).toBe(false)
  })

  it('has nothing to say about a device that is not in the fleet', () => {
    expect(cameraNamesById([{ id: 101, name: 'Hall' }]).get(999)).toBeUndefined()
  })
})
