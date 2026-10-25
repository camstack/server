// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceBatchToolbar } from '../batch-toolbar.js'

describe('DeviceBatchToolbar', () => {
  it('renders nothing when no devices are selected', () => {
    const { container } = render(
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
    render(
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
    render(
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
    render(
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
    render(
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
  it('requires two clicks to delete (inline confirm)', () => {
    const remove = vi.fn()
    const onClear = vi.fn()
    render(
      <DeviceBatchToolbar
        selectedIds={new Set([5])}
        onClear={onClear}
        remove={remove}
        disable={vi.fn()}
        enable={vi.fn()}
      />,
    )
    // First click — should show confirm label, not execute yet
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(remove).not.toHaveBeenCalled()
    // Second click on confirm button
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
    expect(remove).toHaveBeenCalledWith({ deviceId: 5 })
    expect(onClear).toHaveBeenCalled()
  })
})
