// @vitest-environment jsdom
/**
 * The options the dishwasher card does not draw: toggles only for methods the
 * binding implements, plus delayed start, events and care reminders.
 */
import type { DishwasherStatus } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DishwasherOptionsPanel } from '../dishwasher-options'

const setHalfLoad = vi.fn()
const setChildLock = vi.fn()

let slice: DishwasherStatus | null = null

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => ({
    cap:
      slice === null
        ? undefined
        : {
            setHalfLoad,
            setHygienePlus: vi.fn(),
            setExtraDry: vi.fn(),
            setIntensiveZone: vi.fn(),
            setVarioSpeedPlus: vi.fn(),
            setChildLock,
          },
    slice: slice ?? undefined,
    available: true,
  }),
}))

const trpc = {} as never

function reachable(overrides: Partial<DishwasherStatus> = {}): DishwasherStatus {
  return {
    availability: 'available',
    state: 'idle',
    operationState: 'Ready',
    program: null,
    selectedProgram: 'Eco50',
    availablePrograms: ['Eco50'],
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
    hygienePlus: null,
    extraDry: null,
    intensiveZone: null,
    varioSpeedPlus: null,
    childLock: false,
    activeEvents: [],
    errorCode: null,
    errorLabel: null,
    lastFetchedAt: 1,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  setHalfLoad.mockReset()
  setChildLock.mockReset()
})

describe('DishwasherOptionsPanel', () => {
  it('draws nothing when the dishwasher cap is absent', () => {
    slice = null
    render(
      <DishwasherOptionsPanel
        trpc={trpc}
        deviceId={1}
        features={[]}
        entries={[{ capName: 'dishwasher', implementedMethods: ['setHalfLoad'] }]}
      />,
    )
    expect(screen.queryByTestId('dishwasher-options')).toBeNull()
  })

  it('toggles only the methods the binding implements, and names a care reminder', () => {
    slice = reachable({
      filterCleaningDue: true,
      delayedStart: 600,
      activeEvents: [
        'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
        'BSH.Common.Event.ProgramFinished',
      ],
    })
    render(
      <DishwasherOptionsPanel
        trpc={trpc}
        deviceId={1}
        features={[]}
        entries={[{ capName: 'dishwasher', implementedMethods: ['setHalfLoad'] }]}
      />,
    )
    expect(screen.getByRole('checkbox', { name: 'Half load' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Child lock' })).toBeNull()
    expect(screen.getByText('Filter cleaning due')).toBeTruthy()
    expect(screen.queryByText('Salt Nearly Empty')).toBeNull()
    expect(screen.getByText('Program Finished')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Half load' }))
    expect(setHalfLoad).toHaveBeenCalledWith({ on: true })
  })
})
