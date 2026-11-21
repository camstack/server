// @vitest-environment jsdom
import { type ClimateAction, type ClimateControlStatus, DeviceRole } from '@camstack/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIMATE_FIXTURES } from '../__fixtures__/climate'
import { type ClimateCommands, climateModelOf } from '../connected/climate-model'
import { ClimateCard } from '../scenes/climate/ClimateCard'
import {
  type ClimateCardActions,
  type ClimateCardModel,
  climateGauge,
} from '../scenes/climate/model'

afterEach(cleanup)

const NONE: ClimateCommands = {
  targetRange: false,
  fanMode: false,
  preset: false,
  swingVertical: false,
  swingHorizontal: false,
}

function status(patch: Partial<ClimateControlStatus>): ClimateControlStatus {
  return {
    mode: 'heat',
    availableModes: ['off', 'heat', 'cool'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: 21,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: 19,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: 16,
    maxTemp: 30,
    tempStep: 0.5,
    lastFetchedAt: 0,
    ...patch,
  }
}

function modelOf(patch: Partial<ClimateControlStatus>): Omit<ClimateCardModel, 'common'> {
  const model = climateModelOf({
    role: DeviceRole.ClimateThermostat,
    climate: status(patch),
    valve: undefined,
    commands: NONE,
    modeLabel: (m) => m,
  })
  if (model === null) throw new Error('no climate model')
  return model
}

const first = CLIMATE_FIXTURES[0]?.model
if (first === undefined) throw new Error('no climate fixture')
const base: ClimateCardModel = first

function cardOf(
  action: ClimateAction | null,
  patch: Partial<Pick<ClimateCardModel, 'activity' | 'current' | 'target'>> = {},
): ClimateCardModel {
  return {
    ...base,
    on: action !== 'off',
    activity: 'unknown',
    action,
    current: 19,
    target: { value: 21, min: 16, max: 30, step: 0.5, label: null },
    ...patch,
  }
}

const noop = (): void => undefined
const actions: ClimateCardActions = {
  onPower: noop,
  onTarget: noop,
  onRange: noop,
  onMode: noop,
  onFan: noop,
  onSwing: noop,
  onSwingHorizontal: noop,
  onPreset: noop,
  onHeatCool: noop,
}

describe('climate activity comes from the device action, never from target vs room', () => {
  it('carries the action through to the model', () => {
    expect(modelOf({ action: 'heating' }).action).toBe('heating')
    expect(modelOf({}).action).toBeNull()
  })

  it('heating reads heat even when the room is already above the target', () => {
    expect(modelOf({ action: 'heating', currentTemp: 23 }).activity).toBe('heat')
  })

  it('idle stays idle with the room under the target: no waiting is derived from the gap', () => {
    expect(modelOf({ action: 'idle', currentTemp: 15 }).activity).toBe('idle')
  })

  it('a device that does not say its action is unknown, however far the room is from the target', () => {
    expect(modelOf({ currentTemp: 15 }).activity).toBe('unknown')
    expect(modelOf({ action: null, currentTemp: 30 }).activity).toBe('unknown')
  })

  it('cooling and off follow the action; mode off is off', () => {
    expect(modelOf({ action: 'cooling' }).activity).toBe('cool')
    expect(modelOf({ mode: 'off', action: 'off' }).activity).toBe('off')
    expect(modelOf({ mode: 'off' }).activity).toBe('off')
  })

  it('a held band follows the action too, not the room against the band', () => {
    const band = { mode: 'heat_cool' as const, target: null, targetLow: 19, targetHigh: 24 }
    expect(modelOf({ ...band, currentTemp: 15 }).activity).toBe('unknown')
    expect(modelOf({ ...band, currentTemp: 15, action: 'idle' }).activity).toBe('idle')
  })
})

describe('climateGauge — the marker and the band', () => {
  it('draws the filled band between room and target only while heating or cooling', () => {
    expect(climateGauge(cardOf('heating'))?.band).toEqual({ from: 19, to: 21 })
    expect(climateGauge(cardOf('cooling', { current: 24 }))?.band).toEqual({ from: 24, to: 21 })
    for (const action of ['idle', 'off', 'drying', 'fan', null] as const) {
      expect(climateGauge(cardOf(action))?.band).toBeNull()
    }
  })

  it('puts the hollow marker at the room temperature whatever the action', () => {
    for (const action of ['heating', 'idle', 'off', null] as const) {
      expect(climateGauge(cardOf(action))?.marker).toBe(19)
    }
  })

  it('has neither marker nor band without a room reading', () => {
    expect(climateGauge(cardOf('heating', { current: null }))).toBeNull()
  })

  it('has no gauge on a band dial or without a target', () => {
    expect(climateGauge(cardOf('heating', { target: null }))).toBeNull()
  })
})

describe('ClimateCard — the dial', () => {
  it('shows the target big in the centre and "Current" under it', () => {
    render(<ClimateCard model={cardOf('heating')} actions={actions} />)
    expect(screen.getByTestId('dc-climate-centre-target').textContent).toBe('21°')
    expect(screen.getByTestId('dc-climate-current').textContent).toBe('Current 19°')
  })

  it('honours the Precision set on the device, zeros kept', () => {
    const model = cardOf('heating')
    render(
      <ClimateCard
        model={{ ...model, common: { ...model.common, precision: 1 } }}
        actions={actions}
      />,
    )
    expect(screen.getByTestId('dc-climate-centre-target').textContent).toBe('21.0°')
    expect(screen.getByTestId('dc-climate-current').textContent).toBe('Current 19.0°')
  })

  it('draws the band only for heating and cooling, the marker always', () => {
    render(<ClimateCard model={cardOf('heating')} actions={actions} />)
    expect(screen.queryByTestId('dc-dial-band')).not.toBeNull()
    expect(screen.queryByTestId('dc-dial-marker')).not.toBeNull()
    cleanup()
    render(<ClimateCard model={cardOf('idle')} actions={actions} />)
    expect(screen.queryByTestId('dc-dial-band')).toBeNull()
    expect(screen.queryByTestId('dc-dial-marker')).not.toBeNull()
  })

  it('names the activity from the action, and says nothing when the device does not say', () => {
    render(<ClimateCard model={cardOf('heating', { activity: 'heat' })} actions={actions} />)
    expect(screen.getByTestId('dc-state').textContent).toContain('Heating')
    cleanup()
    render(<ClimateCard model={cardOf(null)} actions={actions} />)
    const text = screen.getByTestId('dc-state').textContent ?? ''
    expect(text).not.toMatch(/Heating|Cooling|Idle|On|Off/)
  })
})
