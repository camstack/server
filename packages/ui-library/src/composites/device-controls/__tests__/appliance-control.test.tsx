// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { PowerMeterStatus, RunningStateStatus } from '@camstack/types'
import { ApplianceHeroCard, ApplianceInlineControl, formatWatts } from '../appliance-control'

let running: RunningStateStatus | undefined
let power: PowerMeterStatus | undefined

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceState: (_t: unknown, _id: number, select: (s: Record<string, unknown>) => unknown) => {
    const probe = { runningState: 'running', powerMeter: 'power' }
    const picked = select(probe)
    return picked === 'running' ? running : power
  },
}))

const props = { trpc: {} as never, deviceId: 1, features: undefined }

function runningSlice(overrides: Partial<RunningStateStatus>): RunningStateStatus {
  return {
    running: true,
    since: Date.now() - 35 * 60_000,
    source: 'native',
    phase: 'Rinse',
    lastFetchedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  running = undefined
  power = undefined
})

describe('ApplianceHeroCard', () => {
  it('tumbles the drum only while running, and shows state, phase and watts', () => {
    running = runningSlice({})
    power = { power: 412, lastFetchedAt: 1 }
    render(<ApplianceHeroCard {...props} />)
    expect(screen.getByTestId('appliance-state').textContent).toBe('Running')
    expect(screen.getByTestId('appliance-drum-ring').className).toContain('apl-drum-run')
    expect(screen.getByText('Rinse')).toBeTruthy()
    expect(screen.getByText('for 35 min')).toBeTruthy()
    expect(screen.getByTestId('appliance-power').textContent).toContain('412 W')
  })

  it('keeps the drum still when idle', () => {
    running = runningSlice({ running: false, since: null, phase: null })
    render(<ApplianceHeroCard {...props} />)
    expect(screen.getByTestId('appliance-state').textContent).toBe('Idle')
    expect(screen.getByTestId('appliance-drum-ring').className).not.toContain('apl-drum-run')
  })

  it('draws an unknown reading as Unknown, never as Idle, off or 0 W', () => {
    running = runningSlice({ running: null, since: null, phase: 'Rinse' })
    power = { lastFetchedAt: 1 }
    render(<ApplianceHeroCard {...props} />)
    expect(screen.getByTestId('appliance-state').textContent).toBe('Unknown')
    expect(screen.getByTestId('appliance-drum-ring').className).not.toContain('apl-drum-run')
    expect(screen.getByTestId('appliance-drum').getAttribute('data-running')).toBe('unknown')
    expect(screen.queryByText('Rinse')).toBeNull()
    expect(screen.getByTestId('appliance-power').textContent).toContain('—')
    expect(screen.getByTestId('appliance-power').textContent).not.toContain('0 W')
  })

  it('shows Unknown and no power row while no slice has landed', () => {
    render(<ApplianceHeroCard {...props} />)
    expect(screen.getByTestId('appliance-state').textContent).toBe('Unknown')
    expect(screen.queryByTestId('appliance-power')).toBeNull()
  })

  it('formats a real zero as 0 W but a missing reading as a dash', () => {
    expect(formatWatts(0)).toBe('0 W')
    expect(formatWatts(undefined)).toBe('—')
  })
})

describe('ApplianceInlineControl', () => {
  it('badges a running cycle and leaves an unknown one unbadged', () => {
    running = runningSlice({})
    const { container, rerender } = render(<ApplianceInlineControl {...props} />)
    expect(container.querySelector('[data-running="running"]')).not.toBeNull()
    running = runningSlice({ running: null })
    rerender(<ApplianceInlineControl {...props} />)
    expect(container.querySelector('[data-running="unknown"]')).not.toBeNull()
    expect(container.querySelector('[data-running="running"]')).toBeNull()
  })
})
