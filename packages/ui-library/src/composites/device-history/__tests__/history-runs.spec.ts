import { describe, expect, it } from 'vitest'
import type { DeviceRun } from '@camstack/types'
import { defaultUiText } from '../../../contexts/ui-text'
import {
  RUN_WINDOW_MARGIN_MS,
  formatKwh,
  runBands,
  runDurationMs,
  runStatus,
  runWindow,
} from '../history-runs'

const NOW = 10_000_000
const run = (over: Partial<DeviceRun> = {}, kwh: number | null = 1.5): DeviceRun => ({
  runId: '7:1000000',
  deviceId: 7,
  kind: 'appliance',
  state: 'closed',
  startedAt: 1_000_000,
  endedAt: 1_600_000,
  durationMs: 600_000,
  outcome: 'completed',
  startSource: 'running-state',
  endSource: 'running-state',
  runningSource: 'assigned',
  phases: [],
  detail: {
    kind: 'appliance',
    energyKwh: kwh,
    energyMethod: 'history-integral',
    peakW: 2000,
    avgW: 900,
    program: null,
    remainingAtStartSec: null,
    finalPhase: null,
    energyStartKwh: null,
    powerObservedMs: 600_000,
  },
  ...over,
})
const openRun = (): DeviceRun =>
  run({
    state: 'open',
    endedAt: null,
    durationMs: null,
    outcome: null,
    startedAt: 9_000_000,
  })

describe('runBands', () => {
  const window = { from: 0, to: NOW }

  it('draws a closed run from start to end with its duration and energy', () => {
    const [band] = runBands([run()], NOW, window, defaultUiText)
    expect(band).toMatchObject({
      from: 1_000_000,
      to: 1_600_000,
      tone: 'success',
      title: 'Run',
    })
    expect(band?.label).toBe('10m 0s · 1.50 kWh')
  })

  it('extends an open run to now and says it is running', () => {
    const [band] = runBands([openRun()], NOW, window, defaultUiText)
    expect(band).toMatchObject({ from: 9_000_000, to: NOW, tone: 'info' })
    expect(band?.label).toMatch(/^running · /)
  })

  it('never turns an unmeasured energy into 0 kWh', () => {
    const [band] = runBands([run({}, null)], NOW, window, defaultUiText)
    expect(band?.label).toBe('10m 0s · —')
    expect(formatKwh(null)).toBe('—')
    expect(formatKwh(0)).toBe('0.00 kWh')
  })

  it('drops a run outside the window and tones the outcomes', () => {
    const aborted = run({
      outcome: 'aborted',
      runId: 'a',
      startedAt: 5_000_000,
      endedAt: 5_100_000,
    })
    const bands = runBands([run(), aborted], NOW, { from: 2_000_000, to: NOW }, defaultUiText)
    expect(bands.map((b) => [b.id, b.tone])).toEqual([['a', 'warning']])
  })
})

describe('run helpers', () => {
  it('opens a run with 15 minutes of context either side; an open run reaches now', () => {
    expect(runWindow(run(), NOW)).toEqual({
      from: 1_000_000 - RUN_WINDOW_MARGIN_MS,
      to: 1_600_000 + RUN_WINDOW_MARGIN_MS,
    })
    expect(runWindow(openRun(), NOW).to).toBe(NOW + RUN_WINDOW_MARGIN_MS)
  })

  it('counts an open run up to now and reports status', () => {
    expect(runDurationMs(openRun(), NOW)).toBe(1_000_000)
    expect(runStatus(openRun())).toBe('running')
    expect(runStatus(run({ outcome: null }))).toBe('unknown')
  })
})
