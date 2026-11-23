// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDestructiveAction } from '../use-destructive-action'

function Host({ action }: { readonly action: () => Promise<unknown> }) {
  const del = useDestructiveAction({
    title: 'Delete?',
    description: 'd',
    confirmLabel: 'Remove',
    action,
  })
  return (
    <>
      <button type="button" onClick={del.request}>
        go
      </button>
      {del.dialog}
    </>
  )
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('useDestructiveAction', () => {
  it('keeps the dialog open while pending, shows the error on failure', async () => {
    let fail!: (e: Error) => void
    render(
      <Host
        action={() =>
          new Promise((_, rej) => {
            fail = rej
          })
        }
      />,
    )
    fireEvent.click(screen.getByText('go'))
    fireEvent.click(await screen.findByText('Remove'))
    expect(screen.getByText('Remove').closest('button')?.disabled).toBe(true)
    fail(new Error('denied'))
    await waitFor(() => expect(screen.getByText('denied')).toBeTruthy())
    expect(screen.getByText('Remove').closest('button')?.disabled).toBe(false)
  })
})
