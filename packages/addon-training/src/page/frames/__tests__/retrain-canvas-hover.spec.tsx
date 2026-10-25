// @vitest-environment jsdom
/**
 * The canvas half of hover sync, and what a box shows: a mouse over a box
 * reports it (smallest first), leaving the canvas clears it; the hovered box
 * thickens and the others dim; the stroke is the review diff; a removed
 * proposal is a ghost, switchable; every box is a labelled, focusable button.
 */
import type { RetrainAnnotation, RetrainOrigin } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { type ComponentProps, useState, type JSX } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { seedEditor } from '../lib/retrain-editor'
import type { Hover } from '../lib/retrain-hover'
import { liveReview } from '../lib/retrain-live-review'
import { FULL_VIEWPORT } from '../lib/retrain-zoom'
import { RetrainCanvas } from '../RetrainCanvas'

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

const big = { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }
const small = { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }
const pipelineOrigin = (ref: string, bbox: typeof big): RetrainOrigin => ({
  source: 'pipeline',
  ref,
  bbox,
  macroClass: 'person',
})

function row(id: string, bbox: typeof big, origin: RetrainOrigin): RetrainAnnotation {
  return {
    id,
    deviceId: 1,
    mediaKey: 'f',
    bbox,
    macroClass: 'person',
    kind: 'subject',
    source: 'pipeline',
    origin,
    createdAt: 1,
  }
}

// b0 big = unchanged; b1 small = adjusted (its proposal sat elsewhere); one removed ghost.
const editor = seedEditor(
  [
    row('a', big, pipelineOrigin('pipeline:t1', big)),
    row('b', small, pipelineOrigin('pipeline:t2', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })),
  ],
  [],
  [
    {
      ref: 'pipeline:t3',
      snapshot: pipelineOrigin('pipeline:t3', { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }),
    },
  ],
)
const review = liveReview(editor, [])

function canvas(over: Partial<ComponentProps<typeof RetrainCanvas>> = {}): JSX.Element {
  return (
    <RetrainCanvas
      imageSrc="data:image/jpeg;base64,"
      imageWidth={400}
      imageHeight={400}
      boxes={editor.boxes}
      selectedKey={null}
      review={review}
      viewport={FULL_VIEWPORT}
      onViewportChange={() => undefined}
      panMode={false}
      onSelect={() => undefined}
      onDraw={() => undefined}
      onGestureStart={() => undefined}
      onGestureBox={() => undefined}
      onGestureEnd={() => undefined}
      {...over}
    />
  )
}

const move = (x: number, y: number): void => {
  fireEvent.pointerMove(screen.getByTestId('retrain-canvas'), {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
  })
}

describe('hovering on the canvas', () => {
  it('reports the SMALLEST box under the mouse, and nothing on empty frame', () => {
    const onHover = vi.fn()
    function Stateful(): JSX.Element {
      const [hover, setHover] = useState<Hover | null>(null)
      return canvas({
        hover,
        onHover: (next) => {
          onHover(next)
          setHover(next)
        },
      })
    }
    render(<Stateful />)
    move(140, 140) // inside both: (0.35, 0.35)
    expect(onHover).toHaveBeenLastCalledWith({ key: 'b1', source: 'canvas' })
    move(50, 50) // (0.125, 0.125): only the big box
    expect(onHover).toHaveBeenLastCalledWith({ key: 'b0', source: 'canvas' })
    move(390, 10)
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  it('does not repeat a hover it already reported', () => {
    const onHover = vi.fn()
    render(canvas({ onHover, hover: { key: 'b1', source: 'canvas' } }))
    move(140, 140)
    expect(onHover).not.toHaveBeenCalled()
  })

  it('leaving the canvas clears a hover it raised, but not the list’s', () => {
    const onHover = vi.fn()
    const { rerender } = render(canvas({ onHover, hover: { key: 'b1', source: 'canvas' } }))
    fireEvent.pointerLeave(screen.getByTestId('retrain-canvas'))
    expect(onHover).toHaveBeenCalledWith(null)
    onHover.mockClear()
    rerender(canvas({ onHover, hover: { key: 'b1', source: 'list' } }))
    fireEvent.pointerLeave(screen.getByTestId('retrain-canvas'))
    expect(onHover).not.toHaveBeenCalled()
  })

  it('thickens the hovered box, dims the others, and shows where a changed one was', () => {
    render(canvas({ hover: { key: 'b1', source: 'list' } }))
    expect(screen.getByTestId('retrain-box-b1')).toHaveAttribute('data-emphasis', 'hovered')
    expect(screen.getByTestId('retrain-box-b0')).toHaveAttribute('data-emphasis', 'dimmed')
    expect(screen.getByTestId('retrain-origin-b1')).toBeTruthy()
    expect(screen.queryByTestId('retrain-origin-b0')).toBeNull()
  })

  it('nothing hovered: nothing dimmed, no origin ghost', () => {
    render(canvas())
    expect(screen.getByTestId('retrain-box-b0')).toHaveAttribute('data-emphasis', 'normal')
    expect(screen.queryByTestId('retrain-origin-b1')).toBeNull()
  })
})

describe('what a box shows', () => {
  it('carries its review diff, and a colour that agrees with it', () => {
    render(canvas())
    expect(screen.getByTestId('retrain-box-b0')).toHaveAttribute('data-kind', 'unchanged')
    expect(screen.getByTestId('retrain-box-b1')).toHaveAttribute('data-kind', 'adjusted')
    expect(screen.getByTestId('retrain-box-b1').style.border).toContain('--color-info')
  })

  it('draws a removed proposal as a ghost, and the switch hides it', () => {
    const { rerender } = render(canvas())
    expect(screen.getByTestId('retrain-ghost-pipeline:t3')).toBeTruthy()
    rerender(canvas({ showRemoved: false }))
    expect(screen.queryByTestId('retrain-ghost-pipeline:t3')).toBeNull()
  })

  it('every box is a labelled, focusable button that selects on focus', () => {
    const onSelect = vi.fn()
    render(canvas({ onSelect }))
    const box = screen.getByRole('button', { name: /person, adjusted, pipeline/ })
    expect(box).toHaveAttribute('tabindex', '0')
    fireEvent.focus(box)
    expect(onSelect).toHaveBeenCalledWith('b1')
  })

  it('names its source with an icon, not a colour', () => {
    render(canvas())
    expect(screen.getAllByTestId('retrain-source-pipeline').length).toBeGreaterThan(0)
  })
})
