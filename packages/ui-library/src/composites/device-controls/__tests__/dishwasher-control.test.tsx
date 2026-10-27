// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DishwasherStatus } from '@camstack/types'
import {
  DishwasherHeroCard,
  DishwasherInlineControl,
  featureLabel,
  formatDuration,
} from '../dishwasher-control'

/** A reachable appliance that has reported everything; tests override what they care about. */
function makeSlice(overrides: Partial<DishwasherStatus> = {}): DishwasherStatus {
  return {
    availability: 'available',
    state: 'idle',
    operationState: 'Ready',
    program: null,
    selectedProgram: 'Dishcare.Dishwasher.Program.Eco50',
    availablePrograms: ['Dishcare.Dishwasher.Program.Eco50', 'Dishcare.Dishwasher.Program.Auto2'],
    remaining: null,
    delayedStart: null,
    progress: null,
    doorOpen: false,
    doorLocked: false,
    remoteStartAllowed: true,
    remoteControlActive: true,
    localControlActive: false,
    powerOn: true,
    powerState: 'On',
    filterCleaningDue: null,
    machineCareDue: null,
    machineCareRemainingRuns: null,
    halfLoad: false,
    hygienePlus: false,
    extraDry: false,
    intensiveZone: false,
    varioSpeedPlus: false,
    childLock: false,
    activeEvents: [],
    errorCode: null,
    errorLabel: null,
    lastFetchedAt: 1,
    ...overrides,
  }
}

const UNKNOWN: Partial<DishwasherStatus> = {
  availability: 'offline',
  state: 'unavailable',
  operationState: null,
  selectedProgram: null,
  doorOpen: null,
  doorLocked: null,
  remoteStartAllowed: null,
  remoteControlActive: null,
  localControlActive: null,
  powerOn: null,
  powerState: null,
  halfLoad: null,
  hygienePlus: null,
  extraDry: null,
  intensiveZone: null,
  varioSpeedPlus: null,
  childLock: null,
  lastFetchedAt: 0,
}

const setHalfLoad = vi.fn()
const setChildLock = vi.fn()
const start = vi.fn()
const pause = vi.fn()
const resume = vi.fn()
const setPower = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

beforeEach(() => {
  for (const fn of [setHalfLoad, setChildLock, start, pause, resume, setPower]) fn.mockReset()
  mockResult = {
    cap: {
      start,
      pause,
      resume,
      stop: vi.fn(),
      setProgram: vi.fn(),
      setPower,
      setHalfLoad,
      setHygienePlus: vi.fn(),
      setExtraDry: vi.fn(),
      setIntensiveZone: vi.fn(),
      setVarioSpeedPlus: vi.fn(),
      setChildLock,
    },
    slice: makeSlice(),
    available: true,
  }
})

function hero() {
  return render(<DishwasherHeroCard trpc={trpc} deviceId={1} features={[]} />)
}

describe('DishwasherHeroCard child lock', () => {
  it('disables option toggles but not child lock when childLock is on', () => {
    mockResult = { ...mockResult, slice: makeSlice({ childLock: true }) }
    hero()
    expect((screen.getByLabelText('Half load') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Child lock') as HTMLInputElement).disabled).toBe(false)
  })

  it('still toggles child lock when engaged', () => {
    mockResult = { ...mockResult, slice: makeSlice({ childLock: true }) }
    hero()
    fireEvent.click(screen.getByLabelText('Child lock'))
    expect(setChildLock).toHaveBeenCalledWith({ on: false })
    expect(setHalfLoad).not.toHaveBeenCalled()
  })
})

describe('DishwasherHeroCard — unknown is not off', () => {
  it('an unreachable appliance says Offline, not Idle, and offers nothing to press', () => {
    mockResult = { ...mockResult, slice: makeSlice(UNKNOWN) }
    hero()
    expect(screen.getByText('Offline')).toBeTruthy()
    expect((screen.getByLabelText('Start') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Power') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows an unknown setting as unknown — a disabled "mixed" box, never an unchecked one', () => {
    mockResult = { ...mockResult, slice: makeSlice(UNKNOWN) }
    hero()
    const halfLoad = screen.getByLabelText(/Half load/) as HTMLInputElement
    expect(halfLoad.disabled).toBe(true)
    expect(halfLoad.getAttribute('aria-checked')).toBe('mixed')
  })

  it('on a reachable appliance a setting it never reports is not drawn at all', () => {
    mockResult = { ...mockResult, slice: makeSlice({ extraDry: null }) }
    hero()
    expect(screen.queryByLabelText(/Extra dry/)).toBeNull()
    expect(screen.getByLabelText('Half load')).toBeTruthy()
  })

  it('an appliance whose profile is not loaded is reported as such', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({ ...UNKNOWN, availability: 'description-missing' }),
    }
    hero()
    expect(screen.getByText('Waiting for the appliance profile')).toBeTruthy()
  })

  it('does not show a door that nobody reported', () => {
    mockResult = { ...mockResult, slice: makeSlice({ doorOpen: null }) }
    hero()
    expect(screen.queryByText('Door open')).toBeNull()
  })
})

describe('DishwasherHeroCard — the whole operation state', () => {
  it.each([
    ['Inactive', 'Inactive'],
    ['Ready', 'Ready'],
    ['DelayedStart', 'Delayed start'],
    ['Run', 'Running'],
    ['Pause', 'Paused'],
    ['ActionRequired', 'Action required'],
    ['Finished', 'Finished'],
    ['Error', 'Error'],
    ['Aborting', 'Stopping'],
  ] as const)('shows %s as "%s"', (operationState, label) => {
    mockResult = { ...mockResult, slice: makeSlice({ operationState }) }
    hero()
    expect(screen.getAllByText(label).length).toBeGreaterThan(0)
  })

  it('renders the remaining time from seconds', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({ operationState: 'Run', remaining: 5400 }),
    }
    hero()
    expect(screen.getByText('1 h 30 min left')).toBeTruthy()
  })

  it('shows the active and the selected program as different things', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({
        operationState: 'Run',
        program: 'Dishcare.Dishwasher.Program.Eco50',
        selectedProgram: 'Dishcare.Dishwasher.Program.Auto2',
      }),
    }
    hero()
    expect(screen.getByTitle('Dishcare.Dishwasher.Program.Eco50').textContent).toBe('Eco50') // active, in the header
    expect((screen.getByLabelText('Program') as HTMLSelectElement).value).toBe(
      'Dishcare.Dishwasher.Program.Auto2',
    )
  })

  it('names a raised event that is not a consumable', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({ activeEvents: ['Dishcare.Dishwasher.Event.ProgramFinished'] }),
    }
    hero()
    expect(screen.getByText('Program Finished')).toBeTruthy()
  })
})

