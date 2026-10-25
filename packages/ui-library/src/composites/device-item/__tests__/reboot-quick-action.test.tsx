// @vitest-environment jsdom
//
// RebootQuickAction — a dedicated row-level reboot button (PtzQuickAction
// style) that opens a confirm modal before invoking the reboot cap.
//
// Asserts the new behaviour the kebab MoreActionsMenu did NOT provide:
//   - rebootable device (reboot cap bound) → a single reboot ACTION button
//     in the row (not nested in a kebab menu)
//   - clicking the button is NOT a one-click reboot — it opens a confirm
//     modal; the cap is only called after the operator confirms
//   - confirming calls `cap.reboot({})`; cancelling does not
//   - a non-rebootable device (cap undefined) renders nothing
//   - the button stops propagation so the surrounding row does not navigate
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RebootQuickAction } from '../reboot-quick-action'

const reboot = vi.fn(() => Promise.resolve(undefined))

let mockResult: { dev: unknown; cap: unknown }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

// jsdom does not implement <dialog>.showModal()/close(); stub them so the
// Dialog primitive's open/close effect runs without throwing.
beforeEach(() => {
  reboot.mockClear()
  mockResult = { dev: {}, cap: { reboot } }
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

const trpc = {} as never

describe('RebootQuickAction', () => {
  it('renders a single reboot action button when the reboot cap is bound', () => {
    render(<RebootQuickAction trpc={trpc} deviceId={1} deviceName="Front Door" />)
    const btn = screen.getByLabelText('Reboot device')
    expect(btn).toBeTruthy()
    // It is a button, not a kebab "More actions" menu trigger.
    expect(screen.queryByLabelText('More actions')).toBeNull()
  })

  it('renders nothing when the reboot cap is undefined (non-rebootable device)', () => {
    mockResult = { dev: {}, cap: undefined }
    const { container } = render(
      <RebootQuickAction trpc={trpc} deviceId={1} deviceName="Front Door" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('does NOT reboot on click — it opens a confirm modal instead', () => {
    render(<RebootQuickAction trpc={trpc} deviceId={1} deviceName="Front Door" />)
    fireEvent.click(screen.getByLabelText('Reboot device'))
    // Cap was NOT called — only a confirmation prompt appeared.
    expect(reboot).not.toHaveBeenCalled()
    expect(screen.getByText('Reboot device?')).toBeTruthy()
    // Confirm modal mentions the device name.
    expect(screen.getByText(/Front Door/)).toBeTruthy()
  })

  it('calls the reboot cap only after the operator confirms', async () => {
    render(<RebootQuickAction trpc={trpc} deviceId={1} deviceName="Front Door" />)
    fireEvent.click(screen.getByLabelText('Reboot device'))
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }))
    expect(reboot).toHaveBeenCalledTimes(1)
    expect(reboot).toHaveBeenCalledWith({})
  })

  it('does NOT call reboot when the operator cancels', () => {
    render(<RebootQuickAction trpc={trpc} deviceId={1} deviceName="Front Door" />)
    fireEvent.click(screen.getByLabelText('Reboot device'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(reboot).not.toHaveBeenCalled()
  })

  it('stops propagation so clicking the button does not trigger the row', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <RebootQuickAction trpc={trpc} deviceId={1} deviceName="Front Door" />
      </div>,
    )
    fireEvent.click(screen.getByLabelText('Reboot device'))
    expect(rowClick).not.toHaveBeenCalled()
  })
})
