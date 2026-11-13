// @vitest-environment jsdom
/**
 * The Wave-D connected cards against a fake hub: which method a command
 * reaches. A lock locks and unlocks through `lock-control`, releases the latch
 * only when the device declares `lock-open`, and refuses to lock beside an open
 * door; an alarm panel sends its code only with the command; a valve opens,
 * closes and stops through `valve`.
 */
import {
  type AlarmPanelStatus,
  DeviceFeature,
  DeviceType,
  type LockControlStatus,
  type PetFeederStatus,
  type PetFountainStatus,
  type PumpCycleStatus,
  type ValveStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedAlarmCard } from '../connected/ConnectedAlarmCard'
import { ConnectedLockCard } from '../connected/ConnectedLockCard'
import { ConnectedPetFeederCard } from '../connected/ConnectedPetFeederCard'
import { ConnectedPetFountainCard } from '../connected/ConnectedPetFountainCard'
import { ConnectedValveCard } from '../connected/ConnectedValveCard'

interface DoorReading {
  readonly name: string
  readonly reading: 'open' | 'closed' | null
}

interface WaveDHub {
  lock: {
    lock: ReturnType<typeof vi.fn>
    unlock: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
  }
  alarm: { arm: ReturnType<typeof vi.fn>; disarm: ReturnType<typeof vi.fn> }
  valve: {
    open: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
  }
  fountain: { setPump: ReturnType<typeof vi.fn> }
  cycle: {
    setEnabled: ReturnType<typeof vi.fn>
    setOnMinutes: ReturnType<typeof vi.fn>
    setOffMinutes: ReturnType<typeof vi.fn>
  }
  feeder: { markFoodReplenished: ReturnType<typeof vi.fn> }
  lockSlice: LockControlStatus | null
  alarmSlice: AlarmPanelStatus | null
  valveSlice: ValveStatus | null
  fountainSlice: PetFountainStatus | null
  cycleSlice: PumpCycleStatus | null
  feederSlice: PetFeederStatus | null
  door: DoorReading | null
  features: readonly string[]
}

const hub = vi.hoisted(
  (): WaveDHub => ({
    lock: { lock: vi.fn(), unlock: vi.fn(), open: vi.fn() },
    alarm: { arm: vi.fn(), disarm: vi.fn() },
    valve: { open: vi.fn(), close: vi.fn(), stop: vi.fn(), setPosition: vi.fn() },
    fountain: { setPump: vi.fn() },
    cycle: { setEnabled: vi.fn(), setOnMinutes: vi.fn(), setOffMinutes: vi.fn() },
    feeder: { markFoodReplenished: vi.fn() },
    lockSlice: null,
    alarmSlice: null,
    valveSlice: null,
    fountainSlice: null,
    cycleSlice: null,
    feederSlice: null,
    door: null,
    features: [],
  }),
)

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-lock-door-sensor', () => ({
  useLockDoorSensor: () => hub.door,
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    lockControl: hub.lockSlice === null ? undefined : hub.lock,
    alarmPanel: hub.alarmSlice === null ? undefined : hub.alarm,
    valve: hub.valveSlice === null ? undefined : hub.valve,
    petFountain: hub.fountainSlice === null ? undefined : hub.fountain,
    pumpCycle: hub.cycleSlice === null ? undefined : hub.cycle,
    petFeeder: hub.feederSlice === null ? undefined : hub.feeder,
    state: {
      lockControl: hub.lockSlice ?? undefined,
      alarmPanel: hub.alarmSlice ?? undefined,
      valve: hub.valveSlice ?? undefined,
      petFountain: hub.fountainSlice ?? undefined,
      pumpCycle: hub.cycleSlice ?? undefined,
      petFeeder: hub.feederSlice ?? undefined,
    },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', async () => {
  const { useCommandNotice } = await import('../connected/use-command-notice')
  return {
    useCardCommon: () => {
      const { notice, fail, succeed } = useCommandNotice()
      const common = plugFixtures(0)[0]?.model.common
      if (common === undefined) throw new Error('no plug fixture')
      return {
        common: {
          ...common,
          power: null,
          consumables: null,
          supply: null,
          remote: null,
          battery: null,
          notice,
        },
        actions: {},
        deviceType: DeviceType.Lock,
        role: null,
        features: hub.features,
        implements: (): boolean => true,
        fail,
        succeed,
      }
    },
  }
})

