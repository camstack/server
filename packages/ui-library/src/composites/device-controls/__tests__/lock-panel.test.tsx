import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LockPanel } from '../lock-panel'
import { DeviceFeature } from '@camstack/types'

const lock = vi.fn(() => Promise.resolve(undefined))
const unlock = vi.fn(() => Promise.resolve(undefined))
const open = vi.fn(() => Promise.resolve(undefined))
let mockResult: { cap: unknown; slice: unknown; available: boolean }
vi.mock('../../../hooks/use-device-capability', () => ({ useDeviceCapability: () => mockResult }))
const trpc = {} as never

beforeEach(() => {
  lock.mockReset()
  unlock.mockReset()
  open.mockReset()
  mockResult = {
    cap: { lock, unlock, open },
    slice: { state: 'locked', lastChangedAt: 0 },
    available: true,
  }
  // jsdom does not implement <dialog>.showModal()/close(); stub them so the
  // Dialog primitive's open/close effect runs without throwing.
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

describe('LockPanel', () => {
  it('shows Unlock when locked and calls unlock', () => {
    render(<LockPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    fireEvent.click(screen.getByLabelText('Unlock'))
    expect(unlock).toHaveBeenCalledWith({})
  })
  it('shows Lock when unlocked and calls lock', () => {
    mockResult = {
      cap: { lock, unlock, open },
      slice: { state: 'unlocked', lastChangedAt: 0 },
      available: true,
    }
    render(<LockPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    fireEvent.click(screen.getByLabelText('Lock'))
    expect(lock).toHaveBeenCalledWith({})
  })
  it('renders nothing when unbound', () => {
    mockResult = { cap: { lock, unlock, open }, slice: undefined, available: false }
    const { container } = render(
      <LockPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />,
    )
    expect(container.firstChild).toBeNull()
  })
  it('does NOT show Open door button when LockOpen feature is absent', () => {
    render(<LockPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    expect(screen.queryByLabelText('Open door')).toBeNull()
  })
  it('does NOT show Open door button when features array is empty', () => {
    render(<LockPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.queryByLabelText('Open door')).toBeNull()
  })
  it('shows Open door button when LockOpen feature is present (full layout)', () => {
    render(<LockPanel trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} layout="full" />)
    expect(screen.getByLabelText('Open door')).toBeDefined()
  })
  it('shows Open door button when LockOpen feature is present (compact layout)', () => {
    render(
      <LockPanel trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} layout="compact" />,
    )
    expect(screen.getByLabelText('Open door')).toBeDefined()
  })
  it('calls cap.open when Open door button is clicked', () => {
    render(<LockPanel trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} layout="full" />)
    fireEvent.click(screen.getByLabelText('Open door'))
    expect(open).toHaveBeenCalledWith({})
  })
  it('does not show Open door button when feature is present but unrelated features only', () => {
    render(
      <LockPanel
        trpc={trpc}
        deviceId={1}
        features={[DeviceFeature.LockPinRequired]}
        layout="full"
      />,
    )
    expect(screen.queryByLabelText('Open door')).toBeNull()
  })

  describe('compact (table inline) confirm gating', () => {
    it('does NOT call unlock on click — it opens a confirm modal instead', () => {
      const { container } = render(
        <LockPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />,
      )
      fireEvent.click(screen.getByLabelText('Unlock'))
      expect(unlock).not.toHaveBeenCalled()
      expect(screen.getByText('Unlock device?')).toBeTruthy()
      expect(container.ownerDocument.querySelector('dialog')?.open).toBe(true)
    })

    it('calls unlock once only after the operator confirms', () => {
      render(<LockPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />)
      fireEvent.click(screen.getByLabelText('Unlock'))
      fireEvent.click(screen.getByRole('button', { name: 'Confirm unlock' }))
      expect(unlock).toHaveBeenCalledTimes(1)
      expect(unlock).toHaveBeenCalledWith({})
    })

    it('does NOT unlock when the operator cancels', () => {
      render(<LockPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />)
      fireEvent.click(screen.getByLabelText('Unlock'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(unlock).not.toHaveBeenCalled()
    })

    it('does NOT call open on click — it opens a confirm modal instead', () => {
      const { container } = render(
        <LockPanel trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} layout="compact" />,
      )
      fireEvent.click(screen.getByLabelText('Open door'))
      expect(open).not.toHaveBeenCalled()
      expect(screen.getByText('Open door?')).toBeTruthy()
      expect(container.ownerDocument.querySelector('dialog')?.open).toBe(true)
    })

    it('calls open once only after the operator confirms', () => {
      render(
        <LockPanel trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} layout="compact" />,
      )
      fireEvent.click(screen.getByLabelText('Open door'))
      fireEvent.click(screen.getByRole('button', { name: 'Confirm open' }))
      expect(open).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith({})
    })

    it('does NOT open the door when the operator cancels', () => {
      render(
        <LockPanel trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} layout="compact" />,
      )
      fireEvent.click(screen.getByLabelText('Open door'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(open).not.toHaveBeenCalled()
    })

    it('locks (secure) immediately with no confirm modal', () => {
      mockResult = {
        cap: { lock, unlock, open },
        slice: { state: 'unlocked', lastChangedAt: 0 },
        available: true,
      }
      const { container } = render(
        <LockPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />,
      )
      fireEvent.click(screen.getByLabelText('Lock'))
      expect(lock).toHaveBeenCalledWith({})
      // No confirm modal was opened (the <dialog> stays closed).
      const dialog = container.ownerDocument.querySelector('dialog')
      expect(dialog?.open ?? false).toBe(false)
    })

    it('stops propagation so clicking unlock does not trigger the row', () => {
      const rowClick = vi.fn()
      render(
        <div onClick={rowClick}>
          <LockPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />
        </div>,
      )
      fireEvent.click(screen.getByLabelText('Unlock'))
      expect(rowClick).not.toHaveBeenCalled()
    })
  })
})

describe('LockPanel door-open', () => {
  it('disables the Lock toggle with the reason and never calls lock', () => {
    mockResult = {
      cap: { lock, unlock, open },
      slice: { state: 'door-open', lastChangedAt: 0 },
      available: true,
    }
    render(<LockPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    const btn = screen.getByLabelText('Lock')
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(btn.getAttribute('title')).toBe('Close the door first')
    fireEvent.click(btn)
    expect(lock).not.toHaveBeenCalled()
  })
})
