// @vitest-environment jsdom
/**
 * The Wave-B connected cards against a fake hub: which capability a command
 * reaches. A supply-fed washer powers its `switch` (armed while a cycle
 * runs); a dishwasher starts through `dishwasher`, refused with the machine's
 * reason; a media player's controls follow its declared features; a vacuum
 * and a mower drive their own control caps.
 */
import {
  DeviceFeature,
  DeviceType,
  type DishwasherStatus,
  type LawnMowerControlStatus,
  type MediaPlayerStatus,
  type RunningStateStatus,
  type VacuumControlStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedApplianceCard } from '../connected/ConnectedApplianceCard'
import { ConnectedDishwasherCard } from '../connected/ConnectedDishwasherCard'
import { ConnectedMediaCard } from '../connected/ConnectedMediaCard'
import { ConnectedMowerCard, ConnectedVacuumCard } from '../connected/ConnectedRobotCard'

const DISH: DishwasherStatus = {
  availability: 'available',
  state: 'idle',
  operationState: 'Ready',
  program: null,
  selectedProgram: 'Eco 50',
  availablePrograms: ['Auto 45-65', 'Eco 50', 'Quick 45'],
  remaining: null,
  delayedStart: null,
  progress: null,
  doorOpen: false,
  doorLocked: null,
  remoteStartAllowed: true,
  remoteControlActive: true,
  localControlActive: false,
  powerOn: true,
  powerState: null,
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
  lastFetchedAt: 0,
}

const MEDIA: MediaPlayerStatus = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 40,
  isMuted: false,
  source: 'Spotify',
  availableSources: ['Spotify', 'TV'],
  currentMedia: { type: 'music', title: 'Blue in Green', artist: 'Miles Davis' },
  position: 30_000,
  duration: 120_000,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: 0,
}

const VACUUM: VacuumControlStatus = {
  state: 'docked',
  batteryLevel: 80,
  fanSpeed: 'Standard',
  availableFanSpeeds: ['Quiet', 'Standard', 'Turbo'],
  progress: null,
  errorCode: null,
  errorLabel: null,
  lastChangedAt: 0,
}

const MOWER: LawnMowerControlStatus = {
  activity: 'mowing',
  batteryLevel: 60,
  progress: 40,
  currentCode: null,
  currentCodeLabel: null,
  severity: 'info',
  lastChangedAt: 0,
}

const hub = vi.hoisted(() => ({
  setState: vi.fn(),
  dish: {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    setProgram: vi.fn(),
    setPower: vi.fn(),
  },
  media: {
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    volumeUp: vi.fn(),
    volumeDown: vi.fn(),
    setVolume: vi.fn(),
    setMute: vi.fn(),
    selectSource: vi.fn(),
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    setShuffle: vi.fn(),
    setRepeat: vi.fn(),
  },
  vacuum: {
    start: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    returnToBase: vi.fn(),
    locate: vi.fn(),
    setFanSpeed: vi.fn(),
  },
  mower: { startMowing: vi.fn(), pause: vi.fn(), dock: vi.fn() },
  deviceType: 'washer',
  features: [] as string[],
  running: null as RunningStateStatus | null,
  switchOn: true as boolean | null,
  dishSlice: null as DishwasherStatus | null,
  mediaSlice: null as MediaPlayerStatus | null,
  vacuumSlice: null as VacuumControlStatus | null,
  mowerSlice: null as LawnMowerControlStatus | null,
  /** Null: the binding lists no methods, so every method of the cap is offered. */
  methods: null as Readonly<Record<string, readonly string[]>> | null,
  getOptions: null as null | ((input?: unknown) => Promise<unknown>),
  volumeUpMissing: false,
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    switch: hub.switchOn === null ? undefined : { setState: hub.setState },
    timedRun: undefined,
    runningState: hub.running === null ? undefined : {},
    dishwasher:
      hub.dishSlice === null
        ? undefined
        : {
            ...hub.dish,
            ...(hub.getOptions === null ? {} : { getOptions: hub.getOptions }),
          },
    mediaPlayer:
      hub.mediaSlice === null
        ? undefined
        : {
            ...hub.media,
            volumeUp: hub.volumeUpMissing ? undefined : hub.media.volumeUp,
          },
    vacuumControl: hub.vacuumSlice === null ? undefined : hub.vacuum,
    lawnMowerControl: hub.mowerSlice === null ? undefined : hub.mower,
    state: {
      switch: hub.switchOn === null ? undefined : { on: hub.switchOn, lastChangedAt: 0 },
      timedRun: undefined,
      runningState: hub.running ?? undefined,
      dishwasher: hub.dishSlice ?? undefined,
      mediaPlayer: hub.mediaSlice ?? undefined,
      vacuumControl: hub.vacuumSlice ?? undefined,
      lawnMowerControl: hub.mowerSlice ?? undefined,
    },
  }),
  // The fake proxy carries the slice value itself.
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
        common: { ...common, consumables: null, supply: null, remote: null, battery: null, notice },
        actions: {},
        deviceType: hub.deviceType,
        role: null,
        features: hub.features,
        implements: (cap: string, method: string): boolean => {
          if (hub.methods === null) return true
          const listed = hub.methods[cap]
          return listed !== undefined && listed.includes(method)
        },
        fail,
        succeed,
      }
    },
  }
})

