// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from '../dialog'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('nested dialogs', () => {
  it('closing the inner dialog does not dismiss the dialog it was opened from', () => {
    const outerChange = vi.fn()
    const innerChange = vi.fn()
    render(
      <Dialog open onOpenChange={outerChange}>
        <DialogContent data-testid="outer">
          <DialogTitle>Outer</DialogTitle>
          <Dialog open onOpenChange={innerChange}>
            <DialogContent data-testid="inner">
              <DialogTitle>Inner</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    )
    // The native `close` event of the inner <dialog> reaches React's onClose of
    // every ancestor dialog through the React tree.
    fireEvent(screen.getByTestId('inner'), new Event('close'))
    expect(innerChange).toHaveBeenCalledWith(false)
    expect(outerChange).not.toHaveBeenCalled()
  })

  it('still closes a dialog whose own close event fires', () => {
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent data-testid="only">
          <DialogTitle>Only</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    fireEvent(screen.getByTestId('only'), new Event('close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
