import { afterEach, describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { EspContainerDevice } from '../devices/esp-container-device.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { FakeLink, entity } from './fake-link.js'
import { makeCtx } from './fake-ctx.js'

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
})
