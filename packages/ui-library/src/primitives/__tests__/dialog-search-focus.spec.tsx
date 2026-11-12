// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dialog, DialogContent } from '../dialog'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

function openSearchDialog(): void {
  render(
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent>
        <input type="search" aria-label="Search integrations" />
      </DialogContent>
    </Dialog>,
  )
}

describe('DialogContent search focus', () => {
  it('focuses the search field when the dialog opens', () => {
    openSearchDialog()
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })

  it('does not open the software keyboard on a coarse pointer', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: none) and (pointer: coarse)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }))
    openSearchDialog()
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox'))
    vi.unstubAllGlobals()
  })
})
