// @vitest-environment jsdom
/**
 * Editing on the canvas: a handle drag resizes the selected box as ONE undo
 * step, and the keyboard deletes / relabels / undoes through the same
 * history.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FULL_VIEWPORT } from '../lib/retrain-zoom'
import { seedEditor, selectBox } from '../lib/retrain-editor'
import { RetrainCanvas } from '../RetrainCanvas'
import { type RetrainEditorHistory, useRetrainEditorHistory } from '../use-retrain-editor-history'
import { applyRetrainShortcut, type RetrainShortcutCallbacks } from '../use-retrain-shortcuts'

// jsdom lays nothing out: give the canvas a 400×400 pane, so a 400×400 frame
// fills it exactly and pixel = 400 × normalised.
const PANE = 400
const SIZE_KEYS = ['clientWidth', 'clientHeight'] as const
const saved = new Map<string, PropertyDescriptor>()
beforeAll(() => {
  for (const key of SIZE_KEYS) {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
    if (d !== undefined) saved.set(key, d)
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => PANE })
  }
})
afterAll(() => {
  for (const [key, d] of saved) Object.defineProperty(HTMLElement.prototype, key, d)
})

const seeded = selectBox(
  seedEditor(
    [
      {
        id: 'a',
        trackId: 't',
        deviceId: 101,
        mediaKey: 'f',
        bbox: { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
        macroClass: 'person',
        kind: 'subject',
        source: 'operator',
        createdAt: 1,
      },
    ],
    [],
  ),
  'b0',
)

function Harness({ history }: { readonly history: RetrainEditorHistory }) {
  return (
    <RetrainCanvas
      imageSrc="data:image/jpeg;base64,"
      imageWidth={400}
      imageHeight={400}
      boxes={history.editor.boxes}
      selectedKey={history.editor.selectedKey}
      viewport={FULL_VIEWPORT}
      onViewportChange={() => undefined}
      panMode={false}
      onSelect={(key) => history.selectOnly((s) => selectBox(s, key))}
      onDraw={() => undefined}
      onGestureStart={history.beginGesture}
      onGestureBox={(key, bbox) =>
        history.updateGesture((s) => ({
          ...s,
          boxes: s.boxes.map((b) => (b.key === key ? { ...b, bbox, draft: false } : b)),
        }))
      }
      onGestureEnd={history.endGesture}
    />
  )
}

function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) {
  fireEvent[type](screen.getByTestId('retrain-canvas'), {
    pointerId: 1,
    button: 0,
    clientX: x,
    clientY: y,
  })
}

describe('canvas editing', () => {
  it('dragging the south-east handle resizes the box, as one undo step', () => {
    const { result } = renderHook(() => useRetrainEditorHistory(() => seeded))
    const view = render(<Harness history={result.current} />)
    const rerender = () => view.rerender(<Harness history={result.current} />)
    expect(screen.getByTestId('retrain-handle-se')).toBeTruthy()

    act(() => pointer('pointerDown', 200, 200)) // the se corner: (0.5, 0.5)
    rerender()
    act(() => pointer('pointerMove', 260, 240))
    rerender()
    act(() => pointer('pointerMove', 300, 280))
    rerender()
    act(() => pointer('pointerUp', 300, 280))
    rerender()

    const box = result.current.editor.boxes[0]!.bbox
    expect(box.x).toBeCloseTo(0.25)
    expect(box.w).toBeCloseTo(0.5)
    expect(box.h).toBeCloseTo(0.45)
    act(() => result.current.undo())
    expect(result.current.editor.boxes[0]!.bbox.w).toBeCloseTo(0.25)
  })

  it('the keyboard relabels, deletes and undoes through the history', () => {
    const { result } = renderHook(() => useRetrainEditorHistory(() => seeded))
    const callbacks = (): RetrainShortcutCallbacks => ({
      history: result.current,
      onNextFrame: () => false,
      onPrevFrame: () => false,
      onToggleComplete: () => false,
      onSave: () => false,
      onZoomIn: () => undefined,
      onZoomOut: () => undefined,
      onZoomFit: () => undefined,
    })
    act(() => {
      applyRetrainShortcut({ kind: 'set-class', macroClass: 'vehicle' }, callbacks())
    })
    expect(result.current.editor.boxes[0]?.macroClass).toBe('vehicle')
    act(() => {
      applyRetrainShortcut({ kind: 'delete' }, callbacks())
    })
    expect(result.current.editor.boxes).toHaveLength(0)
    act(() => {
      applyRetrainShortcut({ kind: 'undo' }, callbacks())
    })
    expect(result.current.editor.boxes[0]?.macroClass).toBe('vehicle')
    // Nothing selected after a deselect: delete does nothing and says so.
    act(() => {
      applyRetrainShortcut({ kind: 'deselect' }, callbacks())
    })
    let handled = true
    act(() => {
      handled = applyRetrainShortcut({ kind: 'delete' }, callbacks())
    })
    expect(handled).toBe(false)
  })
})
