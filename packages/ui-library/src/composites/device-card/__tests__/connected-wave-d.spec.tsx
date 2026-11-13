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
  type ValveStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedAlarmCard } from '../connected/ConnectedAlarmCard'
import { ConnectedLockCard } from '../connected/ConnectedLockCard'
import { ConnectedValveCard } from '../connected/ConnectedValveCard'

const hub = vi.hoisted(() => ({
  lock: { lock: vi.fn(), unlock: vi.fn(), open: vi.fn() },
  alarm: { arm: vi.fn(), disarm: vi.fn() },
  valve: { open: vi.fn(), close: vi.fn(), stop: vi.fn() },
  lockSlice: null as LockControlStatus | null,
  alarmSlice: null as AlarmPanelStatus | null,
  valveSlice: null as ValveStatus | null,
  door: null as { readonly name: string; readonly reading: 'open' | 'closed' | null } | null,
  features: [] as readonly string[],
}))

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
    state: {
      lockControl: hub.lockSlice ?? undefined,
      alarmPanel: hub.alarmSlice ?? undefined,
      valve: hub.valveSlice ?? undefined,
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
]

beforeEach(() => {
  for (const fn of allFns()) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.lockSlice = null
  hub.alarmSlice = null
  hub.valveSlice = null
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
})
