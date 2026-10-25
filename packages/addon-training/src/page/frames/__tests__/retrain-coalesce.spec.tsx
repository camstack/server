// @vitest-environment jsdom
/**
 * Typing into a label is ONE undo step, not one per keystroke: focus opens the
 * step, every keystroke updates it live, blur closes it — and the whole thing
 * is also what the subject row wires its inputs to.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { seedEditor, updateBox } from '../lib/retrain-editor'
import { RetrainSubjectRow } from '../RetrainSubjectRow'
import { useRetrainEditorHistory } from '../use-retrain-editor-history'

const seeded = seedEditor(
  [
    {
      id: 'a',
      trackId: 't',
      deviceId: 1,
      mediaKey: 'f',
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      macroClass: 'person',
      kind: 'subject',
      source: 'operator',
      createdAt: 1,
    },
  ],
  [],
)

function typeLabel(history: ReturnType<typeof useRetrainEditorHistory>, text: string): void {
  act(() => {
    history.beginGesture()
  })
  for (let n = 1; n <= text.length; n += 1) {
    act(() => {
      history.updateGesture((s) => updateBox(s, 'b0', { label: text.slice(0, n) }))
    })
  }
  act(() => {
    history.endGesture()
  })
}

describe('coalesced label typing', () => {
  it('seven keystrokes are one undo step', () => {
    const { result } = renderHook(() => useRetrainEditorHistory(() => seeded))
    typeLabel(result.current, 'postman')
    expect(result.current.editor.boxes[0]?.label).toBe('postman')
    act(() => {
      result.current.undo()
    })
    expect(result.current.editor.boxes[0]?.label).toBeUndefined()
    expect(result.current.canUndo).toBe(false)
  })

  it('two separate edits are two steps', () => {
    const { result } = renderHook(() => useRetrainEditorHistory(() => seeded))
    typeLabel(result.current, 'post')
    typeLabel(result.current, 'postman')
    act(() => {
      result.current.undo()
    })
    expect(result.current.editor.boxes[0]?.label).toBe('post')
    expect(result.current.canUndo).toBe(true)
  })

  it('focusing and leaving a field without typing records nothing', () => {
    const { result } = renderHook(() => useRetrainEditorHistory(() => seeded))
    act(() => {
      result.current.beginGesture()
    })
    act(() => {
      result.current.endGesture()
    })
    expect(result.current.canUndo).toBe(false)
  })

  it('the row opens the step on focus, streams keystrokes, and closes it on blur / Enter', () => {
    const start = vi.fn()
    const live = vi.fn()
    const end = vi.fn()
    render(
      <RetrainSubjectRow
        box={seeded.boxes[0]!}
        diff={undefined}
        selected
        hover={null}
        vocabulary={[]}
        onHover={() => undefined}
        onSelect={() => undefined}
        onChange={() => undefined}
        onEditStart={start}
        onEditLive={live}
        onEditEnd={end}
        onAccept={() => undefined}
        onToggleModelError={() => undefined}
        onDelete={() => undefined}
      />,
    )
    const field = screen.getByLabelText('Label')
    fireEvent.focus(field)
    expect(start).toHaveBeenCalledOnce()
    fireEvent.change(field, { target: { value: 'p' } })
    fireEvent.change(field, { target: { value: 'po' } })
    expect(live).toHaveBeenCalledTimes(2)
    expect(live).toHaveBeenLastCalledWith('b0', { label: 'po' })
    expect(end).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(end).toHaveBeenCalledOnce()
  })
})
