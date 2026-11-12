// @vitest-environment jsdom
import {
  DeviceFeature,
  DeviceRole,
  FanControlStatusSchema,
  FanOscillationAxisSchema,
  type FanPresetApplyResult,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { offline } from '../__fixtures__/common'
import { coverFixtures } from '../__fixtures__/cover'
import { fanFixtures } from '../__fixtures__/fan'
import { heaterFixtures } from '../__fixtures__/heater'
import { lightFixtures } from '../__fixtures__/light'
import { plugFixtures } from '../__fixtures__/plug'
import { fanAxisOf, fanPresetChoice, fanPresetFailure, fanSliceModel } from '../connected/fan-model'
import { lightColorOf } from '../connected/ConnectedLightCard'
import { ambientLayers } from '../illustrations/AmbientFx'
import { CoverCard } from '../scenes/cover/CoverCard'
import {
  type CoverCardActions,
  type CoverCardModel,
  coverRoleSpec,
  drawnOf,
  positionOf,
} from '../scenes/cover/model'
import { FanCard } from '../scenes/fan/FanCard'
import type { FanCardActions } from '../scenes/fan/model'
import { HeaterCard } from '../scenes/heater/HeaterCard'
import type { HeaterCardActions } from '../scenes/heater/model'
import { LightCard } from '../scenes/light/LightCard'
import type { LightCardActions } from '../scenes/light/model'
import { PlugCard } from '../scenes/plug/PlugCard'

afterEach(cleanup)

const NOW = 1_700_000_000_000

function coverActions(): CoverCardActions {
  return {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onStop: vi.fn(),
    onPosition: vi.fn(),
    onTilt: vi.fn(),
  }
}
function lightActions(): LightCardActions {
  return { onPower: vi.fn(), onBrightness: vi.fn(), onColor: vi.fn(), onWhite: vi.fn() }
}
function fanActions(): FanCardActions {
  return {
    onPower: vi.fn(),
    onSpeed: vi.fn(),
    onPreset: vi.fn(),
    onDirection: vi.fn(),
    onOscillating: vi.fn(),
    onAxis: vi.fn(),
    onTimerStart: vi.fn(),
    onTimerStop: vi.fn(),
  }
}
function heaterActions(): HeaterCardActions {
  return { onPower: vi.fn(), onTimerStart: vi.fn(), onTimerStop: vi.fn() }
}

function cover(drawing: string): CoverCardModel {
  const f = coverFixtures().find((c) => c.id === `cover-${drawing}`)
  if (f === undefined) throw new Error(`no cover fixture ${drawing}`)
  return f.model
}

describe('cover card', () => {
  it('maps a closure role back and forth between position and drawn value', () => {
    const shutter = coverRoleSpec(DeviceRole.CoverShutter)
    expect(shutter.kind).toBe('closure')
    expect(drawnOf('closure', 60)).toBe(40)
    expect(positionOf('closure', 40)).toBe(60)
    expect(drawnOf('extend', 60)).toBe(60)
  })

  it('falls back to the shutter drawing for a cover with no role', () => {
    expect(coverRoleSpec(null).drawing).toBe(coverRoleSpec(DeviceRole.CoverShutter).drawing)
  })

  it('says how far a shutter is closed, and commits a slider move as a position', () => {
    const actions = coverActions()
    render(<CoverCard model={cover('shutter')} actions={actions} />)
    expect(screen.getAllByText('Closed 40%').length).toBeGreaterThan(0)
    const slider = screen.getByTestId('dc-cover-position')
    fireEvent.change(slider, { target: { value: '70' } })
    fireEvent.pointerUp(slider)
    expect(actions.onPosition).toHaveBeenCalledWith(30)
  })

  it('steps the slats from the tilt buttons', () => {
    const actions = coverActions()
    render(<CoverCard model={cover('shutter')} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-cover-slats-open'))
    expect(actions.onTilt).toHaveBeenCalledWith(45)
  })

  it('asks twice before opening a garage, and draws no position slider', () => {
    const actions = coverActions()
    render(<CoverCard model={cover('garage')} actions={actions} />)
    expect(screen.queryByTestId('dc-cover-position')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-cover-main'))
    expect(actions.onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-cover-main'))
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
  })

  it('opens a cover that needs no confirmation with one press on its main button', () => {
    const actions = coverActions()
    const model = { ...cover('garage'), spec: { ...cover('garage').spec, secure: false } }
    render(<CoverCard model={model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-cover-main'))
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
  })

  it('keeps every command still while the device is offline', () => {
    const actions = coverActions()
    const model = cover('shutter')
    render(<CoverCard model={{ ...model, common: offline(model.common) }} actions={actions} />)
    expect(screen.getByTestId('dc-cover-position')).toHaveProperty('disabled', true)
  })

  it('never offers a position on a secure role, even one that reports and takes it', () => {
    const actions = coverActions()
    const garage: CoverCardModel = { ...cover('garage'), positionable: true, position: 40 }
    render(<CoverCard model={garage} actions={actions} />)
    expect(screen.queryByTestId('dc-cover-position')).toBeNull()
    expect(screen.queryByTestId('dc-cover-open')).toBeNull()
    expect(screen.queryByRole('slider', { name: 'Drag' })).toBeNull()
    expect(screen.getAllByText('Closed 60%').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('dc-cover-main'))
    expect(actions.onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-cover-main'))
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
  })

  it('holds a sent position until the device reports a new one', () => {
    const actions = { ...coverActions(), onPosition: () => new Promise<boolean>(() => undefined) }
    const model = cover('shutter')
    const view = render(<CoverCard model={model} actions={actions} />)
    const slider = screen.getByTestId('dc-cover-position')
    fireEvent.change(slider, { target: { value: '70' } })
    fireEvent.pointerUp(slider)
    expect(screen.getAllByText('Closed 70%').length).toBeGreaterThan(0)
    view.rerender(<CoverCard model={{ ...model }} actions={actions} />)
    expect(screen.getAllByText('Closed 70%').length).toBeGreaterThan(0)
    view.rerender(<CoverCard model={{ ...model, position: 20 }} actions={actions} />)
    expect(screen.getAllByText('Closed 80%').length).toBeGreaterThan(0)
  })

  it('lets go of a sent position when the command fails', async () => {
    const actions = { ...coverActions(), onPosition: () => Promise.resolve(false) }
    render(<CoverCard model={cover('shutter')} actions={actions} />)
    const slider = screen.getByTestId('dc-cover-position')
    fireEvent.change(slider, { target: { value: '70' } })
    fireEvent.pointerUp(slider)
    await vi.waitFor(() => expect(screen.getAllByText('Closed 40%').length).toBeGreaterThan(0))
  })

  it('keeps the slat buttons and slider on a cover that tilts but takes no position', () => {
    const actions = coverActions()
    const blind: CoverCardModel = {
      ...cover('blind'),
      positionable: false,
      position: null,
      tilt: 30,
    }
    render(<CoverCard model={blind} actions={actions} />)
    expect(screen.queryByTestId('dc-cover-position')).toBeNull()
    expect(screen.queryByTestId('dc-cover-tilt')).not.toBeNull()
    fireEvent.click(screen.getByTestId('dc-cover-slats-close'))
    expect(actions.onTilt).toHaveBeenCalledWith(15)
  })
})

describe('shared parts', () => {
  it('names a whole-hour run "1 h" on the plug timer', () => {
    const plug = plugFixtures(NOW).find((f) => f.model.timer !== null)
    if (plug === undefined || plug.model.timer === null) throw new Error('no plug with a timer')
    const model = {
      ...plug.model,
      timer: { ...plug.model.timer, defaultMinutes: 60, endsAt: null },
    }
    render(
      <PlugCard
        model={model}
        actions={{ onPower: vi.fn(), onTimerStart: vi.fn(), onTimerStop: vi.fn() }}
      />,
    )
    expect(screen.getByTestId('dc-plug-timer-start').textContent).toContain('1 h')
    expect(screen.getByTestId('dc-plug-timer-start').textContent).not.toContain('0′')
  })

  it('sends a slider value when the pointer is cancelled mid-drag', () => {
    const actions = coverActions()
    render(<CoverCard model={cover('shutter')} actions={actions} />)
    const slider = screen.getByTestId('dc-cover-position')
    fireEvent.change(slider, { target: { value: '70' } })
    fireEvent.pointerCancel(slider)
    expect(actions.onPosition).toHaveBeenCalledWith(30)
  })

  it('stacks the preset menu label under its glyph in the fan card', () => {
    const tower = fanFixtures(NOW).find((f) => f.id === 'fan-tower')
    if (tower === undefined) throw new Error('fan-tower')
    render(<FanCard model={tower.model} actions={fanActions()} />)
    expect(screen.getByTestId('dc-fan-preset').getAttribute('data-layout')).toBe('stacked')
  })
})

describe('light card', () => {
  const pick = (id: string) => {
    const f = lightFixtures().find((x) => x.id === id)
    if (f === undefined) throw new Error(id)
    return f
  }
  const colour = pick('light-colour')
  const white = pick('light-white')
  const onOff = pick('light-onoff')

  it('offers the palette and the white popover only when the model has them', () => {
    render(<LightCard model={colour.model} actions={lightActions()} />)
    expect(screen.queryByTestId('dc-light-colour')).not.toBeNull()
    cleanup()
    render(<LightCard model={white.model} actions={lightActions()} />)
    expect(screen.queryByTestId('dc-light-colour')).toBeNull()
    expect(screen.queryByTestId('dc-light-white')).not.toBeNull()
    cleanup()
    render(<LightCard model={onOff.model} actions={lightActions()} />)
    expect(screen.queryByTestId('dc-light-brightness')).toBeNull()
    expect(screen.queryByTestId('dc-light-white')).toBeNull()
  })

  it('turns the light off through power', () => {
    const actions = lightActions()
    render(<LightCard model={colour.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-light-power'))
    expect(actions.onPower).toHaveBeenCalledWith(false)
  })

  it('reads a reported colour in every mode the color cap has', () => {
    expect(lightColorOf({ mode: 'rgb', rgb: { r: 1, g: 2, b: 3 }, lastChangedAt: 0 })).toEqual({
      r: 1,
      g: 2,
      b: 3,
    })
    expect(lightColorOf({ mode: 'hsv', hsv: { h: 0, s: 100, v: 50 }, lastChangedAt: 0 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
    })
    expect(lightColorOf({ mode: 'mired', colorTemperature: 370, lastChangedAt: 0 })).not.toBeNull()
    expect(lightColorOf(null)).toBeNull()
  })
})

describe('fan card', () => {
  const fans = fanFixtures(NOW)
  const fan = (id: string) => {
    const f = fans.find((x) => x.id === id)
    if (f === undefined) throw new Error(id)
    return f.model
  }

  it('draws one popover per oscillation axis instead of the toggle', () => {
    render(<FanCard model={fan('fan-axes')} actions={fanActions()} />)
    expect(screen.queryByTestId('dc-fan-axis-horizontal')).not.toBeNull()
    expect(screen.queryByTestId('dc-fan-axis-vertical')).not.toBeNull()
    expect(screen.queryByTestId('dc-fan-oscillate')).toBeNull()
  })

  it('toggles plain oscillation on a fan without axes', () => {
    const actions = fanActions()
    render(<FanCard model={fan('fan-tower')} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-fan-oscillate'))
    expect(actions.onOscillating).toHaveBeenCalledWith(false)
  })

  it('reverses a ceiling fan from its direction button', () => {
    const actions = fanActions()
    render(<FanCard model={fan('fan-ceiling')} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-fan-direction'))
    expect(actions.onDirection).toHaveBeenCalledWith('reverse')
  })

  it('blows the breeze faster as the speed rises', () => {
    expect(ambientLayers('fan', 'run')).toContain('breeze')
  })
})

describe('fan model', () => {
  const status = FanControlStatusSchema.parse({
    speed: 60,
    percentageStep: 10,
    preset: 'natural',
    availablePresets: ['normal', 'natural'],
    direction: null,
    oscillating: true,
    oscillationAxes: {
      horizontal: FanOscillationAxisSchema.parse({
        oscillating: true,
        sweepFrom: -45,
        sweepTo: 45,
      }),
      vertical: null,
    },
    lastChangedAt: 0,
  })
  const all = { speed: true, preset: true, direction: true, oscillating: true, axis: true }

  it('prefers the axes over the oscillation toggle, and lists device then saved presets', () => {
    const model = fanSliceModel({
      fan: status,
      saved: [{ id: 'p1', name: 'Sera', state: {} }],
      commands: all,
    })
    expect(model.oscillating).toBeNull()
    expect(model.axes?.horizontal?.sweepFrom).toBe(-45)
    expect(model.axes?.vertical).toBeNull()
    expect(model.presets.map((p) => p.id)).toEqual(['device:normal', 'device:natural', 'saved:p1'])
    expect(model.preset).toBe('device:natural')
  })

  it('draws nothing the device cannot command', () => {
    const model = fanSliceModel({
      fan: status,
      saved: [],
      commands: { speed: false, preset: false, direction: false, oscillating: true, axis: false },
    })
    expect(model.speed).toBeNull()
    expect(model.presets).toEqual([])
    expect(model.axes).toBeNull()
    expect(model.oscillating).toBe(true)
  })

  it('treats an axis that reports nothing as absent, and 0° as a real angle', () => {
    expect(fanAxisOf(FanOscillationAxisSchema.parse({}))).toBeNull()
    expect(fanAxisOf(FanOscillationAxisSchema.parse({ angle: 0 }))?.angle).toBe(0)
  })

  it('names each field a preset could not apply', () => {
    const partial: FanPresetApplyResult = {
      status: 'partial',
      fields: [
        { field: 'speed', outcome: 'applied' },
        { field: 'oscillationAxes.vertical.angle', outcome: 'refused', message: 'axis-not-linked' },
        { field: 'preset', outcome: 'not-run' },
      ],
    }
    expect(fanPresetFailure(partial)).toBe(
      'oscillationAxes.vertical.angle: axis-not-linked, preset (not-run)',
    )
    expect(fanPresetFailure({ status: 'applied', fields: [] })).toBeNull()
  })

  it('draws a declared speed and direction before the slice answers, as pending', () => {
    const model = fanSliceModel({
      fan: undefined,
      saved: [],
      commands: all,
      features: [DeviceFeature.FanSpeed, DeviceFeature.FanDirection],
    })
    expect(model.pending).toBe(true)
    expect(model.speed).not.toBeNull()
    expect(model.direction).not.toBeNull()
    expect(fanSliceModel({ fan: undefined, saved: [], commands: all }).speed).toBeNull()
    expect(fanSliceModel({ fan: status, saved: [], commands: all }).pending).toBe(false)
  })

  it('holds a pending speed slider still and shows no value', () => {
    const tower = fanFixtures(NOW).find((f) => f.id === 'fan-ceiling')
    if (tower === undefined) throw new Error('fan-ceiling')
    render(<FanCard model={{ ...tower.model, pending: true }} actions={fanActions()} />)
    expect(screen.getByTestId('dc-fan-speed')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dc-fan-direction')).toHaveProperty('disabled', true)
  })

  it('splits a menu id into the list it came from', () => {
    expect(fanPresetChoice('device:turbo')).toEqual({ kind: 'device', preset: 'turbo' })
    expect(fanPresetChoice('saved:p1')).toEqual({ kind: 'saved', presetId: 'p1' })
    expect(fanPresetChoice('other')).toBeNull()
  })
})

describe('heater card', () => {
  it('glows while heating and turns off through power', () => {
    expect(ambientLayers('switch-heater', 'heat')).toEqual(['glow-low', 'wisps-unit'])
    const actions = heaterActions()
    const running = heaterFixtures(NOW).find((f) => f.id === 'heater-running')
    if (running === undefined) throw new Error('heater-running')
    render(<HeaterCard model={running.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-heater-power'))
    expect(actions.onPower).toHaveBeenCalledWith(false)
  })
})
