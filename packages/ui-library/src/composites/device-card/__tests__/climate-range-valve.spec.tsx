// @vitest-environment jsdom
import { type ClimateControlStatus, DeviceRole, DeviceType } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIMATE_FIXTURES } from '../__fixtures__/climate'
import { type ClimateCommands, climateModelOf, climateRangeOf } from '../connected/climate-model'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { reachabilityOf } from '../connected/use-card-common'
import { moveRangeHandle, nearestRangeHandle } from '../parts/RangeDial'
import { ClimateCard } from '../scenes/climate/ClimateCard'
import type { ClimateCardActions, ClimateCardModel } from '../scenes/climate/model'

afterEach(cleanup)

const ALL: ClimateCommands = {
  targetRange: true,
  fanMode: true,
  preset: true,
  swingVertical: true,
  swingHorizontal: true,
}

function status(patch: Partial<ClimateControlStatus>): ClimateControlStatus {
  return {
    mode: 'heat',
    availableModes: ['off', 'heat', 'cool', 'heat_cool'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: 21,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: 20,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: 5,
    maxTemp: 35,
    tempStep: 1,
    lastFetchedAt: 0,
    ...patch,
  }
}

const modeLabel = (mode: string): string => mode

function actions(): ClimateCardActions {
  return {
    onPower: vi.fn(),
    onTarget: vi.fn(),
    onRange: vi.fn(),
    onMode: vi.fn(),
    onFan: vi.fn(),
    onSwing: vi.fn(),
    onSwingHorizontal: vi.fn(),
    onPreset: vi.fn(),
    onHeatCool: vi.fn(),
  }
}

function firstFixture(): ClimateCardModel {
  const fixture = CLIMATE_FIXTURES[0]
  if (fixture === undefined) throw new Error('no climate fixture')
  return fixture.model
}
const base = { model: firstFixture() }

function modelOf(
  climate: ClimateControlStatus | undefined,
  valve?: number | null,
): ClimateCardModel {
  const scene = climateModelOf({
    role: DeviceRole.ClimateThermostat,
    climate,
    valve: valve === undefined ? undefined : { position: valve, lastFetchedAt: 0 },
    commands: ALL,
    modeLabel,
  })
  if (scene === null) throw new Error('no climate model')
  return { common: base.model.common, ...scene }
}

const present = (id: string): boolean => screen.queryByTestId(id) !== null

describe('a held band (heat_cool) — two setpoints on one dial', () => {
  const band = status({
    mode: 'heat_cool',
    target: null,
    targetLow: 19,
    targetHigh: 24,
  })

  it('is a band in heat_cool mode, and whenever both ends are reported', () => {
    expect(climateRangeOf(band, true)).toEqual({
      low: 19,
      high: 24,
      min: 5,
      max: 35,
      step: 1,
      editable: true,
    })
    expect(
      climateRangeOf(status({ mode: 'heat', targetLow: 18, targetHigh: 22 }), true),
    ).not.toBeNull()
    expect(climateRangeOf(status({ mode: 'heat' }), true)).toBeNull()
    // One end alone is not a band: the single setpoint stays in charge.
    expect(climateRangeOf(status({ mode: 'heat_cool', targetLow: 19 }), true)).toBeNull()
  })

  it('takes the dial from the single setpoint, even when the device reports no target', () => {
    const model = modelOf(band)
    expect(model.range?.low).toBe(19)
    expect(model.range?.high).toBe(24)
    expect(model.target).toBeNull()
    // In the band: idle. Under it: heating. Over it: cooling.
    expect(model.activity).toBe('idle')
    expect(modelOf({ ...band, currentTemp: 17 }).activity).toBe('heat')
    expect(modelOf({ ...band, currentTemp: 26 }).activity).toBe('cool')
  })

  it('draws exactly two handles, the band, and no single-setpoint stepper', () => {
    render(<ClimateCard model={modelOf(band)} actions={actions()} />)
    expect(present('dc-range-dial')).toBe(true)
    expect(present('dc-range-dial-low')).toBe(true)
    expect(present('dc-range-dial-high')).toBe(true)
    expect(present('dc-dial')).toBe(false)
    expect(present('dc-climate-target')).toBe(false)
    expect(screen.queryByLabelText('Raise the target')).toBeNull()
    expect(screen.getByTestId('dc-climate-range').textContent).toBe('19–24°range')
  })

  it('draws exactly one handle for a single setpoint', () => {
    render(<ClimateCard model={modelOf(status({}))} actions={actions()} />)
    expect(present('dc-dial')).toBe(true)
    expect(present('dc-range-dial')).toBe(false)
    expect(present('dc-climate-range')).toBe(false)
  })

  it('sends the whole band when a handle moves', () => {
    const acts = actions()
    render(<ClimateCard model={modelOf(band)} actions={acts} />)
    fireEvent.keyDown(screen.getByTestId('dc-range-dial-low'), {
      key: 'ArrowUp',
    })
    expect(acts.onRange).toHaveBeenLastCalledWith(20, 24)
    fireEvent.keyDown(screen.getByTestId('dc-range-dial-high'), {
      key: 'ArrowDown',
    })
    expect(acts.onRange).toHaveBeenLastCalledWith(19, 23)
  })

  it('clamps the low handle to the high one, and the high to the low', () => {
    const acts = actions()
    const tight = status({
      mode: 'heat_cool',
      target: null,
      targetLow: 22,
      targetHigh: 22,
    })
    render(<ClimateCard model={modelOf(tight)} actions={acts} />)
    fireEvent.keyDown(screen.getByTestId('dc-range-dial-low'), {
      key: 'ArrowUp',
    })
    expect(acts.onRange).toHaveBeenLastCalledWith(22, 22)
    fireEvent.keyDown(screen.getByTestId('dc-range-dial-high'), {
      key: 'ArrowDown',
    })
    expect(acts.onRange).toHaveBeenLastCalledWith(22, 22)
    expect(moveRangeHandle({ low: 19, high: 24 }, 'low', 30)).toEqual({
      low: 24,
      high: 24,
    })
    expect(moveRangeHandle({ low: 19, high: 24 }, 'high', 10)).toEqual({
      low: 19,
      high: 19,
    })
  })

  it('a drag takes the nearer handle', () => {
    expect(nearestRangeHandle(18, { low: 19, high: 24 })).toBe('low')
    expect(nearestRangeHandle(23, { low: 19, high: 24 })).toBe('high')
    expect(nearestRangeHandle(26, { low: 22, high: 22 })).toBe('high')
    expect(nearestRangeHandle(20, { low: 22, high: 22 })).toBe('low')
  })

  it('shows the band without handles when the device cannot set it', () => {
    const scene = climateModelOf({
      role: DeviceRole.ClimateThermostat,
      climate: band,
      valve: undefined,
      commands: { ...ALL, targetRange: false },
      modeLabel,
    })
    if (scene === null) throw new Error('no climate model')
    render(<ClimateCard model={{ common: base.model.common, ...scene }} actions={actions()} />)
    expect(present('dc-climate-range')).toBe(true)
    expect(present('dc-range-dial-low')).toBe(false)
  })

  it('draws no empty dial when there is neither a setpoint nor a band', () => {
    render(<ClimateCard model={modelOf(status({ target: null }))} actions={actions()} />)
    expect(present('dc-dial')).toBe(false)
    expect(present('dc-range-dial')).toBe(false)
    expect(present('dc-climate-target')).toBe(false)
    expect(present('dc-climate-dial')).toBe(true)
  })
})

describe('a radiator valve — its opening is always shown', () => {
  it('is a climate card for a device that binds only heating-valve', () => {
    expect(
      connectedCardKindOf(DeviceType.Climate, DeviceRole.ClimateRadiator, ['heating-valve']),
    ).toBe('climate')
    expect(
      connectedCardKindOf(DeviceType.Climate, DeviceRole.ClimateRadiator, ['battery']),
    ).toBeNull()
  })

  it('a valve-only device has a model: no power, no setpoint, the opening', () => {
    const model = modelOf(undefined, 40)
    expect(model.canPower).toBe(false)
    expect(model.target).toBeNull()
    expect(model.mode).toBeNull()
    expect(model.valve).toEqual({ position: 40 })
    expect(model.role).toBe('radiator')
    expect(model.activity).toBe('heat')
    expect(modelOf(undefined, 0).activity).toBe('idle')
    expect(modelOf(undefined, null).activity).toBe('unknown')
  })

  it('a device that declares neither capability has no climate card', () => {
    expect(
      climateModelOf({
        role: DeviceRole.ClimateThermostat,
        climate: undefined,
        valve: undefined,
        commands: ALL,
        modeLabel,
      }),
    ).toBeNull()
  })

  it('a valve-only card is not blank: the opening is its number, and nothing commands', () => {
    render(<ClimateCard model={modelOf(undefined, 40)} actions={actions()} />)
    expect(screen.getByTestId('dc-climate-valve').textContent).toBe('40%')
    expect(present('dc-climate-power')).toBe(false)
    expect(present('dc-dial')).toBe(false)
    expect(present('dc-climate-mode')).toBe(false)
    // No appliance is drawn, so no animation floats around the number.
    expect(document.querySelector('[data-fx]')).toBeNull()
  })

  it('a valve that has not reported shows a dash, not zero', () => {
    render(<ClimateCard model={modelOf(undefined, null)} actions={actions()} />)
    expect(screen.getByTestId('dc-climate-valve').textContent).toBe('—')
  })

  it('a thermostat with a valve shows the opening next to its controls', () => {
    render(<ClimateCard model={modelOf(status({}), 65)} actions={actions()} />)
    expect(screen.getByTestId('dc-climate-valve').textContent).toBe('Valve 65%')
    expect(present('dc-dial')).toBe(true)
    expect(present('dc-climate-power')).toBe(true)
  })

  it('a thermostat without a valve shows none', () => {
    render(<ClimateCard model={modelOf(status({}))} actions={actions()} />)
    expect(present('dc-climate-valve')).toBe(false)
  })
})

describe('horizontal swing — drawn only when the device can set it', () => {
  const swinging = status({
    mode: 'cool',
    swingVertical: true,
    swingHorizontal: false,
  })

  it('is its own toggle next to the vertical one', () => {
    const acts = actions()
    render(<ClimateCard model={modelOf(swinging)} actions={acts} />)
    fireEvent.click(screen.getByTestId('dc-climate-swing-horizontal'))
    expect(acts.onSwingHorizontal).toHaveBeenCalledWith(true)
    expect(acts.onSwing).not.toHaveBeenCalled()
  })

  it('is absent without the command or without the reading', () => {
    const without = climateModelOf({
      role: DeviceRole.ClimateAc,
      climate: swinging,
      valve: undefined,
      commands: { ...ALL, swingHorizontal: false },
      modeLabel,
    })
    expect(without?.swingHorizontal).toBeNull()
    expect(modelOf(status({ mode: 'cool' })).swingHorizontal).toBeNull()
  })
})

describe('reachability and failed commands', () => {
  it('an unanswered device-status is unknown, never online', () => {
    expect(reachabilityOf(undefined)).toBeNull()
    expect(reachabilityOf({ online: true })).toBe(true)
    expect(reachabilityOf({ online: false })).toBe(false)
  })

  it('unknown reachability is said, and is not drawn as online', () => {
    const model = modelOf(status({}))
    render(
      <ClimateCard
        model={{ ...model, common: { ...model.common, online: null } }}
        actions={actions()}
      />,
    )
    expect(present('dc-reach-unknown')).toBe(true)
    expect(present('dc-reach-online')).toBe(false)
  })

  it('a failed command puts its reason on the reason line', () => {
    const model = modelOf(status({}))
    render(
      <ClimateCard
        model={{
          ...model,
          common: { ...model.common, notice: 'Command failed: timeout' },
        }}
        actions={actions()}
      />,
    )
    expect(screen.getByTestId('dc-reason').textContent).toBe('Command failed: timeout')
  })
})
