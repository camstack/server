// @vitest-environment jsdom
/**
 * The Wave-D scenes and their pure models: lock, alarm, humidifier, valve,
 * siren, pet feeder / fountain and weather. What each draws from a status,
 * which card a device type resolves to, the two-step confirmations, the code
 * pad, and every mockup fixture rendering through the shell.
 */
import { DeviceRole, DeviceType } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import { UnitPreferencesProvider } from '../../../contexts/unit-preferences'
import { alarmFixtures } from '../__fixtures__/alarm'
import { humidifierFixtures } from '../__fixtures__/humidifier'
import { lockFixtures } from '../__fixtures__/lock'
import { petFeederFixtures, petFountainFixtures } from '../__fixtures__/pet'
import { sirenFixtures } from '../__fixtures__/siren'
import { valveFixtures } from '../__fixtures__/valve'
import { weatherFixtures } from '../__fixtures__/weather'
import { alarmArmingPatch, alarmReadingOf } from '../connected/alarm-model'
import { capCardKindOf } from '../connected/cap-card-kinds'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { humidifierActivityOf } from '../connected/humidifier-model'
import { lockDoorOpen, lockReadingOf } from '../connected/lock-model'
import {
  petFaultOf,
  petFeedInput,
  petFeederActivityOf,
  petFountainActivityOf,
} from '../connected/pet-model'
import { AlarmCard } from '../scenes/alarm/AlarmCard'
import type { AlarmCardActions, AlarmCardModel } from '../scenes/alarm/model'
import { HumidifierCard } from '../scenes/humidifier/HumidifierCard'
import type { HumidifierCardModel } from '../scenes/humidifier/model'
import { LockCard } from '../scenes/lock/LockCard'
import type { LockCardActions, LockCardModel } from '../scenes/lock/model'
import { PetFeederCard } from '../scenes/pet/PetFeederCard'
import { PetFountainCard } from '../scenes/pet/PetFountainCard'
import { SirenCard } from '../scenes/siren/SirenCard'
import { ValveCard } from '../scenes/valve/ValveCard'
import { WeatherCard } from '../scenes/weather/WeatherCard'
import { compassOf, kmhOf, weatherSkyOf } from '../scenes/weather/model'

afterEach(cleanup)

const noop = (): void => undefined

function fixture<T extends { readonly id: string }>(list: readonly T[], id: string): T {
  const found = list.find((f) => f.id === id)
  if (found === undefined) throw new Error(`no fixture ${id}`)
  return found
}

interface LockSpies extends LockCardActions {
  readonly onLock: Mock<() => void>
  readonly onUnlock: Mock<() => void>
  readonly onOpen: Mock<() => void>
}
const lockActions = (): LockSpies => ({ onLock: vi.fn(), onUnlock: vi.fn(), onOpen: vi.fn() })

interface AlarmSpies extends AlarmCardActions {
  readonly onArm: Mock<AlarmCardActions['onArm']>
  readonly onDisarm: Mock<AlarmCardActions['onDisarm']>
}
const alarmActions = (): AlarmSpies => ({ onArm: vi.fn(), onDisarm: vi.fn() })

describe('card kind of a cap-named device type', () => {
  it('needs the type’s own cap', () => {
    expect(capCardKindOf(DeviceType.Lock, null, ['lock-control'])).toBe('lock')
    expect(capCardKindOf(DeviceType.Lock, null, ['switch'])).toBeNull()
    expect(capCardKindOf(DeviceType.AlarmPanel, null, ['alarm-panel'])).toBe('alarm')
    expect(capCardKindOf(DeviceType.Weather, null, ['weather'])).toBe('weather')
    expect(capCardKindOf(DeviceType.PetFountain, null, ['pet-fountain'])).toBe('pet-fountain')
  })

  it('draws a switch in the siren role as the siren, any other switch elsewhere', () => {
    expect(capCardKindOf(DeviceType.Switch, DeviceRole.Siren, ['switch'])).toBe('siren')
    expect(capCardKindOf(DeviceType.Switch, null, ['switch'])).toBeUndefined()
    expect(connectedCardKindOf(DeviceType.Siren, null, ['switch'])).toBe('siren')
  })

  it('leaves the other types to the rest of the resolver', () => {
    expect(capCardKindOf('not-a-type', null, [])).toBeUndefined()
    expect(capCardKindOf(DeviceType.Light, null, ['light'])).toBeUndefined()
  })
})

