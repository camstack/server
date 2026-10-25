import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeviceQuickDetailProvider } from '../../../contexts/device-quick-detail'
import { DeviceQuickDetailAction } from '../quick-detail-action'

describe('DeviceQuickDetailAction', () => {
  it('draws nothing without a provider (tests / embeds)', () => {
    const { container } = render(<DeviceQuickDetailAction deviceId={42} />)
    expect(container.firstChild).toBeNull()
  })

  it('opens the host callback when the provider is mounted', () => {
    const open = vi.fn()
    render(
      <DeviceQuickDetailProvider open={open}>
        <DeviceQuickDetailAction deviceId={42} />
      </DeviceQuickDetailProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Quick detail' }))
    expect(open).toHaveBeenCalledWith(42)
  })
})
