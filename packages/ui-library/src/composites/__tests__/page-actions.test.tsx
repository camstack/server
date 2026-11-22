// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PageActions, type PageAction } from '../page-actions'

/** jsdom has no matchMedia; drive `useIsPhone` from this switch. */
function setViewport(phone: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: phone && query.includes('max-width: 639px'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

interface Harness {
  readonly actions: readonly PageAction[]
  readonly openLogs: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const openLogs = vi.fn()
  const remove = vi.fn(async () => undefined)
  return {
    openLogs,
    remove,
    actions: [
      { id: 'logs', label: 'Logs', onClick: openLogs },
      { id: 'gated', label: 'Gated', hidden: true, onClick: () => {} },
      {
        id: 'delete',
        label: 'Delete',
        danger: true,
        confirm: { title: 'Delete integration?', confirmLabel: 'Delete it', action: remove },
      },
    ],
  }
}

beforeEach(() => {
  setViewport(false)
  // jsdom does not implement <dialog>.showModal()/close().
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

describe('PageActions', () => {
  it('draws one labelled button per action from `sm` up, and no menu', () => {
    const h = harness()
    render(<PageActions actions={h.actions} moreLabel="More" />)
    expect(screen.getByRole('button', { name: 'Logs' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(screen.queryByText('More')).toBeNull()
    expect(screen.queryByText('Gated')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expect(h.openLogs).toHaveBeenCalledTimes(1)
  })

  it('folds every action into ONE labelled menu on a phone', () => {
    setViewport(true)
    const h = harness()
    render(<PageActions actions={h.actions} moreLabel="More" />)
    // Only the trigger is on the page, and it carries its label.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button').textContent).toContain('More')
    expect(screen.queryByText('Logs')).toBeNull()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('Gated')).toBeNull()
    fireEvent.click(screen.getByText('Logs'))
    expect(h.openLogs).toHaveBeenCalledTimes(1)
  })

  it('asks before a confirmed action on a phone, then runs it', async () => {
    setViewport(true)
    const h = harness()
    render(<PageActions actions={h.actions} moreLabel="More" />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Delete'))
    expect(h.remove).not.toHaveBeenCalled()
    expect(screen.getByText('Delete integration?')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }))
    await waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1))
  })

  it('asks before a confirmed action on a wide viewport too', async () => {
    const h = harness()
    render(<PageActions actions={h.actions} moreLabel="More" />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(h.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }))
    await waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1))
  })

  it('renders nothing when every action is hidden', () => {
    const { container } = render(
      <PageActions
        actions={[{ id: 'a', label: 'A', hidden: true, onClick: () => {} }]}
        moreLabel="More"
      />,
    )
    expect(container.innerHTML).toBe('')
  })
})
