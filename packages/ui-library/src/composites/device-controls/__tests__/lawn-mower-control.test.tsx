// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  LawnMowerInlineControl,
  LawnMowerHeroCard,
  lawnMowerActivityMeta,
} from '../lawn-mower-control'

const startMowing = vi.fn()
const pause = vi.fn()
const dock = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

beforeEach(() => {
  startMowing.mockReset()
  pause.mockReset()
  dock.mockReset()
  mockResult = {
    cap: { startMowing, pause, dock },
    slice: {
      activity: 'mowing',
      batteryLevel: 64,
      progressPercent: null,
      currentCode: null,
      currentCodeLabel: null,
      severity: 'info',
      lastChangedAt: 0,
    },
    available: true,
  }
})

describe('lawnMowerActivityMeta', () => {
  it('maps activities to labels', () => {
    expect(lawnMowerActivityMeta('mowing').label).toBe('Mowing')
    expect(lawnMowerActivityMeta('docked').label).toBe('Docked')
    expect(lawnMowerActivityMeta(undefined).label).toBe('Unknown')
  })
})

describe('LawnMowerInlineControl', () => {
  it('renders mow/pause/dock buttons + battery', () => {
    render(<LawnMowerInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Mow')).toBeTruthy()
    expect(screen.getByLabelText('Pause')).toBeTruthy()
    expect(screen.getByLabelText('Dock')).toBeTruthy()
    expect(screen.getByText('64%')).toBeTruthy()
  })

  it('wires buttons to cap methods', () => {
    render(<LawnMowerInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Mow'))
    fireEvent.click(screen.getByLabelText('Pause'))
    fireEvent.click(screen.getByLabelText('Dock'))
    expect(startMowing).toHaveBeenCalledWith({})
    expect(pause).toHaveBeenCalledWith({})
    expect(dock).toHaveBeenCalledWith({})
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<LawnMowerInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('disables buttons when not available', () => {
    mockResult = { ...mockResult, available: false }
    render(<LawnMowerInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect((screen.getByLabelText('Mow') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('LawnMowerHeroCard', () => {
  it('renders activity label + actions', () => {
    render(<LawnMowerHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Mowing')).toBeTruthy()
    expect(screen.getByLabelText('Start mowing')).toBeTruthy()
    expect(screen.getByLabelText('Dock')).toBeTruthy()
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<LawnMowerHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