const allFns = (): readonly ReturnType<typeof vi.fn>[] => [
  hub.setState,
  ...Object.values(hub.dish),
  ...Object.values(hub.media),
  ...Object.values(hub.vacuum),
  ...Object.values(hub.mower),
]

beforeEach(() => {
  for (const fn of allFns()) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.deviceType = DeviceType.Washer
  hub.features = []
  hub.running = null
  hub.switchOn = true
  hub.dishSlice = null
  hub.mediaSlice = null
  hub.vacuumSlice = null
  hub.mowerSlice = null
  hub.methods = null
  hub.volumeUpMissing = false
  hub.getOptions = null
})
afterEach(cleanup)

describe('a supply-fed washer', () => {
  it('arms before its switch cuts a running cycle, then turns it off through switch', async () => {
    hub.running = {
      running: true,
      since: Date.now() - 60_000,
      source: 'assigned',
      phase: null,
      lastFetchedAt: null,
    }
    render(<ConnectedApplianceCard deviceId={1} optimistic={false} />)
    const power = screen.getByTestId('dc-appliance-power')
    fireEvent.click(power)
    expect(hub.setState).not.toHaveBeenCalled()
    expect(power.textContent).toBe('Confirm: interrupts')
    fireEvent.click(power)
    await vi.waitFor(() => expect(hub.setState).toHaveBeenCalledWith({ on: false }))
  })

  it('draws nothing until the running reading has answered', () => {
    hub.switchOn = null
    const { container } = render(<ConnectedApplianceCard deviceId={1} />)
    expect(container.textContent).toBe('')
  })

  it('an unknown reading is Unknown, never Stopped', () => {
    hub.running = {
      running: null,
      since: null,
      source: 'assigned',
      phase: null,
      lastFetchedAt: null,
    }
    render(<ConnectedApplianceCard deviceId={1} />)
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.queryByText('Stopped')).toBeNull()
  })
})

