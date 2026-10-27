import { afterEach, describe, expect, it } from 'vitest'
import {
  DeviceType,
  type NumericSensorStatus,
  type PowerMeterStatus,
  type SwitchStatus,
} from '@camstack/types'
import { EspActuatorDevice } from '../devices/esp-actuator-device.js'
import { EspSensorDevice } from '../devices/esp-sensor-device.js'
import { childConfigFor } from '../esphome-child-spec.js'
import { planBoard } from '../esphome-entity-spec.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { FakeLink, entity } from './fake-link.js'
import { makeCtx } from './fake-ctx.js'

const BROKER = 'esp_children_test'

const BOARD = [
  entity({ id: 'switch-relay', type: 'switch' }),
  entity({ id: 'sensor-temp', type: 'sensor', deviceClass: 'temperature', unit: '°C' }),
  entity({ id: 'sensor-power', type: 'sensor', deviceClass: 'power', unit: 'W' }),
  entity({ id: 'sensor-voltage', type: 'sensor', deviceClass: 'voltage', unit: 'V' }),
]

function configOf(key: string): Record<string, unknown> {
  const plan = planBoard(BOARD).find((p) => p.key === key)
  if (plan === undefined) throw new Error(`no plan for ${key}`)
  return { ...childConfigFor(plan, BROKER) }
}

function sensor(key: string): EspSensorDevice {
  return new EspSensorDevice(makeCtx(configOf(key), { type: DeviceType.Sensor }).ctx)
}

afterEach(() => espLinkHub.clear())

describe('EspSensorDevice', () => {
  it('shows the reading, and a dropped board keeps it instead of reading zero', () => {
    const link = new FakeLink(BOARD)
    espLinkHub.attach(BROKER, link)
    const dev = sensor('sensor-temp')

    link.push({ type: 'sensor', id: 'sensor-temp', state: 21.5 })
    expect(dev.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(21.5)

    link.drop(null)
    espLinkHub.detach(BROKER)
    expect(dev.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(21.5)
  })

  it('treats a missing state as unknown, never as zero', () => {
    const link = new FakeLink(BOARD)
    espLinkHub.attach(BROKER, link)
    const dev = sensor('sensor-temp')

    link.push({ type: 'sensor', id: 'sensor-temp', state: 0, missingState: true })
    expect(dev.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBeNull()
  })

  it('replays the last known state when it is built after the board connected', () => {
    const link = new FakeLink(BOARD, [{ type: 'sensor', id: 'sensor-temp', state: 18 }])
    espLinkHub.attach(BROKER, link)
    const dev = sensor('sensor-temp')
    expect(dev.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(18)
  })

  it('feeds each power-meter field from its own sensor', () => {
    const link = new FakeLink(BOARD)
    espLinkHub.attach(BROKER, link)
    const dev = sensor('power-meter')

    link.push({ type: 'sensor', id: 'sensor-power', state: 230 })
    link.push({ type: 'sensor', id: 'sensor-voltage', state: 229.5 })
    const status = dev.runtimeState.getCapState<PowerMeterStatus>('power-meter')
    expect(status?.watts).toBe(230)
    expect(status?.volts).toBe(229.5)
  })
})

describe('EspActuatorDevice', () => {
  function relay(): { dev: EspActuatorDevice; providers: Map<string, unknown> } {
    const { ctx, providers } = makeCtx(configOf('switch-relay'), { type: DeviceType.Switch })
    return { dev: new EspActuatorDevice(ctx), providers }
  }

  interface SwitchProvider {
    setState(input: { on: boolean }): Promise<unknown>
  }
  function isSwitchProvider(value: unknown): value is SwitchProvider {
    return typeof value === 'object' && value !== null && 'setState' in value
  }
  function switchProvider(providers: Map<string, unknown>): SwitchProvider {
    const provider = providers.get('switch')
    if (!isSwitchProvider(provider)) throw new Error('switch provider not registered')
    return provider
  }

  it('sends the command to the board', async () => {
    const link = new FakeLink(BOARD)
    espLinkHub.attach(BROKER, link)
    const { providers } = relay()
    await switchProvider(providers).setState({ on: true })
    expect(link.commands).toEqual([{ type: 'switch', id: 'switch-relay', state: true }])
  })

  it('refuses by name while the board is unreachable', async () => {
    const { providers } = relay()
    await expect(switchProvider(providers).setState({ on: true })).rejects.toThrow(/not connected/)
  })

  it('follows the board state', () => {
    const link = new FakeLink(BOARD)
    espLinkHub.attach(BROKER, link)
    const { dev } = relay()
    link.push({ type: 'switch', id: 'switch-relay', state: true })
    expect(dev.runtimeState.getCapState<SwitchStatus>('switch')?.on).toBe(true)
  })
})
