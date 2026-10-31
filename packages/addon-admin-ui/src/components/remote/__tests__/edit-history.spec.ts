import { describe, expect, it } from 'vitest'
import {
  canRedo,
  canUndo,
  EDIT_HISTORY_LIMIT,
  type EditHistory,
  editHistoryReducer,
  startHistory,
} from '../edit-history'

const edit = (h: EditHistory<string>, value: string): EditHistory<string> =>
  editHistoryReducer(h, { type: 'edit', value })
const undo = (h: EditHistory<string>): EditHistory<string> =>
  editHistoryReducer(h, { type: 'undo' })
const redo = (h: EditHistory<string>): EditHistory<string> =>
  editHistoryReducer(h, { type: 'redo' })

describe('edit history', () => {
  it('starts with nothing to undo or redo', () => {
    const h = startHistory('a')
    expect(h.present).toBe('a')
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  it('undo steps back and redo brings the step forward again', () => {
    const h = edit(edit(startHistory('a'), 'b'), 'c')
    const back = undo(undo(h))
    expect(back.present).toBe('a')
    expect(canUndo(back)).toBe(false)
    expect(canRedo(back)).toBe(true)
    expect(redo(back).present).toBe('b')
    expect(redo(redo(back)).present).toBe('c')
    expect(canRedo(redo(redo(back)))).toBe(false)
  })

  it('a new edit after an undo clears the redo branch', () => {
    const h = undo(edit(edit(startHistory('a'), 'b'), 'c'))
    expect(h.present).toBe('b')
    expect(canRedo(h)).toBe(true)
    const next = edit(h, 'x')
    expect(canRedo(next)).toBe(false)
    expect(redo(next)).toBe(next)
    expect(undo(next).present).toBe('b')
  })

  it('undo and redo with nothing to go to change nothing', () => {
    const h = startHistory('a')
    expect(undo(h)).toBe(h)
    expect(redo(h)).toBe(h)
  })

  it('an edit that changes nothing is not a step', () => {
    const h = startHistory('a')
    expect(edit(h, 'a')).toBe(h)
  })

  it('keeps only the most recent steps', () => {
    let h = startHistory('0')
    for (let i = 1; i <= EDIT_HISTORY_LIMIT + 10; i += 1) h = edit(h, String(i))
    expect(h.past).toHaveLength(EDIT_HISTORY_LIMIT)
    expect(h.past[0]).toBe('10')
    expect(h.present).toBe(String(EDIT_HISTORY_LIMIT + 10))
  })
})
