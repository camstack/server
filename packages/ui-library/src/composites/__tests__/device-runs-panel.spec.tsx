// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceRun } from '@camstack/types'
import { DeviceRunsPanel } from '../DeviceRunsPanel'
import { RUN_WINDOW_MARGIN_MS } from '../device-history/history-runs'

const NOW = 100_000_000
const MIN = 60_000

const run = (id: number, over: Partial<DeviceRun> = {}, kwh: number | null = 1.25): DeviceRun => ({
  runId: `7:${String(id)}`,
  deviceId: 7,
  kind: 'appliance',
  state: 'closed',
  startedAt: id,
  endedAt: id + 90 * MIN,
  durationMs: 90 * MIN,
  outcome: 'completed',
  startSource: 'running-state',
  endSource: 'running-state',
  runningSource: 'assigned',
  phases: [],
  detail: {
    kind: 'appliance',
    energyKwh: kwh,
    energyMethod: 'history-integral',
    peakW: 2100,
    avgW: 850,
    program: null,
    remainingAtStartSec: null,
    finalPhase: null,
    energyStartKwh: null,
    powerObservedMs: 1,
  },
  ...over,
})

afterEach(cleanup)

describe('DeviceRunsPanel', () => {
  it('shows an unmeasured energy as a dash, never 0 kWh', () => {
    render(<DeviceRunsPanel runs={[run(10 * MIN, {}, null)]} now={NOW} onSelectWindow={vi.fn()} />)
    expect(screen.queryByText(/0\.00 kWh/)).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText('850 W')).toBeTruthy()
  })

  it('says an open run is running since its start', () => {
    const open = run(NOW - 30 * MIN, {
      state: 'open',
      endedAt: null,
      durationMs: null,
      outcome: null,
    })
    render(<DeviceRunsPanel runs={[open]} now={NOW} onSelectWindow={vi.fn()} />)
    expect(screen.getByText(/^Running since /)).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('30m 0s')).toBeTruthy()
  })

  it('opens the run plus 15 minutes either side when its row is clicked', () => {
    const onSelectWindow = vi.fn()
    const r = run(50 * MIN)
    render(<DeviceRunsPanel runs={[r]} now={NOW} onSelectWindow={onSelectWindow} />)
    fireEvent.click(screen.getByText('Completed'))
    expect(onSelectWindow).toHaveBeenCalledWith({
      from: 50 * MIN - RUN_WINDOW_MARGIN_MS,
      to: 140 * MIN + RUN_WINDOW_MARGIN_MS,
    })
  })
})
