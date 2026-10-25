/**
 * The Retrain page's keyboard map. Pure: an event-like object in, an action
 * out — and nothing at all while the operator is typing a label.
 */
import { describe, expect, it } from 'vitest'
import { type ShortcutKey, resolveShortcut, RETRAIN_SHORTCUTS } from '../lib/retrain-shortcuts.js'

function key(over: Partial<ShortcutKey> & Pick<ShortcutKey, 'key'>): ShortcutKey {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    typing: false,
    ...over,
  }
}

describe('resolveShortcut', () => {
  it('maps frames, deletion, classes, accept, error, complete', () => {
    expect(resolveShortcut(key({ key: 'ArrowRight' }))).toEqual({ kind: 'next-frame' })
    expect(resolveShortcut(key({ key: 'ArrowLeft' }))).toEqual({ kind: 'prev-frame' })
    expect(resolveShortcut(key({ key: 'Delete' }))).toEqual({ kind: 'delete' })
    expect(resolveShortcut(key({ key: 'Backspace' }))).toEqual({ kind: 'delete' })
    expect(resolveShortcut(key({ key: '2' }))).toEqual({ kind: 'set-class', macroClass: 'vehicle' })
    expect(resolveShortcut(key({ key: '6' }))).toEqual({ kind: 'set-class', macroClass: 'plate' })
    expect(resolveShortcut(key({ key: 'a' }))).toEqual({ kind: 'accept' })
    expect(resolveShortcut(key({ key: 'A', shiftKey: true }))).toEqual({ kind: 'accept-all' })
    expect(resolveShortcut(key({ key: 'e' }))).toEqual({ kind: 'toggle-model-error' })
    expect(resolveShortcut(key({ key: 'c' }))).toEqual({ kind: 'toggle-complete' })
    expect(resolveShortcut(key({ key: 'Escape' }))).toEqual({ kind: 'deselect' })
    expect(resolveShortcut(key({ key: 'Tab' }))).toEqual({ kind: 'select-next' })
    expect(resolveShortcut(key({ key: 'Tab', shiftKey: true }))).toEqual({ kind: 'select-prev' })
  })

  it('maps undo / redo / save on both Ctrl and Cmd', () => {
    expect(resolveShortcut(key({ key: 'z', ctrlKey: true }))).toEqual({ kind: 'undo' })
    expect(resolveShortcut(key({ key: 'z', metaKey: true }))).toEqual({ kind: 'undo' })
    expect(resolveShortcut(key({ key: 'Z', metaKey: true, shiftKey: true }))).toEqual({
      kind: 'redo',
    })
    expect(resolveShortcut(key({ key: 'y', ctrlKey: true }))).toEqual({ kind: 'redo' })
    expect(resolveShortcut(key({ key: 's', ctrlKey: true }))).toEqual({ kind: 'save' })
  })

  it('maps zoom', () => {
    expect(resolveShortcut(key({ key: '+' }))).toEqual({ kind: 'zoom-in' })
    expect(resolveShortcut(key({ key: '=' }))).toEqual({ kind: 'zoom-in' })
    expect(resolveShortcut(key({ key: '-' }))).toEqual({ kind: 'zoom-out' })
    expect(resolveShortcut(key({ key: '0' }))).toEqual({ kind: 'zoom-fit' })
  })

  it('does nothing while the operator types, except save', () => {
    expect(resolveShortcut(key({ key: 'a', typing: true }))).toBeNull()
    expect(resolveShortcut(key({ key: 'Backspace', typing: true }))).toBeNull()
    expect(resolveShortcut(key({ key: '1', typing: true }))).toBeNull()
    expect(resolveShortcut(key({ key: 's', ctrlKey: true, typing: true }))).toEqual({
      kind: 'save',
    })
  })

  it('leaves browser chords and unknown keys alone', () => {
    expect(resolveShortcut(key({ key: 'a', ctrlKey: true }))).toBeNull()
    expect(resolveShortcut(key({ key: 'c', metaKey: true }))).toBeNull()
    expect(resolveShortcut(key({ key: 'q' }))).toBeNull()
    expect(resolveShortcut(key({ key: 'e', altKey: true }))).toBeNull()
  })

  it('documents every shortcut it resolves', () => {
    expect(RETRAIN_SHORTCUTS.length).toBeGreaterThanOrEqual(14)
  })
})