describe('a dishwasher that speaks for itself', () => {
  beforeEach(() => {
    hub.deviceType = DeviceType.Dishwasher
    hub.switchOn = null
  })

  it('names the program from the cap, and shortens a raw key when the cap has no label', async () => {
    const key = 'Dishcare.Dishwasher.Program.Eco50'
    hub.dishSlice = {
      ...DISH,
      selectedProgram: key,
      availablePrograms: [key, 'Dishcare.Dishwasher.Program.Quick65'],
    }
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-appliance-program-value').textContent).toBe('Eco 50°')
    expect(screen.getByTestId('dc-appliance-start').textContent).toBe('Start Eco 50°')
    cleanup()
    hub.getOptions = vi.fn().mockResolvedValue({
      programs: [{ key, name: 'Economy wash' }],
    })
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    await vi.waitFor(() =>
      expect(screen.getByTestId('dc-appliance-program-value').textContent).toBe('Economy wash'),
    )
    expect(screen.getByTestId('dc-appliance-start').textContent).toBe('Start Economy wash')
  })

  it('starts the selected program through dishwasher.start', async () => {
    hub.dishSlice = DISH
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    const start = screen.getByTestId('dc-appliance-start')
    expect(start.textContent).toBe('Start Eco 50')
    fireEvent.click(start)
    await vi.waitFor(() => expect(hub.dish.start).toHaveBeenCalledWith({}))
  })

  it('steps the program through dishwasher.setProgram', async () => {
    hub.dishSlice = DISH
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-appliance-program-down'))
    await vi.waitFor(() =>
      expect(hub.dish.setProgram).toHaveBeenCalledWith({ program: 'Quick 45' }),
    )
  })

  it('refuses the start, with the reason, while remote start is off', () => {
    hub.dishSlice = { ...DISH, remoteStartAllowed: false }
    render(<ConnectedDishwasherCard deviceId={1} />)
    expect(screen.getByTestId('dc-appliance-start')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dc-appliance-why').textContent).toBe(
      'Remote start is not enabled on the machine',
    )
  })

  it('a running cycle pauses, and stops only after the second press', async () => {
    hub.dishSlice = { ...DISH, state: 'running', remaining: 38 * 60, progress: 40 }
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-appliance-pause'))
    await vi.waitFor(() => expect(hub.dish.pause).toHaveBeenCalledWith({}))
    const stop = screen.getByTestId('dc-appliance-stop')
    fireEvent.click(stop)
    expect(hub.dish.stop).not.toHaveBeenCalled()
    fireEvent.click(stop)
    await vi.waitFor(() => expect(hub.dish.stop).toHaveBeenCalledWith({}))
    expect(screen.getByTestId('dc-appliance-program').textContent).toContain('38 min left')
  })

  it('powers off through setPower, and asks first while a cycle runs or is paused', async () => {
    hub.dishSlice = { ...DISH, state: 'running', powerOn: true }
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    const power = screen.getByTestId('dc-appliance-power')
    fireEvent.click(power)
    expect(hub.dish.setPower).not.toHaveBeenCalled()
    fireEvent.click(power)
    await vi.waitFor(() => expect(hub.dish.setPower).toHaveBeenCalledWith({ on: false }))
    cleanup()
    hub.dish.setPower.mockClear()
    hub.dishSlice = { ...DISH, state: 'paused', powerOn: true }
    render(<ConnectedDishwasherCard deviceId={1} optimistic={false} />)
    const paused = screen.getByTestId('dc-appliance-power')
    fireEvent.click(paused)
    expect(hub.dish.setPower).not.toHaveBeenCalled()
    fireEvent.click(paused)
    await vi.waitFor(() => expect(hub.dish.setPower).toHaveBeenCalledWith({ on: false }))
  })

  it('draws no power control when the binding does not implement setPower', () => {
    hub.methods = { dishwasher: ['start', 'pause', 'resume', 'stop', 'setProgram'] }
    hub.dishSlice = DISH
    render(<ConnectedDishwasherCard deviceId={1} />)
    expect(screen.queryByTestId('dc-appliance-power')).toBeNull()
  })
})

