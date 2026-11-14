// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { BottomSheet, DISMISS_DRAG_PX } from '../bottom-sheet'

describe('BottomSheet', () => {
  it('mounts no fixed layer while closed', () => {
    const { container } = render(
      <BottomSheet open={false} onClose={vi.fn()}>
        <span>x</span>
      </BottomSheet>,
    )
    expect(container.querySelector('.fixed')).toBeNull()
  })

  it('closes from its backdrop while open', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BottomSheet open onClose={onClose}>
        <span>x</span>
      </BottomSheet>,
    )
    container.querySelector<HTMLElement>('.inset-0')?.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('BottomSheet dismissal', () => {
  const drag = (handle: HTMLElement, from: number, to: number): void => {
    fireEvent.pointerDown(handle, { clientY: from, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: to, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientY: to, pointerId: 1 })
  }

  it('closes when the handle is dragged down past the threshold', () => {
    const onClose = vi.fn()
    const { getByTestId } = render(
      <BottomSheet open onClose={onClose}>
        <span>x</span>
      </BottomSheet>,
    )
    drag(getByTestId('bottom-sheet-handle'), 100, 100 + DISMISS_DRAG_PX + 10)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open on a short drag', () => {
    const onClose = vi.fn()
    const { getByTestId } = render(
      <BottomSheet open onClose={onClose}>
        <span>x</span>
      </BottomSheet>,
    )
    drag(getByTestId('bottom-sheet-handle'), 100, 120)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <BottomSheet open onClose={onClose}>
        <span>x</span>
      </BottomSheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
