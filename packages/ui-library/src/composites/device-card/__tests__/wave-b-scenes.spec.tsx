// @vitest-environment jsdom
import {
  DeviceFeature,
  DeviceType,
  type DishwasherStatus,
  type MediaPlayerStatus,
  type VacuumControlStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { applianceFixtures, withStartBlocked } from '../__fixtures__/appliance'
import { offline } from '../__fixtures__/common'
import { mediaFixtures } from '../__fixtures__/media'
import { robotFixtures } from '../__fixtures__/robot'
import {
  dishwasherPhase,
  dishwasherPrograms,
  dishwasherStartBlocked,
  plugAppliancePhase,
  programDisplayLabel,
  programNamesFromOptions,
} from '../connected/appliance-model'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import {
  mediaArtworkOf,
  mediaPhaseOf,
  mediaSeekOf,
  mediaTransportOf,
  mediaVolumeOf,
} from '../connected/media-model'
import { mowerActivityOf, vacuumActivityOf } from '../connected/robot-model'
import { ApplianceCard } from '../scenes/appliance/ApplianceCard'
import { type ApplianceCardActions, formatCycleMinutes } from '../scenes/appliance/model'
import { MediaPlayerCard } from '../scenes/media/MediaPlayerCard'
import { DEFAULT_VOLUME_BOUNDS, type MediaCardActions } from '../scenes/media/model'
import { RobotCard } from '../scenes/robot/RobotCard'
import type { RobotCardActions } from '../scenes/robot/model'
import { remoteKeyOf, remotePadRows } from '../shell/remote-keys'

afterEach(cleanup)

function applianceActions(): ApplianceCardActions {
  return {
    onPower: vi.fn(),
    onProgram: vi.fn(),
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
  }
}

function mediaActions(): MediaCardActions {
  return {
    onPower: vi.fn(),
    onVolumeUp: vi.fn(),
    onVolumeDown: vi.fn(),
    onVolume: vi.fn(),
    onMute: vi.fn(),
    onSource: vi.fn(),
    onSeek: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onShuffle: vi.fn(),
    onRepeat: vi.fn(),
  }
}

function robotActions(): RobotCardActions {
  return {
    onStart: vi.fn(),
    onPause: vi.fn(),
    onDock: vi.fn(),
    onStop: vi.fn(),
    onLocate: vi.fn(),
    onSuction: vi.fn(),
  }
}

const fixture = <T extends { readonly id: string }>(list: readonly T[], id: string): T => {
  const found = list.find((f) => f.id === id)
  if (found === undefined) throw new Error(`no fixture ${id}`)
  return found
}

describe('the appliance scene', () => {
  it('a plug-fed washer draws power only: no program, no start', () => {
    const f = fixture(applianceFixtures('washer'), 'washer-plug-run')
    render(<ApplianceCard model={f.model} actions={applianceActions()} />)
    expect(screen.getByTestId('dc-appliance-power')).toBeTruthy()
    expect(screen.queryByTestId('dc-appliance-program')).toBeNull()
    expect(screen.queryByTestId('dc-appliance-start')).toBeNull()
    expect(screen.getByText('Washing')).toBeTruthy()
  })

  it('cutting a running cycle arms first; a stopped one turns off at once', () => {
    const actions = applianceActions()
    const run = fixture(applianceFixtures('washer'), 'washer-plug-run')
    render(<ApplianceCard model={run.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-appliance-power'))
    expect(actions.onPower).not.toHaveBeenCalled()
    expect(screen.getByTestId('dc-appliance-power').textContent).toBe('Confirm: interrupts')
    fireEvent.click(screen.getByTestId('dc-appliance-power'))
    expect(actions.onPower).toHaveBeenCalledWith(false)
    cleanup()
    const done = fixture(applianceFixtures('washer'), 'washer-plug-done')
    const later = applianceActions()
    render(<ApplianceCard model={done.model} actions={later} />)
    fireEvent.click(screen.getByTestId('dc-appliance-power'))
    expect(later.onPower).toHaveBeenCalledWith(false)
  })

  it('a long program label stays inside the program column', () => {
    const idle = fixture(applianceFixtures('dish'), 'dish-idle')
    const long = 'Dishcare.Dishwasher.Program.SuperExtraIntensiveSanitiseWithPrewash'
    render(
      <ApplianceCard
        model={{
          ...idle.model,
          program: {
            options: [{ id: long, label: long, minutes: null }],
            selected: long,
            selectable: false,
          },
        }}
        actions={applianceActions()}
      />,
    )
    const value = screen.getByTestId('dc-appliance-program-value')
    expect(value.className).toContain('break-words')
    expect(value.closest('[data-zone="left"]')?.className).toContain('overflow-x-clip')
    expect(screen.getByTestId('dc-appliance-start').className).toContain('break-words')
  })

  it('an idle connected dishwasher steps programs and names the program it starts', () => {
    const actions = applianceActions()
    const idle = fixture(applianceFixtures('dish'), 'dish-idle')
    render(<ApplianceCard model={idle.model} actions={actions} />)
    const start = screen.getByTestId('dc-appliance-start')
    expect(start.textContent).toMatch(/^Start /)
    fireEvent.click(start)
    expect(actions.onStart).toHaveBeenCalled()
    expect(screen.getByTestId('dc-appliance-program-value').textContent).not.toBe('')
  })

  it('a blocked start is disabled and says why', () => {
    const idle = withStartBlocked(fixture(applianceFixtures('dish'), 'dish-idle'), 'Door open')
    render(<ApplianceCard model={idle.model} actions={applianceActions()} />)
    expect(screen.getByTestId('dc-appliance-start')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dc-appliance-why').textContent).toBe('Door open')
  })

  it('a running cycle locks the program choice and shows the time left', () => {
    const run = fixture(applianceFixtures('dish'), 'dish-run')
    render(<ApplianceCard model={run.model} actions={applianceActions()} />)
    expect(screen.getByTestId('dc-appliance-program-up')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dc-appliance-program-down')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dc-appliance-program').textContent).toContain('left')
    expect(screen.getByTestId('dc-appliance-pause')).toBeTruthy()
  })

  it('offline disables every control without a reason line', () => {
    const idle = fixture(applianceFixtures('dish'), 'dish-idle')
    render(
      <ApplianceCard
        model={{ ...idle.model, common: offline(idle.model.common) }}
        actions={applianceActions()}
      />,
    )
    expect(screen.getByTestId('dc-appliance-start')).toHaveProperty('disabled', true)
    expect(screen.queryByTestId('dc-reason')).toBeNull()
  })

  it('formats a cycle in hours and minutes', () => {
    expect(formatCycleMinutes(155)).toBe('2 h 35')
    expect(formatCycleMinutes(38)).toBe('38 min')
  })
})

describe('the media scene', () => {
  it('a player whose state is assumed draws play, pause and stop, never a toggle', () => {
    const amp = fixture(mediaFixtures(), 'media-amp')
    render(<MediaPlayerCard model={amp.model} actions={mediaActions()} />)
    expect(screen.queryByTestId('dc-media-play')).toBeNull()
    expect(screen.getByTestId('dc-media-transport').querySelectorAll('button').length).toBe(3)
  })

  it('the play toggle pauses a playing speaker', () => {
    const actions = mediaActions()
    const speaker = fixture(mediaFixtures(), 'media-speaker')
    render(<MediaPlayerCard model={speaker.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-media-play'))
    expect(actions.onPause).toHaveBeenCalled()
  })

  it('shuffle and repeat are in the remote sheet, not on the scene', () => {
    const actions = mediaActions()
    const speaker = fixture(mediaFixtures(), 'media-speaker')
    render(<MediaPlayerCard model={speaker.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-remote'))
    expect(screen.queryByTestId('dc-media-shuffle')).toBeNull()
    cleanup()
    render(
      <MediaPlayerCard
        model={{ ...speaker.model, playback: { shuffle: false, repeat: 'all' } }}
        actions={actions}
      />,
    )
    expect(screen.queryByTestId('dc-media-shuffle')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-remote'))
    fireEvent.click(screen.getByTestId('dc-media-shuffle'))
    expect(actions.onShuffle).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByTestId('dc-media-repeat'))
    expect(actions.onRepeat).toHaveBeenCalledWith('one')
  })

  it('a known volume is a slider that commits the level on release', () => {
    const actions = mediaActions()
    const speaker = fixture(mediaFixtures(), 'media-speaker')
    render(
      <MediaPlayerCard
        model={{
          ...speaker.model,
          volume: { level: 32, muted: false, mutable: false, bounds: { min: 0, max: 40, step: 2 } },
        }}
        actions={actions}
      />,
    )
    const slider = screen.getByTestId('dc-media-volume')
    expect(slider.getAttribute('max')).toBe('40')
    expect(slider.getAttribute('step')).toBe('2')
    expect(screen.queryByTestId('dc-media-volume-up')).toBeNull()
    fireEvent.change(slider, { target: { value: '20' } })
    expect(actions.onVolume).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    expect(actions.onVolume).toHaveBeenCalledWith(20)
  })

  it('a muted speaker says so on the mute key, and on the step column when the level is unknown', () => {
    const speaker = fixture(mediaFixtures(), 'media-speaker')
    render(
      <MediaPlayerCard
        model={{
          ...speaker.model,
          volume: { level: null, muted: true, mutable: true, bounds: null },
        }}
        actions={mediaActions()}
      />,
    )
    expect(screen.getByTestId('dc-media-volume').textContent).toContain('muted')
    expect(screen.getByTestId('dc-media-mute').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the robot scene', () => {
  it('a cleaning vacuum arms Stop before it ends the task', () => {
    const actions = robotActions()
    const clean = fixture(robotFixtures(), 'vacuum-clean')
    render(
      <RobotCard
        model={{ ...clean.model, controls: { ...clean.model.controls, stop: true } }}
        actions={actions}
      />,
    )
    const stop = screen.getByTestId('dc-robot-stop')
    fireEvent.click(stop)
    expect(actions.onStop).not.toHaveBeenCalled()
    fireEvent.click(stop)
    expect(actions.onStop).toHaveBeenCalledOnce()
  })

  it('a cleaning vacuum offers Pause; a docked one disables Base', () => {
    const actions = robotActions()
    const clean = fixture(robotFixtures(), 'vacuum-clean')
    render(<RobotCard model={clean.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-robot-go'))
    expect(actions.onPause).toHaveBeenCalled()
    cleanup()
    const docked = fixture(robotFixtures(), 'vacuum-docked')
    render(<RobotCard model={docked.model} actions={robotActions()} />)
    expect(screen.getByTestId('dc-robot-dock')).toHaveProperty('disabled', true)
  })

  it('a mower draws its progress and no locate or suction', () => {
    const mowing = fixture(robotFixtures(), 'mower-mowing')
    render(<RobotCard model={mowing.model} actions={robotActions()} />)
    expect(screen.getByTestId('dc-robot-progress')).toBeTruthy()
    expect(screen.queryByTestId('dc-robot-locate')).toBeNull()
    expect(screen.queryByTestId('dc-robot-suction')).toBeNull()
  })

  it('a vacuum in error names it', () => {
    const err = fixture(robotFixtures(), 'vacuum-error')
    render(<RobotCard model={err.model} actions={robotActions()} />)
    expect(screen.getByTestId('dc-robot-error').textContent).not.toBe('')
  })

  it('the map toggle appears only when the device has a map', () => {
    const clean = fixture(robotFixtures(), 'vacuum-clean')
    render(<RobotCard model={clean.model} actions={robotActions()} />)
    expect(screen.queryByTestId('dc-robot-map-toggle')).toBeNull()
    cleanup()
    render(
      <RobotCard
        model={{ ...clean.model, mapUrl: 'https://example.com/map.png' }}
        actions={robotActions()}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-robot-map-toggle'))
    expect(screen.getByTestId('dc-robot-map')).toBeTruthy()
  })
})

describe('the remote pad', () => {
  const t = defaultUiText
  it('a device with arrows gets a d-pad, power first, volume pairs after', () => {
    const keys = ['volume_up', 'up', 'power', 'ok', 'down', 'left', 'right', 'volume_down'].map(
      (role) => remoteKeyOf(role, undefined, t),
    )
    const rows = remotePadRows(keys)
    expect(rows?.map((r) => r.kind)).toEqual(['row', 'dpad', 'pairs'])
    expect(rows?.[1]?.keys.map((k) => k.id)).toEqual(['up', 'left', 'ok', 'right', 'down'])
  })

  it('a device without arrows keeps a flat row', () => {
    expect(remotePadRows([remoteKeyOf('power', undefined, t)])).toBeNull()
  })

  it('a declared label wins; an unknown role is drawn by its name', () => {
    expect(remoteKeyOf('home', 'Casa', t).label).toBe('Casa')
    expect(remoteKeyOf('netflix', undefined, t).label).toBe('netflix')
  })
})

const DISH_BASE = {
  availability: 'available',
  state: 'idle',
  operationState: null,
  program: null,
  selectedProgram: 'Eco',
  availablePrograms: ['Eco', 'Quick'],
  remaining: null,
  delayedStart: null,
  progress: null,
  doorOpen: false,
  doorLocked: null,
  remoteStartAllowed: true,
  remoteControlActive: null,
  localControlActive: null,
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
} as const satisfies DishwasherStatus

describe('appliance model', () => {
  it('a plug phase never claims idle without a reading', () => {
    expect(plugAppliancePhase(undefined, true)).toBe('unknown')
    expect(plugAppliancePhase(null, true)).toBe('unknown')
    expect(plugAppliancePhase(true, true)).toBe('run')
    expect(plugAppliancePhase(false, true)).toBe('done')
    expect(plugAppliancePhase(true, false)).toBe('off')
  })

  it('a dishwasher that is powered off and idle is off', () => {
    expect(dishwasherPhase({ ...DISH_BASE, powerOn: false })).toBe('off')
    expect(dishwasherPhase({ ...DISH_BASE, state: 'running' })).toBe('run')
  })

  it('the start is refused for an open door before remote start', () => {
    expect(dishwasherStartBlocked({ ...DISH_BASE, doorOpen: true }, defaultUiText)).toBe(
      'Door open',
    )
    expect(dishwasherStartBlocked(DISH_BASE, defaultUiText)).toBeNull()
  })

  it('programs keep the selected one even when the list is empty', () => {
    expect(
      dishwasherPrograms({ ...DISH_BASE, availablePrograms: [] }, true)?.options.map((p) => p.id),
    ).toEqual(['Eco'])
  })

  it('shows the cap display label, and a short name when the cap gives none', () => {
    const key = 'Dishcare.Dishwasher.Program.Eco50'
    const quick = 'Dishcare.Dishwasher.Program.Quick65'
    expect(programDisplayLabel(key, 'Eco 50°')).toBe('Eco 50°')
    expect(programDisplayLabel(key, 'Eco50')).toBe('Eco 50°')
    expect(programDisplayLabel(key, null)).toBe('Eco 50°')
    expect(programDisplayLabel('MachineCare')).toBe('Machine Care')
    expect(programDisplayLabel('Auto2')).toBe('Auto 2')
    expect(programDisplayLabel('Eco 50')).toBe('Eco 50')
    const named = dishwasherPrograms(
      { ...DISH_BASE, selectedProgram: key, availablePrograms: [key, quick] },
      true,
      [{ key, name: 'Economy wash' }],
    )
    expect(named?.options.map((p) => [p.id, p.label])).toEqual([
      [key, 'Economy wash'],
      [quick, 'Quick 65°'],
    ])
    expect(programNamesFromOptions({ programs: [{ key, name: 'Eco 50°' }, { key: 1 }] })).toEqual([
      { key, name: 'Eco 50°' },
    ])
    expect(programNamesFromOptions(null)).toEqual([])
  })
})

const MEDIA_BASE = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 40,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: 10_000,
  duration: 60_000,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: 1_000,
  lastChangedAt: 0,
} as const satisfies MediaPlayerStatus

describe('media model', () => {
  it('maps standby to off and buffering to playing', () => {
    expect(mediaPhaseOf({ ...MEDIA_BASE, state: 'standby' })).toBe('off')
    expect(mediaPhaseOf({ ...MEDIA_BASE, state: 'buffering' })).toBe('playing')
  })

  it('volume only when declared; a known level with setVolume uses the declared scale', () => {
    expect(mediaVolumeOf(MEDIA_BASE, [])).toBeNull()
    const reported = mediaVolumeOf(MEDIA_BASE, [DeviceFeature.MediaPlayerVolume])
    expect(reported?.level).toBe(40)
    expect(reported?.bounds).toBeNull()
    expect(
      mediaVolumeOf(MEDIA_BASE, [DeviceFeature.MediaPlayerVolume], { absolute: true })?.bounds,
    ).toEqual(DEFAULT_VOLUME_BOUNDS)
    const declared = { min: 0, max: 10, step: 2 }
    expect(
      mediaVolumeOf(MEDIA_BASE, [DeviceFeature.MediaPlayerVolume], {
        absolute: true,
        bounds: declared,
      })?.bounds,
    ).toEqual(declared)
    expect(
      mediaVolumeOf({ ...MEDIA_BASE, volumeLevel: null }, [DeviceFeature.MediaPlayerVolume], {
        absolute: true,
      })?.bounds,
    ).toBeNull()
    expect(mediaVolumeOf(MEDIA_BASE, [DeviceFeature.MediaPlayerVolumeStep])?.level).toBeNull()
  })

  it('the position advances while playing, from when it was reported', () => {
    expect(mediaSeekOf(MEDIA_BASE, [DeviceFeature.MediaPlayerSeek], 6_000)?.positionSec).toBe(15)
    expect(mediaSeekOf(MEDIA_BASE, [], 6_000)).toBeNull()
  })

  it('an assumed state is blind', () => {
    expect(mediaTransportOf({ ...MEDIA_BASE, stateSource: 'assumed' }, []).blind).toBe(true)
    expect(mediaTransportOf(MEDIA_BASE, []).blind).toBe(false)
  })

  it('artwork: tv for a source with nothing known, blank for nothing at all', () => {
    expect(mediaArtworkOf({ ...MEDIA_BASE, source: 'HDMI 1' })).toBe('tv')
    expect(mediaArtworkOf(MEDIA_BASE)).toBe('blank')
    expect(mediaArtworkOf({ ...MEDIA_BASE, currentMedia: { type: 'music', title: 'x' } })).toBe(
      'music',
    )
  })
})

describe('robot model', () => {
  const v = (over: Partial<VacuumControlStatus>): VacuumControlStatus => ({
    state: 'docked',
    batteryLevel: 100,
    fanSpeed: null,
    availableFanSpeeds: [],
    progress: null,
    errorCode: null,
    errorLabel: null,
    lastChangedAt: 0,
    ...over,
  })
  it('a docked robot charges until full', () => {
    expect(vacuumActivityOf(v({ batteryLevel: 60 }))).toBe('charge')
    expect(vacuumActivityOf(v({ batteryLevel: 100 }))).toBe('sleep')
    expect(vacuumActivityOf(v({ state: 'returning' }))).toBe('ret')
    expect(
      mowerActivityOf({
        activity: 'mowing',
        batteryLevel: 50,
        progress: null,
        currentCode: null,
        currentCodeLabel: null,
        severity: 'info',
        lastChangedAt: 0,
      }),
    ).toBe('clean')
  })
})

describe('connectedCardKindOf — Wave B', () => {
  it('a washer fed by a switch or a running reading is the appliance card', () => {
    expect(connectedCardKindOf(DeviceType.Washer, null, ['switch'])).toBe('appliance')
    expect(connectedCardKindOf(DeviceType.Dryer, null, ['running-state'])).toBe('appliance')
    expect(connectedCardKindOf(DeviceType.Washer, null, ['power-meter'])).toBeNull()
  })

  it('a dishwasher with its own cap is the dishwasher card, else the appliance one', () => {
    expect(connectedCardKindOf(DeviceType.Dishwasher, null, ['dishwasher'])).toBe('dishwasher')
    expect(connectedCardKindOf(DeviceType.Dishwasher, null, ['switch'])).toBe('appliance')
  })

  it('media, vacuum and mower need their control cap', () => {
    expect(connectedCardKindOf(DeviceType.MediaPlayer, null, ['media-player'])).toBe('media')
    expect(connectedCardKindOf(DeviceType.MediaPlayer, null, ['remote'])).toBeNull()
    expect(connectedCardKindOf(DeviceType.Vacuum, null, ['vacuum-control'])).toBe('vacuum')
    expect(connectedCardKindOf(DeviceType.LawnMower, null, ['lawn-mower-control'])).toBe('mower')
  })
})