describe('a media player draws what it declares', () => {
  beforeEach(() => {
    hub.deviceType = DeviceType.MediaPlayer
    hub.switchOn = null
  })

  it('with no declared features it draws no volume, source, seek or skip', () => {
    hub.mediaSlice = MEDIA
    render(<ConnectedMediaCard deviceId={1} />)
    expect(screen.queryByTestId('dc-media-volume')).toBeNull()
    expect(screen.queryByTestId('dc-media-source')).toBeNull()
    expect(screen.queryByTestId('dc-media-seek')).toBeNull()
    expect(screen.queryByTestId('dc-media-power')).toBeNull()
    expect(screen.getByTestId('dc-media-title').textContent).toBe('Blue in Green')
  })

  it('pauses through media-player.pause', async () => {
    hub.mediaSlice = MEDIA
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-play'))
    await vi.waitFor(() => expect(hub.media.pause).toHaveBeenCalledWith({}))
  })

  it('a volume level steps through setVolume, volume keys through volumeUp', async () => {
    hub.mediaSlice = MEDIA
    hub.features = [DeviceFeature.MediaPlayerVolume]
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-volume-up'))
    await vi.waitFor(() => expect(hub.media.setVolume).toHaveBeenCalledWith({ volumeLevel: 45 }))
    cleanup()
    hub.features = [DeviceFeature.MediaPlayerVolumeStep]
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-volume-up'))
    await vi.waitFor(() => expect(hub.media.volumeUp).toHaveBeenCalledWith({ steps: 1 }))
  })

  it('mutes through setMute when mute is declared', async () => {
    hub.mediaSlice = MEDIA
    hub.features = [DeviceFeature.MediaPlayerVolume, DeviceFeature.MediaPlayerMute]
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-mute'))
    await vi.waitFor(() => expect(hub.media.setMute).toHaveBeenCalledWith({ muted: true }))
  })

  it('turns off through turnOff when power is declared', async () => {
    hub.mediaSlice = MEDIA
    hub.features = [DeviceFeature.MediaPlayerPower]
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-power'))
    await vi.waitFor(() => expect(hub.media.turnOff).toHaveBeenCalledWith({}))
  })

  it('a refused mute names the failure', async () => {
    hub.mediaSlice = MEDIA
    hub.features = [DeviceFeature.MediaPlayerVolume, DeviceFeature.MediaPlayerMute]
    hub.media.setMute.mockRejectedValueOnce(new Error('busy'))
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-mute'))
    const reason = await screen.findByTestId('dc-reason')
    expect(reason.textContent).toBe('Command failed: busy')
  })

  it('a missing volumeUp is a failure, never a success', async () => {
    hub.mediaSlice = MEDIA
    hub.features = [DeviceFeature.MediaPlayerVolumeStep]
    hub.volumeUpMissing = true
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-media-volume-up'))
    const reason = await screen.findByTestId('dc-reason')
    expect(reason.textContent).toBe('Command failed: media-player does not implement volumeUp')
    expect(hub.media.volumeUp).not.toHaveBeenCalled()
  })

  it('shuffle and repeat sit in the remote sheet, only when declared', async () => {
    hub.mediaSlice = { ...MEDIA, shuffle: false, repeat: 'off' }
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-remote')).toBeNull()
    expect(screen.queryByTestId('dc-media-shuffle')).toBeNull()
    cleanup()
    hub.features = [DeviceFeature.MediaPlayerShuffle, DeviceFeature.MediaPlayerRepeat]
    render(<ConnectedMediaCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-media-shuffle')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-remote'))
    fireEvent.click(screen.getByTestId('dc-media-shuffle'))
    await vi.waitFor(() => expect(hub.media.setShuffle).toHaveBeenCalledWith({ shuffle: true }))
    fireEvent.click(screen.getByTestId('dc-media-repeat'))
    await vi.waitFor(() => expect(hub.media.setRepeat).toHaveBeenCalledWith({ repeat: 'all' }))
  })
})

