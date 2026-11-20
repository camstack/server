import { afterEach, describe, expect, it } from 'vitest'
import { DeviceType, deviceStateRefreshCapability, type SwitchStatus } from '@camstack/types'
import { EspActuatorDevice } from '../devices/esp-actuator-device.js'
import { childConfigFor } from '../esphome-child-spec.js'
import { planBoard } from '../esphome-entity-spec.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { FakeLink, entity } from './fake-link.js'
import { makeCtx } from './fake-ctx.js'

const BROKER = 'esp_refresh_test'
const BOARD = [entity({ id: 'switch-relay', type: 'switch' })]

function relay() {
  const plan = planBoard(BOARD).find((p) => p.key === 'switch-relay')
  if (plan === undefined) throw new Error('no plan for the relay')
  const fake = makeCtx({ ...childConfigFor(plan, BROKER) }, { type: DeviceType.Switch })
  const device = new EspActuatorDevice(fake.ctx)
  const refresh = (): Promise<unknown> => {
    const provider = fake.providers.get(deviceStateRefreshCapability.name)
    if (typeof provider !== 'object' || provider === null || !('refresh' in provider)) {
      return Promise.reject(new Error('no refresh provider registered'))
    }
    const call: unknown = provider.refresh
    if (typeof call !== 'function') return Promise.reject(new Error('refresh is not a function'))
    return Promise.resolve(call({ deviceIds: [7], reason: 'command' }))
  }
  return {
    device,
    refresh,
    options: fake.capOptions.get(deviceStateRefreshCapability.name),
    on: () => device.runtimeState.getCapState<SwitchStatus>('switch')?.on,
  }
}

afterEach(() => espLinkHub.clear())

describe('ESPHome device-state-refresh (D1062)', () => {
  it('declares push full for the board, so the core never schedules a read', () => {
    espLinkHub.attach(BROKER, new FakeLink(BOARD))
    expect(relay().options).toMatchObject({
      stateRefresh: { integrationId: BROKER, push: 'full', batch: false },
    })
  })

  it("a refresh re-applies the board's last reported state to the slice", async () => {
    const link = new FakeLink(BOARD, [{ type: 'switch', id: 'switch-relay', state: false }])
    espLinkHub.attach(BROKER, link)
    const dev = relay()
    expect(dev.on()).toBe(false)
    await dev.device.removeDevice() // stop the live subscription: only the refresh can move the slice
    link.push({ type: 'switch', id: 'switch-relay', state: true })
    expect(dev.on()).toBe(false)
    await dev.refresh()
    expect(dev.on()).toBe(true)
  })

  it('a refresh with no board session fails, never a silent success', async () => {
    espLinkHub.attach(BROKER, new FakeLink(BOARD))
    const dev = relay()
    espLinkHub.detach(BROKER)
    await expect(dev.refresh()).rejects.toThrow(/not connected/)
  })
})
