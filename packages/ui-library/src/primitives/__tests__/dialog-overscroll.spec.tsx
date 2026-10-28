// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Dialog, DialogBody, DialogContent } from '../dialog'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('Dialog scrollers contain their overscroll', () => {
  it('keeps a scroll gesture from chaining to the page behind, in both scroll modes', () => {
    const { container } = render(
      <Dialog open>
        <DialogContent>x</DialogContent>
        <DialogContent scroll="body">
          <DialogBody>y</DialogBody>
        </DialogContent>
      </Dialog>,
    )
    const dialogs = Array.from(container.querySelectorAll('dialog'))
    expect(dialogs).toHaveLength(2)
    for (const d of dialogs) expect(d.className).toContain('overscroll-contain')
    expect(container.querySelector('dialog > div')?.className).toContain('overscroll-contain')
  })
})
