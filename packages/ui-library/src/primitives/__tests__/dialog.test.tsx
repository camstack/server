// @vitest-environment jsdom
//
// Dialog primitive — deterministic centering + open/close behaviour.
//
// The native <dialog> opened via showModal() is promoted to the top layer,
// but Tailwind's preflight resets `margin: 0` on every element, which defeats
// the UA stylesheet's `dialog { margin: auto }` modal centering and pins the
// modal to the top-left (and `w-full` makes it overflow/clip). To be robust
// against any reset, DialogContent centers itself explicitly with
// `fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 m-0` and caps its
// width to the viewport instead of using a bare `w-full`.
//
// jsdom cannot verify visual centering, so we assert class presence plus the
// existing showModal/open/close behaviour.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../dialog'

// jsdom does not implement <dialog>.showModal()/close(); stub them so the
// Dialog primitive's open/close effect runs without throwing.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
})

function getDialog(): HTMLDialogElement {
  const el = document.querySelector('dialog')
  if (!el) throw new Error('dialog element not found')
  return el
}

describe('DialogContent centering', () => {
  it('renders deterministic fixed centering classes', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm reboot</DialogTitle>
          <DialogDescription>This will restart the device.</DialogDescription>
        </DialogContent>
      </Dialog>,
    )

    const dialog = getDialog()
    const cls = dialog.className
    expect(cls).toContain('fixed')
    expect(cls).toContain('left-1/2')
    expect(cls).toContain('top-1/2')
    expect(cls).toContain('-translate-x-1/2')
    expect(cls).toContain('-translate-y-1/2')
  })

  it('resets inherited margin so a preflight `margin:0` does not pin it top-left', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(getDialog().className).toContain('m-0')
  })

  it('caps width to the viewport instead of a bare full-width that clips', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const cls = getDialog().className
    // viewport-capped width + scrollable tall content
    expect(cls).toContain('w-[calc(100vw-2rem)]')
    expect(cls).toContain('overflow-y-auto')
    // a bare 100% width would overflow/clip a centered dialog
    expect(cls.split(/\s+/)).not.toContain('w-full')
  })

  it('caps height against the SAFE viewport so a tall dialog clears the notch', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const cls = getDialog().className
    // A `fixed` top-layer dialog is viewport-relative, and under
    // `viewport-fit=cover` the viewport extends behind the iOS notch and home
    // indicator. A bare `100dvh - 2rem` cap therefore put a maxed-out
    // dialog's header under the status-bar clock.
    expect(cls).toContain(
      'max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))]',
    )
    // The old, notch-blind cap must not come back.
    expect(cls.split(/\s+/)).not.toContain('max-h-[calc(100dvh-2rem)]')
  })

  it('keeps the blurred backdrop', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const cls = getDialog().className
    expect(cls).toContain('backdrop:bg-black/50')
    expect(cls).toContain('backdrop:backdrop-blur-sm')
  })

  it('applies the requested width variant', () => {
    render(
      <Dialog open>
        <DialogContent width="sm">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(getDialog().className).toContain('max-w-sm')
  })
})

describe('DialogContent open/close behaviour', () => {
  it('opens via showModal when open is true', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(getDialog().open).toBe(true)
  })

  it('does not open when closed', () => {
    render(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(getDialog().open).toBe(false)
  })

  it('does not close when the backdrop (the dialog element itself) is clicked', () => {
    let openState = true
    function Harness() {
      return (
        <Dialog open={openState} onOpenChange={(next) => (openState = next)}>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
          </DialogContent>
        </Dialog>
      )
    }
    render(<Harness />)

    const dialog = getDialog()
    fireEvent.click(dialog) // target === currentTarget — outside click must be a no-op
    expect(openState).toBe(true)
  })

  it('renders content (title + description) when open', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm reboot</DialogTitle>
          <DialogDescription>It may be unavailable for a moment.</DialogDescription>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByText('Confirm reboot')).toBeDefined()
    expect(screen.getByText('It may be unavailable for a moment.')).toBeDefined()
  })
})
