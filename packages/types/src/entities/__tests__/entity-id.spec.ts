import { describe, expect, it } from 'vitest'
import {
  isEntityId,
  newEntityId,
  roomIdFromKey,
  tagIdFromKey,
  zoneIdFromKey,
} from '../entity-id.js'

describe('entity ids', () => {
  it('a migrated id is a pure function of the folded key', () => {
    expect(tagIdFromKey('Garden')).toBe(tagIdFromKey('  garden '))
    expect(tagIdFromKey('garden')).not.toBe(tagIdFromKey('garage'))
  })
  it('the three kinds never share an id for the same name', () => {
    const ids = new Set([roomIdFromKey('x'), tagIdFromKey('x'), zoneIdFromKey('x')])
    expect(ids.size).toBe(3)
  })
  it('a created id is random and has the id shape; a name never does', () => {
    const a = newEntityId('room')
    expect(a).not.toBe(newEntityId('room'))
    expect(isEntityId('room', a)).toBe(true)
    expect(isEntityId('room', roomIdFromKey('Kitchen'))).toBe(true)
    expect(isEntityId('room', 'Kitchen')).toBe(false)
    expect(isEntityId('tag', a)).toBe(false)
  })
})