describe('a robot vacuum', () => {
  beforeEach(() => {
    hub.deviceType = DeviceType.Vacuum
    hub.switchOn = null
  })

  it('cleans through vacuum-control.start and steps suction through setFanSpeed', async () => {
    hub.vacuumSlice = VACUUM
    render(<ConnectedVacuumCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-robot-go'))
    await vi.waitFor(() => expect(hub.vacuum.start).toHaveBeenCalledWith({}))
    fireEvent.click(screen.getByTestId('dc-robot-suction-up'))
    await vi.waitFor(() => expect(hub.vacuum.setFanSpeed).toHaveBeenCalledWith({ speed: 'Turbo' }))
  })

  it('locates through vacuum-control.locate', async () => {
    hub.vacuumSlice = VACUUM
    render(<ConnectedVacuumCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-robot-locate'))
    await vi.waitFor(() => expect(hub.vacuum.locate).toHaveBeenCalledWith({}))
  })

  it('arms Stop while cleaning, and hides it when stop is not implemented', async () => {
    hub.vacuumSlice = { ...VACUUM, state: 'cleaning' }
    render(<ConnectedVacuumCard deviceId={1} optimistic={false} />)
    const stop = screen.getByTestId('dc-robot-stop')
    fireEvent.click(stop)
    expect(hub.vacuum.stop).not.toHaveBeenCalled()
    fireEvent.click(stop)
    await vi.waitFor(() => expect(hub.vacuum.stop).toHaveBeenCalledWith({}))
    cleanup()
    hub.methods = {
      'vacuum-control': ['start', 'pause', 'returnToBase', 'locate', 'setFanSpeed'],
    }
    hub.vacuumSlice = { ...VACUUM, state: 'cleaning' }
    render(<ConnectedVacuumCard deviceId={1} />)
    expect(screen.queryByTestId('dc-robot-stop')).toBeNull()
  })

  it('hides locate when the vacuum does not implement it', () => {
    hub.methods = {
      'vacuum-control': ['start', 'pause', 'stop', 'returnToBase', 'setFanSpeed'],
    }
    hub.vacuumSlice = VACUUM
    render(<ConnectedVacuumCard deviceId={1} />)
    expect(screen.queryByTestId('dc-robot-locate')).toBeNull()
    expect(screen.getByTestId('dc-robot-dock')).toBeTruthy()
  })

  it('a refused clean lands on the reason line', async () => {
    hub.vacuumSlice = VACUUM
    hub.vacuum.start.mockRejectedValueOnce(new Error('bin missing'))
    render(<ConnectedVacuumCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-robot-go'))
    const reason = await screen.findByTestId('dc-reason')
    expect(reason.textContent).toBe('Command failed: bin missing')
  })
})

describe('a robot mower', () => {
  beforeEach(() => {
    hub.deviceType = DeviceType.LawnMower
    hub.switchOn = null
  })

  it('pauses while mowing, and docks through lawn-mower-control.dock', async () => {
    hub.mowerSlice = MOWER
    render(<ConnectedMowerCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-robot-go'))
    await vi.waitFor(() => expect(hub.mower.pause).toHaveBeenCalledWith({}))
    fireEvent.click(screen.getByTestId('dc-robot-dock'))
    await vi.waitFor(() => expect(hub.mower.dock).toHaveBeenCalledWith({}))
    expect(screen.queryByTestId('dc-robot-locate')).toBeNull()
  })

  it('hides a control the mower does not implement, and never a stop or a locate', () => {
    hub.methods = { 'lawn-mower-control': ['pause', 'dock'] }
    hub.mowerSlice = { ...MOWER, activity: 'docked' }
    render(<ConnectedMowerCard deviceId={1} />)
    expect(screen.queryByTestId('dc-robot-go')).toBeNull()
    expect(screen.queryByTestId('dc-robot-stop')).toBeNull()
    expect(screen.queryByTestId('dc-robot-locate')).toBeNull()
    expect(screen.getByTestId('dc-robot-dock')).toBeTruthy()
  })

  it('starts mowing through startMowing when docked', async () => {
    hub.mowerSlice = { ...MOWER, activity: 'docked' }
    render(<ConnectedMowerCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-robot-go'))
    await vi.waitFor(() => expect(hub.mower.startMowing).toHaveBeenCalledWith({}))
  })
})
