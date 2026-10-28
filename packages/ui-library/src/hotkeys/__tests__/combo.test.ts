import { describe, it, expect } from 'vitest'
import { matchesCombo, parseCombo, type KeyEventLike } from '../combo'

function ev(over: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: 'f',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }
}

describe('matchesCombo', () => {
  it('mod is Command on mac and Ctrl elsewhere', () => {
    expect(matchesCombo(ev({ metaKey: true }), 'mod+f', 'mac')).toBe(true)
    expect(matchesCombo(ev({ ctrlKey: true }), 'mod+f', 'mac')).toBe(false)
    expect(matchesCombo(ev({ ctrlKey: true }), 'mod+f', 'other')).toBe(true)
    expect(matchesCombo(ev({ metaKey: true }), 'mod+f', 'other')).toBe(false)
  })
  it('is case-insensitive on the key and strict on extra modifiers', () => {
    expect(matchesCombo(ev({ key: 'F', ctrlKey: true }), 'mod+f', 'other')).toBe(true)
    expect(matchesCombo(ev({ ctrlKey: true, shiftKey: true }), 'mod+f', 'other')).toBe(false)
    expect(matchesCombo(ev({ ctrlKey: true, shiftKey: true }), 'mod+shift+f', 'other')).toBe(true)
  })
  it('a bare key needs no modifier', () => {
    expect(matchesCombo(ev({ key: 'Escape' }), 'escape', 'mac')).toBe(true)
    expect(matchesCombo(ev({ key: 'Escape', metaKey: true }), 'escape', 'mac')).toBe(false)
  })
})

describe('parseCombo', () => {
  it('splits modifiers and key', () => {
    expect(parseCombo('mod+shift+k')).toEqual({
      mod: true,
      shift: true,
      alt: false,
      key: 'k',
    })
  })
})
