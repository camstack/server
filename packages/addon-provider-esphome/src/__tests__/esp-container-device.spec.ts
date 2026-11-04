import { afterEach, describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { EspContainerDevice } from '../devices/esp-container-device.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { type LogLine, makeCtx } from './fake-ctx.js'
import { FakeLink, entity } from './fake-link.js'

const BROKER = 'esp_container_test'

const BOARD = [
  entity({ id: 'switch-relay', type: 'switch', name: 'Relay' }),
  entity({ id: 'sensor-power', type: 'sensor', name: 'Power', deviceClass: 'power', unit: 'W' }),
  entity({
    id: 'sensor-voltage',
    type: 'sensor',
    name: 'Voltage',
    deviceClass: 'voltage',
    unit: 'V',
  }),
  entity({
    id: 'sensor-temp',
    type: 'sensor',
    name: 'Temp',
    deviceClass: 'temperature',
    unit: '°C',
  }),
  entity({ id: 'binary_sensor-door', type: 'binary_sensor', name: 'Door', deviceClass: 'door' }),
  entity({ id: 'sensor-uptime', type: 'sensor', name: 'Uptime', category: 'diagnostic' }),
]

function container(): EspContainerDevice {
  const { ctx } = makeCtx({ brokerId: BROKER, system: 'esphome', integrationId: 'int-1' })
  return new EspContainerDevice(ctx)
}

afterEach(() => espLinkHub.clear())

describe('EspContainerDevice', () => {
  it('derives one child per mapped entity, folding the power sensors into one meter', () => {
    espLinkHub.attach(BROKER, new FakeLink(BOARD))
    const specs = container().getAccessoryChildren()

    expect(specs.map((s) => s.stableIdSuffix)).toEqual([
      'switch-relay',
      'power-meter',
      'sensor-temp',
      'binary_sensor-door',
    ])
    const meter = specs.find((s) => s.stableIdSuffix === 'power-meter')
    expect(meter?.config).toMatchObject({
      brokerId: BROKER,
      kind: 'power-meter',
      slots: { power: 'sensor-power', voltage: 'sensor-voltage' },
      slotUnits: { power: 'W', voltage: 'V' },
    })
    const relay = specs.find((s) => s.stableIdSuffix === 'switch-relay')
    expect(relay?.meta).toMatchObject({
      type: DeviceType.Switch,
      name: 'Relay',
      integrationId: 'int-1',
    })
    expect(relay?.meta.linkDeviceId).toBe(7)
  })

  it('spawns nothing and does not stamp the probe while the board is unreachable', async () => {
    const dev = container()
    expect(dev.getAccessoryChildren()).toEqual([])
    await dev.onProbe()
    const slice = dev.runtimeState.getCapState<{ lastProbedAt?: number }>('feature-probe')
    expect(slice?.lastProbedAt ?? 0).toBe(0)
  })

  it('stamps the probe once the board is reachable', async () => {
    espLinkHub.attach(BROKER, new FakeLink(BOARD))
    const dev = container()
    await dev.onProbe()
    const slice = dev.runtimeState.getCapState<{ lastProbedAt?: number }>('feature-probe')
    expect(slice?.lastProbedAt ?? 0).toBeGreaterThan(0)
  })

  it('does not start a second child reconcile while the kernel is still registering the board', async () => {
    espLinkHub.attach(BROKER, new FakeLink(BOARD))
    const dev = container()
    let running = 0
    let maxRunning = 0
    const calls: string[] = []
    dev._kernelReprobe = async () => {
      calls.push('reprobe')
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setTimeout(resolve, 15))
      running -= 1
    }
    // The kernel's own register() reconcile is in flight (it does not go through
    // the device). A connect in that window must not start another one.
    running = 1
    dev.onBoardConnected()
    expect(calls).toEqual([])
    running = 0
    await dev.onActivate()
    expect(calls).toEqual(['reprobe'])
    expect(maxRunning).toBe(1)
  })

  it('serialises a connect that arrives while the deferred reconcile is still registering children', async () => {
    espLinkHub.attach(BROKER, new FakeLink(BOARD))
    const dev = container()
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let running = 0
    let maxRunning = 0
    let reprobes = 0
    dev._kernelReprobe = async () => {
      reprobes += 1
      running += 1
      maxRunning = Math.max(maxRunning, running)
      if (reprobes === 1) await firstHeld
      running -= 1
    }
    dev.onBoardConnected()
    const activating = dev.onActivate()
    await new Promise((resolve) => setTimeout(resolve, 5))
    dev.onBoardConnected()
    expect(maxRunning).toBe(1)
    releaseFirst()
    await activating
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(reprobes).toBe(2)
    expect(maxRunning).toBe(1)
  })

  it('registers a repeated entity once', () => {
    const logs: LogLine[] = []
    const { ctx } = makeCtx({ brokerId: BROKER, system: 'esphome' }, { logs })
    espLinkHub.attach(
      BROKER,
      new FakeLink([
        entity({ id: 'button-menu', type: 'button', name: 'Menu' }),
        entity({ id: 'button-menu', type: 'button', name: 'Menu again' }),
        entity({ id: 'switch-relay', type: 'switch', name: 'Relay' }),
      ]),
    )
    const dev = new EspContainerDevice(ctx)
    expect(dev.getAccessoryChildren().map((s) => s.stableIdSuffix)).toEqual([
      'button-menu',
      'switch-relay',
    ])
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('repeated'))).toBe(true)
  })
})