const allFns = (): readonly ReturnType<typeof vi.fn>[] => [
  ...Object.values(hub.lock),
  ...Object.values(hub.alarm),
  ...Object.values(hub.valve),
  ...Object.values(hub.fountain),
  ...Object.values(hub.cycle),
  ...Object.values(hub.feeder),
]

beforeEach(() => {
  for (const fn of allFns()) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.lockSlice = null
  hub.alarmSlice = null
  hub.valveSlice = null
  hub.fountainSlice = null
  hub.cycleSlice = null
  hub.feederSlice = null
  hub.door = null
  hub.features = []
})
afterEach(cleanup)

const ALARM: AlarmPanelStatus = {
  state: 'armed_away',
  targetMode: null,
  availableModes: ['home', 'away', 'night'],
  requiresCode: true,
  lastChangedAt: 0,
}

describe('a lock', () => {
  it('unlocks through lock-control after the confirmation', async () => {
    hub.lockSlice = { state: 'locked', lastChangedAt: 0 }
    render(<ConnectedLockCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-lock-unlock'))
    fireEvent.click(screen.getByTestId('dc-lock-unlock'))
    await vi.waitFor(() => expect(hub.lock.unlock).toHaveBeenCalledWith({}))
  })

  it('releases the latch only when the device declares lock-open', async () => {
    hub.lockSlice = { state: 'locked', lastChangedAt: 0 }
    render(<ConnectedLockCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-lock-open')).toBeNull()
    cleanup()
    hub.features = [DeviceFeature.LockOpen]
    render(<ConnectedLockCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-lock-open'))
    fireEvent.click(screen.getByTestId('dc-lock-open'))
    await vi.waitFor(() => expect(hub.lock.open).toHaveBeenCalledWith({}))
  })

  it('refuses to lock while the linked door contact reads open', () => {
    hub.lockSlice = { state: 'unlocked', lastChangedAt: 0 }
    hub.door = { name: 'Contatto porta', reading: 'open' }
    render(<ConnectedLockCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-lock-lock'))
    expect(hub.lock.lock).not.toHaveBeenCalled()
    expect(screen.getByTestId('dc-lock-door').textContent).toContain('Contatto porta')
  })

  it('locks through lock-control when the door is closed', async () => {
    hub.lockSlice = { state: 'unlocked', lastChangedAt: 0 }
    hub.door = { name: 'Contatto porta', reading: 'closed' }
    render(<ConnectedLockCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-lock-lock'))
    await vi.waitFor(() => expect(hub.lock.lock).toHaveBeenCalledWith({}))
  })
})

describe('an alarm panel', () => {
  it('sends the code with the disarm, and nowhere else', async () => {
    hub.alarmSlice = ALARM
    render(<ConnectedAlarmCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Disarmed' }))
    for (const digit of ['4', '2', '4', '2'])
      fireEvent.click(screen.getByTestId(`dc-code-${digit}`))
    fireEvent.click(screen.getByTestId('dc-code-submit'))
    await vi.waitFor(() => expect(hub.alarm.disarm).toHaveBeenCalledWith({ code: '4242' }))
    expect(hub.alarm.arm).not.toHaveBeenCalled()
  })

  it('arms a panel that wants no code with the mode alone', async () => {
    hub.alarmSlice = { ...ALARM, state: 'disarmed', requiresCode: false }
    render(<ConnectedAlarmCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Night' }))
    await vi.waitFor(() => expect(hub.alarm.arm).toHaveBeenCalledWith({ mode: 'night' }))
  })
})

describe('a valve', () => {
  it('opens a closed valve and stops a moving one', async () => {
    hub.valveSlice = { state: 'closed', position: null, lastChangedAt: 0 }
    render(<ConnectedValveCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-valve-open'))
    await vi.waitFor(() => expect(hub.valve.open).toHaveBeenCalledWith({}))
    cleanup()
    hub.valveSlice = { state: 'opening', position: 40, lastChangedAt: 0 }
    render(<ConnectedValveCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-valve-stop'))
    await vi.waitFor(() => expect(hub.valve.stop).toHaveBeenCalledWith({}))
  })

  it('draws no position slider when setPosition exists but valve-positionable does not', () => {
    hub.valveSlice = { state: 'open', position: 40, lastChangedAt: 0 }
    render(<ConnectedValveCard deviceId={1} optimistic={false} />)
    expect(screen.queryByRole('slider', { name: 'Opening' })).toBeNull()
    cleanup()
    hub.features = [DeviceFeature.ValvePositionable]
    render(<ConnectedValveCard deviceId={1} optimistic={false} />)
    expect(screen.getByRole('slider', { name: 'Opening' })).toBeTruthy()
  })
})

const FOUNTAIN: PetFountainStatus = {
  waterLevel: 64,
  waterVolume: 1.3,
  empty: false,
  pumpRunning: true,
  error: null,
  lastFetchedAt: 1,
}

function feederStatus(patch: Partial<PetFeederStatus>): PetFeederStatus {
  return {
    foodLevel: 50,
    bowlFood: null,
    eating: false,
    supportsMarkRefilled: false,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: null,
    powerSource: null,
    desiccantLeftDays: null,
    feeding: false,
    status: 'normal',
    error: null,
    errorCode: null,
    isDualHopper: false,
    childLock: false,
    indicatorLight: false,
    feedSound: false,
    volume: 0,
    lastFeedGrams: null,
    lastFeedHopper1: null,
    lastFeedHopper2: null,
    lastFetchedAt: 1,
    ...patch,
  }
}

describe('a pet fountain', () => {
  it('draws the pump cycle and the tank volume when those caps are composed', () => {
    hub.fountainSlice = FOUNTAIN
    hub.cycleSlice = { enabled: true, onTime: 600, offTime: 1200, lastFetchedAt: 1 }
    render(<ConnectedPetFountainCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-fountain-volume').textContent).toContain('1300 mL')
    expect(screen.getByTestId('dc-fountain-cycle').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('dc-fountain-run').textContent).toContain('10')
    expect(screen.getByTestId('dc-fountain-rest').textContent).toContain('20')
  })

  it('draws no cycle on a fountain that does not compose pump-cycle', () => {
    hub.fountainSlice = FOUNTAIN
    render(<ConnectedPetFountainCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-fountain-cycle')).toBeNull()
  })

  it('does not draw an unknown pump as off', () => {
    hub.fountainSlice = { ...FOUNTAIN, pumpRunning: null }
    render(<ConnectedPetFountainCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-fountain-pump-on')).toBeTruthy()
    expect(screen.getByTestId('dc-fountain-pump-off')).toBeTruthy()
    expect(screen.queryByTestId('dc-fountain-pump')).toBeNull()
  })
})

describe('a pet feeder', () => {
  it('shows backup charge from the feeder itself when it binds no battery cap', () => {
    hub.feederSlice = feederStatus({
      batteryPower: 40,
      powerSource: 'mains',
      status: 'normal',
    })
    render(<ConnectedPetFeederCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-battery').textContent).toContain('Backup 40%')
    expect(screen.getByTestId('dc-state').textContent).toContain('Mains')
  })

  it('names on-battery and offline from the feeder status', () => {
    hub.feederSlice = feederStatus({
      batteryPower: 40,
      powerSource: 'battery',
      status: 'on_batteries',
    })
    render(<ConnectedPetFeederCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-state').textContent).toContain('On battery')
    expect(screen.getByTestId('dc-battery').textContent).toContain('40%')
    expect(screen.getByTestId('dc-battery').textContent).not.toContain('Backup')
    cleanup()
    hub.feederSlice = feederStatus({ status: 'offline', batteryPower: null, powerSource: null })
    render(<ConnectedPetFeederCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-state').textContent).toContain('Offline')
  })

  it('offers Mark refilled from supportsMarkRefilled alone', () => {
    hub.feederSlice = feederStatus({ supportsMarkRefilled: true, lowFood: false })
    render(<ConnectedPetFeederCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-feeder-refilled')).toBeTruthy()
    cleanup()
    hub.feederSlice = feederStatus({ supportsMarkRefilled: false, lowFood: true })
    render(<ConnectedPetFeederCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-feeder-refilled')).toBeNull()
  })
})
