/**
 * The unsaved-changes guard: dirtiness is "a save would send something
 * different", and an action that drops the edits needs the operator's yes.
 */
import { describe, expect, it, vi } from 'vitest'
import { editorSignature, isEditorDirty, runGuarded } from '../lib/retrain-dirty.js'
import { acceptBox, deleteBox, seedEditor, selectBox, updateBox } from '../lib/retrain-editor.js'

const seeded = seedEditor(
  [],
  [
    {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      macroClass: 'person',
      trackId: 't',
      basis: 'subject-box',
      deltaMs: 0,
    },
  ],
)
const baseline = editorSignature(seeded)

describe('isEditorDirty', () => {
  it('a freshly seeded editor is clean — drafts alone are not edits', () => {
    expect(isEditorDirty(seeded, baseline)).toBe(false)
  })
  it('selection is not an edit', () => {
    expect(isEditorDirty(selectBox(seeded, 'b0'), baseline)).toBe(false)
  })
  it('accepting, relabelling and deleting are', () => {
    expect(isEditorDirty(acceptBox(seeded, 'b0'), baseline)).toBe(true)
    expect(isEditorDirty(updateBox(seeded, 'b0', { label: 'postman' }), baseline)).toBe(true)
    expect(isEditorDirty(deleteBox(seeded, 'b0'), baseline)).toBe(true)
  })
  it('is clean again once the baseline is the saved state', () => {
    const edited = updateBox(seeded, 'b0', { label: 'postman' })
    expect(isEditorDirty(edited, editorSignature(edited))).toBe(false)
  })
})

describe('runGuarded', () => {
  it('proceeds without asking when nothing would be lost', async () => {
    const confirm = vi.fn(async () => false)
    const proceed = vi.fn()
    expect(await runGuarded(false, confirm, proceed)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(proceed).toHaveBeenCalledOnce()
  })
  it('asks when dirty, and does nothing if the operator declines', async () => {
    const proceed = vi.fn()
    expect(await runGuarded(true, async () => false, proceed)).toBe(false)
    expect(proceed).not.toHaveBeenCalled()
  })
  it('proceeds when dirty and the operator agrees', async () => {
    const proceed = vi.fn()
    expect(await runGuarded(true, async () => true, proceed)).toBe(true)
    expect(proceed).toHaveBeenCalledOnce()
  })
})
