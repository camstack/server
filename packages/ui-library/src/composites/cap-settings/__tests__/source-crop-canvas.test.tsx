/**
 * The shared source-crop canvas: one highlighted rectangle, a drag reported in
 * the frame's normalized space, and only the grips the owner asks for.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../hooks/use-device-snapshot.js', () => ({
  useDeviceSnapshotImage: () => ({ src: null }),
}))

import { SourceCropCanvas, type SourceCropDrag } from '../SourceCropCanvas'

const RECT = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }

function mount(onDrag: (drag: SourceCropDrag) => void, handles?: readonly ('nw' | 'se')[]) {
  render(<SourceCropCanvas deviceId={1} rect={RECT} handles={handles} onDrag={onDrag} />)
  const canvas = screen.getByTestId('source-crop-canvas')
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
    }) as DOMRect
  canvas.setPointerCapture = () => undefined
  return canvas
}

describe('SourceCropCanvas', () => {
  it('draws only the requested grips', () => {
    mount(() => undefined, ['nw', 'se'])
    expect(screen.getByTestId('source-crop-handle-nw')).toBeTruthy()
    expect(screen.queryByTestId('source-crop-handle-n')).toBeNull()
  })

  it('reports a move as origin, normalized delta and pointer position', () => {
    const onDrag = vi.fn()
    const canvas = mount(onDrag)
    const rect = screen.getByTestId('source-crop-rect')
    rect.setPointerCapture = () => undefined
    fireEvent.pointerDown(rect, { clientX: 40, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 30, pointerId: 1 })
    expect(onDrag).toHaveBeenCalledTimes(1)
    const drag = onDrag.mock.calls[0]?.[0] as SourceCropDrag
    expect(drag.mode).toBe('move')
    expect(drag.origin).toEqual(RECT)
    expect(drag.dx).toBeCloseTo(0.1)
    expect(drag.dy).toBeCloseTo(0.1)
    expect(drag.point.x).toBeCloseTo(0.3)
  })
})
