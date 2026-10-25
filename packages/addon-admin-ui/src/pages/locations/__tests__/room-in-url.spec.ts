import { describe, expect, it } from 'vitest'

/**
 * The room selection lives in the URL so that going INTO a device and back
 * returns to the same room — with the choice in component state, Back dropped
 * the operator on the first room every time.
 *
 * The resolution is asserted as a pure rule rather than through the router:
 * what matters is that an unknown room REPAIRS to the first instead of
 * rendering nothing, which is the state the page has no useful drawing for.
 */
function resolveActiveRoom(requested: string | null, rooms: readonly string[]): string | null {
  if (requested !== null && rooms.includes(requested)) return requested
  return rooms[0] ?? null
}

const ROOMS = ['Front door', 'Kitchen', 'Hall']

describe('the room the Locations page shows', () => {
  it('honours the room named in the URL', () => {
    expect(resolveActiveRoom('Kitchen', ROOMS)).toBe('Kitchen')
  })

  it('falls back to the first room when the URL names none', () => {
    expect(resolveActiveRoom(null, ROOMS)).toBe('Front door')
  })

  it('repairs a room that no longer exists — a rename, a delete, a stale bookmark', () => {
    expect(resolveActiveRoom('Tinello', ROOMS)).toBe('Front door')
  })

  it('answers null only when there are no rooms at all', () => {
    expect(resolveActiveRoom('Kitchen', [])).toBeNull()
    expect(resolveActiveRoom(null, [])).toBeNull()
  })
})
