// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DishwasherStatus } from '@camstack/types'
import { DishwasherInlineControl, featureLabel, formatDuration } from '../dishwasher-control'

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
  it('the row draws no salt or rinse aid — the page Consumables section does (D915)', () => {
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
    render(<DishwasherInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText(/Salt/)).toBeNull()
    expect(screen.queryByText(/Rinse/)).toBeNull()
  })
})
