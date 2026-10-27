// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ConfirmDialogProvider } from '../../confirm-dialog.js'
import { DeviceBatchToolbar } from '../batch-toolbar.js'

function renderBar(ui: ReactNode) {
  return render(<ConfirmDialogProvider>{ui}</ConfirmDialogProvider>)
}

describe('DeviceBatchToolbar', () => {
  it('renders nothing when no devices are selected', () => {
    const { container } = renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set()}
        onClear={vi.fn()}
        remove={vi.fn()}
        disable={vi.fn()}
        enable={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
  it('disables every selected device then clears the selection', () => {
    const disable = vi.fn()
    const onClear = vi.fn()
    renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set([1, 2])}
        onClear={onClear}
        remove={vi.fn()}
        disable={disable}
        enable={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /disable/i }))
    expect(disable).toHaveBeenCalledTimes(2)
    expect(disable).toHaveBeenCalledWith({ deviceId: 1 })
    expect(disable).toHaveBeenCalledWith({ deviceId: 2 })
    expect(onClear).toHaveBeenCalled()
  })
  it('enables every selected device', () => {
    const enable = vi.fn()
    renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set([3])}
        onClear={vi.fn()}
        remove={vi.fn()}
        disable={vi.fn()}
        enable={enable}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /enable/i }))
    expect(enable).toHaveBeenCalledWith({ deviceId: 3 })
  })
  it('shows count of selected devices', () => {
    renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set([1, 2, 3])}
        onClear={vi.fn()}
        remove={vi.fn()}
        disable={vi.fn()}
        enable={vi.fn()}
      />,
    )
    expect(screen.getByText(/3 selected/i)).toBeDefined()
  })
  it('clears selection when Clear is clicked', () => {
    const onClear = vi.fn()
    renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set([1])}
        onClear={onClear}
        remove={vi.fn()}
        disable={vi.fn()}
        enable={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(onClear).toHaveBeenCalled()
  })
  it('asks in a modal before deleting, naming the count', async () => {
    const remove = vi.fn()
    const onClear = vi.fn()
    renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set([5, 6])}
        onClear={onClear}
        remove={remove}
        disable={vi.fn()}
        enable={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(remove).not.toHaveBeenCalled()
    const modal = await screen.findByRole('dialog')
    expect(within(modal).getByText(/2 selected devices will be deleted/)).toBeDefined()
    fireEvent.click(within(modal).getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
    expect(remove).toHaveBeenCalledWith({ deviceId: 5 })
    expect(remove).toHaveBeenCalledWith({ deviceId: 6 })
    expect(onClear).toHaveBeenCalled()
  })
  it('cancelling the delete modal removes nothing and keeps the selection', async () => {
    const remove = vi.fn()
    const onClear = vi.fn()
    renderBar(
      <DeviceBatchToolbar
        selectedIds={new Set([5])}
        onClear={onClear}
        remove={remove}
        disable={vi.fn()}
        enable={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    const modal = await screen.findByRole('dialog')
    fireEvent.click(within(modal).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remove).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
  })
})