describe('the lock', () => {
  it('reads a lock reporting the door open as unlocked beside an open door', () => {
    expect(lockReadingOf({ state: 'door-open' })).toEqual({
      activity: 'unlocked',
      selfDoorOpen: true,
    })
    expect(lockReadingOf({ state: 'jammed' }).activity).toBe('jammed')
    expect(lockDoorOpen(null, false)).toBe(false)
    expect(lockDoorOpen({ name: 'Contatto', reading: 'open' }, false)).toBe(true)
    expect(lockDoorOpen({ name: 'Contatto', reading: 'closed' }, true)).toBe(true)
  })

  it('unlocks only on the second press', () => {
    const actions = lockActions()
    render(<LockCard model={fixture(lockFixtures(), 'lock-locked').model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-lock-unlock'))
    expect(actions.onUnlock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-lock-unlock'))
    expect(actions.onUnlock).toHaveBeenCalledTimes(1)
  })

  it('refuses to lock while the door is open', () => {
    const actions = lockActions()
    render(
      <LockCard model={fixture(lockFixtures(), 'lock-unlocked-open').model} actions={actions} />,
    )
    const lock = screen.getByTestId('dc-lock-lock')
    expect(lock.hasAttribute('disabled')).toBe(true)
    fireEvent.click(lock)
    expect(actions.onLock).not.toHaveBeenCalled()
  })

  it('turns a jammed lock’s scene red and offers a retry', () => {
    const actions = lockActions()
    const model: LockCardModel = {
      ...fixture(lockFixtures(), 'lock-jammed').model,
      doorOpen: false,
    }
    render(<LockCard model={model} actions={actions} />)
    expect(screen.getByTestId('dc-scene').getAttribute('data-alert')).toBe('true')
    fireEvent.click(screen.getByTestId('dc-lock-lock'))
    expect(actions.onLock).toHaveBeenCalledTimes(1)
  })

  it('offers no latch release the device does not declare', () => {
    const model: LockCardModel = { ...fixture(lockFixtures(), 'lock-locked').model, canOpen: false }
    render(<LockCard model={model} actions={lockActions()} />)
    expect(screen.queryByTestId('dc-lock-open')).toBeNull()
  })

  it('offers Open door, still two-step, while the lock is unlocked', () => {
    const actions = lockActions()
    const model: LockCardModel = {
      ...fixture(lockFixtures(), 'lock-locked').model,
      activity: 'unlocked',
    }
    render(<LockCard model={model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-lock-open'))
    expect(actions.onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-lock-open'))
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('the alarm', () => {
  it('reads the armed mode, and the mode an arming panel heads for', () => {
    expect(alarmReadingOf({ state: 'armed_away', targetMode: null })).toEqual({
      activity: 'armed',
      mode: 'away',
    })
    expect(alarmReadingOf({ state: 'arming', targetMode: 'night' })).toEqual({
      activity: 'arming',
      mode: 'night',
    })
    expect(alarmReadingOf({ state: 'disarmed', targetMode: null }).activity).toBe('disarmed')
    expect(alarmArmingPatch('home')).toEqual({ state: 'arming', targetMode: 'home' })
  })

  it('arms straight away without a code, but always confirms a disarm', () => {
    const disarmed = alarmActions()
    render(
      <AlarmCard model={fixture(alarmFixtures(), 'alarm-disarmed').model} actions={disarmed} />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Away' }))
    expect(disarmed.onArm).toHaveBeenCalledWith('away', null)
    cleanup()

    const armed = alarmActions()
    const model: AlarmCardModel = {
      ...fixture(alarmFixtures(), 'alarm-away').model,
      requiresCode: false,
    }
    render(<AlarmCard model={model} actions={armed} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Disarmed' }))
    expect(armed.onDisarm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-alarm-confirm'))
    expect(armed.onDisarm).toHaveBeenCalledWith(null)
  })

  it('asks a panel that wants a code for it, and sends it only with the command', () => {
    const actions = alarmActions()
    const model: AlarmCardModel = {
      ...fixture(alarmFixtures(), 'alarm-away').model,
      requiresCode: true,
    }
    render(<AlarmCard model={model} actions={actions} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Disarmed' }))
    expect(screen.getByTestId('dc-alarm-code')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dc-code-1'))
    fireEvent.click(screen.getByTestId('dc-code-2'))
    fireEvent.click(screen.getByTestId('dc-code-0'))
    fireEvent.click(screen.getByTestId('dc-code-submit'))
    expect(actions.onDisarm).toHaveBeenCalledWith('120')
    expect(screen.queryByTestId('dc-alarm-code')).toBeNull()
  })

  it('washes a triggered panel’s scene red', () => {
    render(
      <AlarmCard
        model={fixture(alarmFixtures(), 'alarm-triggered').model}
        actions={alarmActions()}
      />,
    )
    expect(screen.getByTestId('dc-scene').getAttribute('data-alert')).toBe('true')
  })
})

describe('the humidifier, valve and siren', () => {
  it('maps a humidifier’s action, and an off device is off, not broken', () => {
    expect(humidifierActivityOf({ on: false, action: 'humidifying' })).toBe('off')
    expect(humidifierActivityOf({ on: true, action: 'humidifying' })).toBe('humidify')
    expect(humidifierActivityOf({ on: true, action: 'drying' })).toBe('dry')
    expect(humidifierActivityOf({ on: true, action: null })).toBe('idle')
  })

  it('steps a humidifier target by one percent', () => {
    const onTarget = vi.fn()
    const model: HumidifierCardModel = fixture(humidifierFixtures(), 'humid-on').model
    render(<HumidifierCard model={model} actions={{ onPower: noop, onTarget, onMode: noop }} />)
    fireEvent.click(screen.getByTestId('dc-humid-target-up'))
    expect(onTarget).toHaveBeenCalledWith((model.targetHumidity ?? 0) + 1)
  })

  it('stops a moving valve', () => {
    const onStop = vi.fn()
    render(
      <ValveCard
        model={fixture(valveFixtures(), 'valve-moving').model}
        actions={{ onOpen: noop, onClose: noop, onStop, onPosition: noop }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-valve-stop'))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('sounds the siren only on the second press, and washes the scene red while it sounds', () => {
    const onSound = vi.fn()
    render(
      <SirenCard model={fixture(sirenFixtures(), 'siren-silent').model} actions={{ onSound }} />,
    )
    fireEvent.click(screen.getByTestId('dc-siren-sound'))
    expect(onSound).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-siren-sound'))
    expect(onSound).toHaveBeenCalledWith(true)
    cleanup()
    render(
      <SirenCard
        model={fixture(sirenFixtures(), 'siren-sounding').model}
        actions={{ onSound: noop }}
      />,
    )
    expect(screen.getByTestId('dc-scene').getAttribute('data-alert')).toBe('true')
  })

  it('offers Silence as well as Sound while the siren state is unknown', () => {
    const model = {
      ...fixture(sirenFixtures(), 'siren-silent').model,
      activity: 'unknown' as const,
    }
    render(<SirenCard model={model} actions={{ onSound: noop }} />)
    expect(screen.getByTestId('dc-siren-silence')).toBeTruthy()
    expect(screen.getByTestId('dc-siren-sound')).toBeTruthy()
  })
})

describe('the pet feeder and fountain', () => {
  it('reads a vendor’s no-fault sentinel as healthy', () => {
    expect(petFaultOf('no_error')).toBeNull()
    expect(petFaultOf('')).toBeNull()
    expect(petFaultOf('blocked')).toBe('blocked')
    expect(
      petFeederActivityOf({ error: 'no_error', feeding: false, eating: false, lowFood: true }),
    ).toBe('low')
    expect(
      petFeederActivityOf({ error: 'jam', feeding: true, eating: false, lowFood: false }),
    ).toBe('fault')
  })

  it('reads an unreported pump as unknown, never as stopped', () => {
    expect(petFountainActivityOf({ error: null, empty: null, pumpRunning: null })).toBe('unknown')
    expect(petFountainActivityOf({ error: null, empty: true, pumpRunning: true })).toBe('empty')
    expect(petFountainActivityOf({ error: null, empty: false, pumpRunning: false })).toBe('stopped')
  })

  it('names the hopper a dual feeder feeds from', () => {
    expect(petFeedInput(20, 'single')).toEqual({ grams: 20 })
    expect(petFeedInput(15, 'hopper2')).toEqual({ hopper2: 15 })
  })
})

describe('the weather', () => {
  it('formats temperature, wind and pressure in imperial preferences', () => {
    render(
      <UnitPreferencesProvider value={{ system: 'imperial', temperature: 'fahrenheit' }}>
        <WeatherCard model={fixture(weatherFixtures(), 'weather-sunny').model} />
      </UnitPreferencesProvider>,
    )
    expect(screen.getByTestId('dc-weather-temp').textContent).toContain('°F')
    expect(screen.getByTestId('dc-weather-wind').textContent).toContain('mph')
    expect(screen.getByTestId('dc-weather-pressure').textContent).toContain('inHg')
  })

  it('maps a condition to its sky, a bearing to the compass and m/s to km/h', () => {
    expect(weatherSkyOf('pouring')).toBe('rain')
    expect(weatherSkyOf('clear-night')).toBe('night')
    expect(weatherSkyOf('lightning-rainy')).toBe('storm')
    expect(compassOf(0)).toBe('N')
    expect(compassOf(225)).toBe('SW')
    expect(compassOf(-45)).toBe('NW')
    expect(kmhOf(10)).toBeCloseTo(36)
  })
})

describe('every Wave-D fixture renders through the shell', () => {
  it.each(lockFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(<LockCard model={f.model} actions={lockActions()} orientation={f.orientation} />)
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(alarmFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(<AlarmCard model={f.model} actions={alarmActions()} orientation={f.orientation} />)
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(humidifierFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(
      <HumidifierCard
        model={f.model}
        actions={{ onPower: noop, onTarget: noop, onMode: noop }}
        orientation={f.orientation}
      />,
    )
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(valveFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(
      <ValveCard
        model={f.model}
        actions={{ onOpen: noop, onClose: noop, onStop: noop, onPosition: noop }}
        orientation={f.orientation}
      />,
    )
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(sirenFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(<SirenCard model={f.model} actions={{ onSound: noop }} orientation={f.orientation} />)
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(petFeederFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(
      <PetFeederCard
        model={f.model}
        actions={{
          onFeed: noop,
          onCancelFeed: noop,
          onCallPet: noop,
          onMarkRefilled: noop,
          onChildLock: noop,
          onLight: noop,
          onFeedSound: noop,
          onVolume: noop,
        }}
        orientation={f.orientation}
      />,
    )
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(petFountainFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(
      <PetFountainCard
        model={f.model}
        actions={{ onPump: noop, onCycle: noop, onRunMinutes: noop, onRestMinutes: noop }}
        orientation={f.orientation}
      />,
    )
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
  it.each(weatherFixtures().map((f) => [f.id, f] as const))('%s', (_id, f) => {
    render(<WeatherCard model={f.model} actions={{}} orientation={f.orientation} />)
    expect(screen.getByTestId('dc-scene')).toBeTruthy()
  })
})
