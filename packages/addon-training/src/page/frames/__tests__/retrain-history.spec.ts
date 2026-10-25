/**
 * Undo / redo for the frame editor. A drag is ONE step however many pointer
 * moves it took, and undo restores a draft as a draft.
 */
import { describe, expect, it } from 'vitest'
import { acceptBox, seedEditor, selectBox, updateBox } from '../lib/retrain-editor.js'
import {
  beginGesture,
  canRedo,
  canUndo,
  commit,
  endGesture,
  historyOf,
  HISTORY_LIMIT,
  redo,
  replacePresent,
  transient,
  undo,
} from '../lib/retrain-history.js'

const seeded = seedEditor(
  [],
  [
    {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      macroClass: 'person',
      trackId: 't',
      basis: 'position',
      deltaMs: 0,
    },
  ],
)
const key = seeded.boxes[0]!.key

describe('editor history', () => {
  it('undo restores a confirmed draft back to a draft; redo re-confirms it', () => {
    let h = historyOf(seeded)
    h = commit(h, acceptBox(h.present, key))
    expect(h.present.boxes[0]?.draft).toBe(false)
    h = undo(h)
    expect(h.present.boxes[0]?.draft).toBe(true)
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(h.present.boxes[0]?.draft).toBe(false)
  })

  it('a gesture of many moves is one undo step', () => {
    let h = beginGesture(historyOf(seeded))
    for (const x of [0.12, 0.14, 0.16, 0.18]) {
      h = transient(h, updateBox(h.present, key, { bbox: { x, y: 0.1, w: 0.2, h: 0.2 } }))
    }
    h = endGesture(h)
    expect(h.past).toHaveLength(1)
    expect(h.present.boxes[0]?.bbox.x).toBe(0.18)
    h = undo(h)
    expect(h.present.boxes[0]?.bbox.x).toBe(0.1)
    expect(h.present.boxes[0]?.draft).toBe(true)
  })

  it('a gesture that changed nothing (a click) leaves no step', () => {
    const h = endGesture(beginGesture(historyOf(seeded)))
    expect(canUndo(h)).toBe(false)
  })

  it('a new edit clears the redo stack; selection is not a step', () => {
    let h = commit(historyOf(seeded), acceptBox(seeded, key))
    h = undo(h)
    h = replacePresent(h, selectBox(h.present, key))
    expect(canRedo(h)).toBe(true)
    h = commit(h, updateBox(h.present, key, { label: 'van' }))
    expect(canRedo(h)).toBe(false)
    expect(h.past).toHaveLength(1)
  })

  it('keeps at most HISTORY_LIMIT steps', () => {
    let h = historyOf(seeded)
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      h = commit(h, updateBox(h.present, key, { label: `l${String(i)}` }))
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT)
  })
})
