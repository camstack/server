// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WaterHeaterInlineControl } from '../water-heater-control'

const setTargetTemp = vi.fn()
const setOperationMode = vi.fn()
const setAway = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

vi.mock('../../../hooks/use-optimistic-slice', () => ({
  useOptimisticSlice: (slice: unknown) => ({
    display: slice,
    applyOptimistic: vi.fn(),
    applyOptimisticAction: (_patch: unknown, run: () => unknown) => void run(),
  }),
}))

const trpc = {} as never

const fullSlice = {
  currentTemp: 48,
  targetTemp: 60,
  operationMode: 'eco',
  availableModes: ['eco', 'electric', 'gas', 'heat_pump'],
  away: false,
  minTemp: 30,
  maxTemp: 80,
  lastChangedAt: 0,
}

beforeEach(() => {
  setTargetTemp.mockReset()
  setOperationMode.mockReset()
  setAway.mockReset()
  mockResult = {
    cap: { setTargetTemp, setOperationMode, setAway },
    slice: fullSlice,
    available: true,
  }
})

describe('WaterHeaterInlineControl', () => {
  it('renders the current→target readout + mode hint', () => {
    render(<WaterHeaterInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText(/60°/)).toBeTruthy()
    expect(screen.getByText(/eco/)).toBeTruthy()
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <WaterHeaterInlineControl trpc={trpc} deviceId={1} features={[]} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
