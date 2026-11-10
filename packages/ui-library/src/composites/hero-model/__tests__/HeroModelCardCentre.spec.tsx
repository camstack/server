import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeroModelCard } from '../HeroModelCard'
import { TEST_LABELS, buildModel } from './fixtures'

const host = (run = vi.fn()) => ({ lang: 'en' as const, labels: TEST_LABELS, busy: false, run })
const FETCHED = { lastFetchedAt: 1_700_000_000_000 }

const HEATER = (activeUntil: number | null) => ({
  switch: { on: true, lastChangedAt: FETCHED.lastFetchedAt },
  'timed-run': {
    activeUntil,
    requestedBy: null,
    quickRun: { duration: 25, unit: 'min' },
    ...FETCHED,
  },
})

describe('HeroModelCard scene centre', () => {
  it('a run on a timer is the big countdown, with Stop and the run again, and no run-for row', () => {
    const run = vi.fn()
    const model = buildModel('heater', ['switch', 'timed-run'], HEATER(Date.now() + 25 * 60_000))
    render(<HeroModelCard model={model} host={host(run)} />)
    const centre = screen.getByTestId('countdown-centre')
    expect(centre.textContent).toMatch(/2[45]:\d\d/)
    expect(screen.queryByTestId('hero-row-run-for')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(run).toHaveBeenCalledWith(model.timedRun?.cancel.call, model.timedRun?.cancel)
    expect(screen.getByRole('button', { name: 'Run 25 min' })).toBeTruthy()
  })

  it('a heater with nothing armed keeps its run-for row and draws no countdown', () => {
    const model = buildModel('heater', ['switch', 'timed-run'], HEATER(null))
    render(<HeroModelCard model={model} host={host()} />)
    expect(screen.queryByTestId('countdown-centre')).toBeNull()
    expect(screen.getByTestId('hero-row-run-for')).toBeTruthy()
  })

  it('a timer that will switch the device off shows its countdown in the scene, with no power row', () => {
    const model = buildModel('heater', ['switch', 'timed-run'], HEATER(Date.now() + 25 * 60_000))
    render(<HeroModelCard model={model} host={host()} />)
    expect(screen.getByTestId('countdown-centre')).toBeTruthy()
    expect(screen.queryByTestId('hero-own-power')).toBeNull()
  })

  it('a fan speed is the centre dial in steps of its scale, and plus asks for the next step', () => {
    const run = vi.fn()
    const model = buildModel('fan', ['fan-control'], {
      'fan-control': {
        speed: 60,
        percentageStep: 20,
        preset: '',
        availablePresets: [],
        direction: null,
        oscillating: null,
        lastChangedAt: FETCHED.lastFetchedAt,
      },
    })
    render(<HeroModelCard model={model} host={host(run)} />)
    const dial = screen.getByTestId('speed-centre')
    expect(dial.textContent).toContain('Speed')
    expect(dial.textContent).toContain('3/5')
    expect(screen.queryByTestId('hero-row-fan')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Speed +' }))
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 'fan-control', method: 'setPercentage' }),
      null,
    )
  })

  it('an appliance end time is printed as a clock time, not as a number of minutes', () => {
    const model = buildModel('dishwasher', ['dishwasher'], {
      dishwasher: {
        availability: 'available',
        state: 'running',
        operationState: 'Run',
        program: 'Eco',
        selectedProgram: null,
        availablePrograms: [],
        remaining: 4320,
        delayedStart: null,
        progress: 30,
        doorOpen: false,
        doorLocked: true,
        remoteStartAllowed: true,
        remoteControlActive: true,
        localControlActive: false,
        powerOn: true,
        powerState: 'On',
        filterCleaningDue: null,
        machineCareDue: null,
        machineCareRemainingRuns: null,
        halfLoad: null,
        hygienePlus: null,
        extraDry: null,
        intensiveZone: null,
        varioSpeedPlus: null,
        childLock: null,
        activeEvents: [],
        errorCode: null,
        errorLabel: null,
        ...FETCHED,
      },
    })
    render(<HeroModelCard model={model} host={host()} />)
    const ends = screen.getAllByTestId('scene-tile').find((t) => t.textContent?.startsWith('Ends'))
    expect(ends?.textContent).toMatch(/^Ends\d{1,2}:\d{2}/)
    expect(screen.getByText('1 h 12')).toBeTruthy()
  })
})
