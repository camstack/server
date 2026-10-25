import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SwitchPanel } from '../switch-panel'
const setState = vi.fn()
let mockResult: { cap: unknown; slice: unknown; available: boolean }
vi.mock('../../../hooks/use-device-capability', () => ({ useDeviceCapability: () => mockResult }))
const trpc = {} as never
beforeEach(() => {
  setState.mockReset()
  mockResult = { cap: { setState }, slice: { on: false, lastChangedAt: 0 }, available: true }
})
describe('SwitchPanel', () => {
  it('toggles on', () => {
    render(<SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    fireEvent.click(screen.getByRole('button'))
    expect(setState).toHaveBeenCalledWith({ on: true })
  })
  it('renders nothing when unbound', () => {
    mockResult = { cap: { setState }, slice: undefined, available: false }
    const { container } = render(
      <SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />,
    )
    expect(container.firstChild).toBeNull()
  })
})
