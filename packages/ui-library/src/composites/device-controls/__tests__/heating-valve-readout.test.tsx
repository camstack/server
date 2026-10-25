// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeatingValveReadout, formatHeatingValvePosition } from '../heating-valve-readout'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

beforeEach(() => {
  mockResult = {
    cap: { getStatus: vi.fn() },
    slice: { position: 42, lastFetchedAt: 0 },
    available: true,
  }
})

describe('formatHeatingValvePosition', () => {
  it('renders percentage for numeric position', () => {
    expect(formatHeatingValvePosition(42)).toBe('42%')
  })

  it('renders em dash for null, not 0%', () => {
    expect(formatHeatingValvePosition(null)).toBe('—')
  })
})

describe('HeatingValveReadout', () => {
  it('shows 42% in compact layout', () => {
    render(<HeatingValveReadout trpc={trpc} deviceId={1} layout="compact" />)
    expect(screen.getByLabelText('Valve 42%')).toBeTruthy()
  })

  it('shows dash when position is null', () => {
    mockResult = {
      cap: { getStatus: vi.fn() },
      slice: { position: null, lastFetchedAt: 0 },
      available: true,
    }
    render(<HeatingValveReadout trpc={trpc} deviceId={1} layout="compact" />)
    expect(screen.getByLabelText('Valve —')).toBeTruthy()
    expect(screen.queryByText('0%')).toBeNull()
  })
})