describe('DishwasherHeroCard — commands', () => {
  it('Start needs remote start to be allowed AND a program selected', () => {
    mockResult = { ...mockResult, slice: makeSlice({ remoteStartAllowed: false }) }
    const { unmount } = hero()
    expect((screen.getByLabelText('Start') as HTMLButtonElement).disabled).toBe(true)
    unmount()
    mockResult = { ...mockResult, slice: makeSlice({ selectedProgram: null }) }
    const second = hero()
    expect((screen.getByLabelText('Start') as HTMLButtonElement).disabled).toBe(true)
    second.unmount()
    mockResult = { ...mockResult, slice: makeSlice() }
    hero()
    fireEvent.click(screen.getByLabelText('Start'))
    expect(start).toHaveBeenCalledWith({})
  })

  it('while paused the button resumes instead of pausing', () => {
    mockResult = { ...mockResult, slice: makeSlice({ operationState: 'Pause' }) }
    hero()
    fireEvent.click(screen.getByLabelText('Resume'))
    expect(resume).toHaveBeenCalledWith({})
    expect(pause).not.toHaveBeenCalled()
  })

  it('does not paint a command as done: the slice is untouched until the appliance says so', () => {
    hero()
    fireEvent.click(screen.getByLabelText('Power'))
    expect(setPower).toHaveBeenCalledWith({ on: false })
    // still shows the real (unchanged) slice
    expect(screen.getByText('Ready')).toBeTruthy()
  })
})

describe('DishwasherInlineControl', () => {
  it('shows the offline state compactly and disables the buttons', () => {
    mockResult = { ...mockResult, slice: makeSlice(UNKNOWN) }
    render(<DishwasherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Offline')).toBeTruthy()
    expect((screen.getByLabelText('Start') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the remaining time in whole units', () => {
    mockResult = {
      ...mockResult,
      slice: makeSlice({ operationState: 'Run', remaining: 2520 }),
    }
    render(<DishwasherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('42 min')).toBeTruthy()
  })
})

describe('formatting helpers', () => {
  it('formats seconds without ever turning them into minutes by magnitude', () => {
    expect(formatDuration(30)).toBe('30 s')
    expect(formatDuration(300)).toBe('5 min')
    expect(formatDuration(3600)).toBe('1 h')
    expect(formatDuration(5400)).toBe('1 h 30 min')
  })

  it('labels a feature key by its last segment', () => {
    expect(featureLabel('Dishcare.Dishwasher.Program.Eco50')).toBe('Eco50')
    expect(featureLabel('Dishcare.Dishwasher.Event.SaltNearlyEmpty')).toBe('Salt Nearly Empty')
  })
})

describe('Dishwasher consumables', () => {
  it('the hero and the row draw no salt or rinse aid — the page Consumables section does (D915)', () => {
    // A slice still carrying the old fields, or raising the salt/rinse events,
    // draws nothing for them. Those items live in the Consumables section.
    mockResult.slice = {
      ...makeSlice({
        activeEvents: [
          'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
          'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty',
        ],
      }),
      saltLevel: 'low',
      rinseAidLevel: 'empty',
    }
    hero()
    expect(screen.queryByText(/Salt/)).toBeNull()
    expect(screen.queryByText(/Rinse/)).toBeNull()
    render(<DishwasherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText(/Salt/)).toBeNull()
    expect(screen.queryByText(/Rinse/)).toBeNull()
  })
})
