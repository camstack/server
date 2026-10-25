// @vitest-environment jsdom
/**
 * The editor's hotkeys on a selected box: 1–6 assign the macro class, ↑ / ↓ and
 * Tab walk the boxes, and nothing but typing happens inside a field.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { seedEditor, selectBox } from '../lib/retrain-editor'
import { CLASS_HOTKEYS, resolveShortcut, type ShortcutKey } from '../lib/retrain-shortcuts'
import { useRetrainEditorHistory } from '../use-retrain-editor-history'
import { applyRetrainShortcut, type RetrainShortcutCallbacks } from '../use-retrain-shortcuts'

const key = (k: string, over: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  typing: false,
  ...over,
})

const saved = (id: string, x: number) => ({
  id,
  trackId: 't',
  deviceId: 1,
  mediaKey: 'f',
  bbox: { x, y: 0.1, w: 0.1, h: 0.1 },
  macroClass: 'person' as const,
  kind: 'subject' as const,
  source: 'operator' as const,
  createdAt: 1,
})

function setup() {
  const hook = renderHook(() =>
    useRetrainEditorHistory(() =>
      selectBox(seedEditor([saved('a', 0.1), saved('b', 0.4)], []), 'b0'),
    ),
  )
  const callbacks = (): RetrainShortcutCallbacks => ({
    history: hook.result.current,
    onNextFrame: () => false,
    onPrevFrame: () => false,
    onToggleComplete: () => false,
    onSave: () => false,
    onZoomIn: () => undefined,
    onZoomOut: () => undefined,
    onZoomFit: () => undefined,
  })
  const press = (k: string): boolean => {
    const action = resolveShortcut(key(k))
    if (action === null) return false
    let done = false
    act(() => {
      done = applyRetrainShortcut(action, callbacks())
    })
    return done
  }
  return { hook, press }
}

describe('class hotkeys 1–6', () => {
  it.each(
    CLASS_HOTKEYS.map((c, i) => [String(i + 1), c] as const),
  )('%s assigns %s to the selected box', (digit, macroClass) => {
    const { hook, press } = setup()
    expect(press(digit)).toBe(true)
    expect(hook.result.current.editor.boxes[0]?.macroClass).toBe(macroClass)
    expect(hook.result.current.editor.boxes[1]?.macroClass).toBe('person')
  })

  it('does nothing with no box selected', () => {
    const { hook, press } = setup()
    act(() => {
      hook.result.current.selectOnly((s) => selectBox(s, null))
    })
    expect(press('2')).toBe(false)
  })

  it('is one undo step, so a wrong digit is one Ctrl+Z away', () => {
    const { hook, press } = setup()
    press('2')
    act(() => {
      hook.result.current.undo()
    })
    expect(hook.result.current.editor.boxes[0]?.macroClass).toBe('person')
  })
})

describe('selection keys', () => {
  it('↓ / ↑ and Tab walk the boxes, wrapping', () => {
    expect(resolveShortcut(key('ArrowDown'))).toEqual({ kind: 'select-next' })
    expect(resolveShortcut(key('ArrowUp'))).toEqual({ kind: 'select-prev' })
    const { hook, press } = setup()
    press('ArrowDown')
    expect(hook.result.current.editor.selectedKey).toBe('b1')
    press('ArrowDown')
    expect(hook.result.current.editor.selectedKey).toBe('b0')
    press('ArrowUp')
    expect(hook.result.current.editor.selectedKey).toBe('b1')
  })

  it('selecting is not an edit', () => {
    const { hook, press } = setup()
    press('ArrowDown')
    expect(hook.result.current.canUndo).toBe(false)
  })
})

describe('typing', () => {
  it('no hotkey fires inside a field, digits and arrows included', () => {
    for (const k of ['1', '6', 'ArrowDown', 'ArrowUp', 'Delete', 'a', 'e']) {
      expect(resolveShortcut(key(k, { typing: true }))).toBeNull()
    }
  })
})
